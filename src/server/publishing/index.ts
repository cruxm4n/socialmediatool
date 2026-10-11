import "server-only";

import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { credentialFingerprint, decryptCredential } from "@/server/credentials";
import { BUFFER_WRITES_DISABLED, bufferModeProblem, env, simulatedBufferAllowed } from "@/server/env";
import { BufferProvider } from "@/server/publishing/buffer-provider";
import { MockProvider } from "@/server/publishing/mock-provider";
import type { PublishingProvider } from "@/server/publishing/provider";
import { ConnectionRouter, type ConnectionRow, type ConnectionState, type DurableConnectionState } from "@/server/publishing/router";

/*
 * Point d'entrée unique vers le fournisseur de publication.
 *
 * Depuis la migration 0012, chaque canal dépend d'une CONNEXION (un compte Buffer, réel ou simulé) : le routeur
 * envoie chaque opération au compte du canal concerné. Il n'existe pas de clé globale utilisée par défaut : la clé
 * du serveur (BUFFER_API_KEY) ne sert qu'à la connexion qui la déclare explicitement (« environment », le compte
 * historique). Voir docs/CONNEXIONS_FOURNISSEUR.md.
 */

/** Un fournisseur réel par connexion, par secret et par identité de compte : remplacer la clé crée un nouveau client. */
const realProviders = new Map<string, BufferProvider>();

function realProvider(connectionId: string, apiKey: string, accountId: string | null): BufferProvider {
  const key = `${connectionId}:${credentialFingerprint(apiKey)}:${accountId ?? ""}`;
  let provider = realProviders.get(key);
  if (!provider) {
    // L'ancien client de cette connexion (clé remplacée) n'est plus conservé.
    for (const existing of realProviders.keys()) if (existing.startsWith(`${connectionId}:`)) realProviders.delete(existing);
    provider = new BufferProvider(apiKey, env.reviewTags, fetch, accountId);
    realProviders.set(key, provider);
  }
  return provider;
}

/** Fournisseur d'UNE connexion. Lève une erreur si son secret manque ou ne se déchiffre pas (jamais de repli). */
export function buildConnectionProvider(row: ConnectionRow): PublishingProvider {
  if (row.credentialSource === "none") {
    // Compte simulé : celui de démonstration, ou un compte isolé propre à la connexion. Jamais sans autorisation.
    if (!simulatedBufferAllowed()) throw new Error("le Buffer simulé n'est pas autorisé sur ce serveur");
    return row.isDefault || !row.accountKey ? new MockProvider(env.mockRunId) : new MockProvider(env.mockRunId, row.accountKey);
  }
  if (row.credentialSource === "environment") return realProvider(row.id, env.bufferApiKey, row.externalAccountId ?? null);
  if (!row.ciphertext) throw new Error("aucun secret enregistré pour cette connexion");
  return realProvider(row.id, decryptCredential(row.id, row.ciphertext, row.keyVersion), row.externalAccountId ?? null);
}

/**
 * Fournisseur actif : un routeur de connexions, pour le mode du serveur.
 * `scheduled` : passage du planificateur ; il respecte l'espacement des lectures d'un compte au quota presque épuisé.
 */
export function getProvider(options: { scheduled?: boolean } = {}): PublishingProvider {
  const mode = env.bufferMode;
  return new ConnectionRouter({
    mode,
    // Configuration de production invalide : rien ne part, et surtout aucun simulateur ne prend la place.
    blocked: bufferModeProblem(),
    // Barrière d'activation : sans elle, le vrai Buffer est lu mais jamais modifié.
    writesDisabled: env.bufferWritesEnabled ? null : BUFFER_WRITES_DISABLED,
    respectReadBackoff: options.scheduled === true,
    recordReadBackoff: async (connectionId, seconds, reason) => {
      await rpc("record_provider_connection_backoff", { p_connection_id: connectionId, p_seconds: seconds, p_reason: reason });
    },
    loadConnections: async () => {
      try {
        const rows = await rpc<ConnectionRow[] | null>("provider_connections_for_run", { p_mode: mode });
        return Array.isArray(rows) ? rows : null;
      } catch (error) {
        if (error instanceof MissingFunctionError) return null;
        throw error;
      }
    },
    loadRoutes: async (postIds, channelIds) =>
      (await rpc<{ posts: Record<string, string>; channels: Record<string, string> } | null>("provider_routes", { p_mode: mode, p_post_ids: postIds, p_channel_ids: channelIds })) ?? { posts: {}, channels: {} },
    recordState: async (connectionId: string, state: ConnectionState) =>
      (await rpc<boolean | null>("record_provider_connection_state", {
        p_connection_id: connectionId, p_ok: state.ok, p_error: state.error ?? null, p_rate_limit: state.rateLimit ?? null,
        p_pause_seconds: state.pauseSeconds ?? 0, p_pause_reason: state.pauseReason ?? null, p_synced: state.synced ?? false,
      })) !== false,
    loadStates: async () => {
      try {
        return (await rpc<Record<string, DurableConnectionState> | null>("provider_connection_states", { p_mode: mode })) ?? {};
      } catch (error) {
        // Base sans 0013 : seulement hors production (essais sur ancien schéma). En production, lecture impossible = refus.
        if (error instanceof MissingFunctionError && process.env.NODE_ENV !== "production") return null;
        throw error;
      }
    },
    build: buildConnectionProvider,
    // Base antérieure à 0012 : seul le Buffer simulé reste utilisable, et jamais en production (tests uniquement).
    // En mode réel, la migration est exigée : aucune opération ne part avec une clé rattachée à aucune connexion.
    ...(mode === "mock" && process.env.NODE_ENV !== "production" ? { legacy: () => new MockProvider(env.mockRunId) } : {}),
  });
}

/**
 * Contrôle préalable à un envoi (sans rien réserver ni appeler) : ces canaux peuvent-ils recevoir un NOUVEL effet ?
 * Renvoie une phrase pour l'administrateur, ou null. La garantie, elle, est dans la base : la réservation d'un envoi
 * sur une connexion révoquée ou en cours de révocation n'aboutit pas (migration 0013).
 */
export async function emissionProblem(bufferChannelIds: string[]): Promise<string | null> {
  const problem = bufferModeProblem();
  if (problem) return problem;
  const mode = env.bufferMode;
  let routes: { channels?: Record<string, string> } | null;
  let states: Record<string, DurableConnectionState> | null;
  try {
    routes = await rpc("provider_routes", { p_mode: mode, p_post_ids: [], p_channel_ids: bufferChannelIds });
    states = await rpc<Record<string, DurableConnectionState> | null>("provider_connection_states", { p_mode: mode });
  } catch (error) {
    // Base antérieure aux connexions (essais sur ancien schéma) : rien à contrôler ici.
    if (error instanceof MissingFunctionError && process.env.NODE_ENV !== "production") return null;
    throw error;
  }
  for (const id of bufferChannelIds) {
    const connection = routes?.channels?.[id];
    if (!connection) return "Un canal de ce contenu n'est relié à aucun compte Buffer : aucun envoi n'est possible. Connectez le compte Buffer de ce client.";
    const status = states?.[connection]?.status;
    if (status === "revoking") return "La révocation du compte Buffer de ce canal est demandée : plus aucun nouvel envoi ne part par ce compte.";
    if (status !== "active") return "Le compte Buffer de ce canal est révoqué : aucun envoi n'est possible.";
  }
  return null;
}
