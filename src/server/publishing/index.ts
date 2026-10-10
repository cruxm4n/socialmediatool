import "server-only";

import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { credentialFingerprint, decryptCredential } from "@/server/credentials";
import { env } from "@/server/env";
import { BufferProvider } from "@/server/publishing/buffer-provider";
import { MockProvider } from "@/server/publishing/mock-provider";
import type { PublishingProvider } from "@/server/publishing/provider";
import { ConnectionRouter, type ConnectionRow, type ConnectionState } from "@/server/publishing/router";

/*
 * Point d'entrée unique vers le fournisseur de publication.
 *
 * Depuis la migration 0012, chaque canal dépend d'une CONNEXION (un compte Buffer, réel ou simulé) : le routeur
 * envoie chaque opération au compte du canal concerné. Il n'existe pas de clé globale utilisée par défaut : la clé
 * du serveur (BUFFER_API_KEY) ne sert qu'à la connexion qui la déclare explicitement (« environment », le compte
 * historique). Voir docs/CONNEXIONS_FOURNISSEUR.md.
 */

/** Un fournisseur réel par connexion et par secret : remplacer la clé d'une connexion crée un nouveau client. */
const realProviders = new Map<string, BufferProvider>();

function realProvider(connectionId: string, apiKey: string): BufferProvider {
  const key = `${connectionId}:${credentialFingerprint(apiKey)}`;
  let provider = realProviders.get(key);
  if (!provider) {
    // L'ancien client de cette connexion (clé remplacée) n'est plus conservé.
    for (const existing of realProviders.keys()) if (existing.startsWith(`${connectionId}:`)) realProviders.delete(existing);
    provider = new BufferProvider(apiKey, env.reviewTag);
    realProviders.set(key, provider);
  }
  return provider;
}

/** Fournisseur d'UNE connexion. Lève une erreur si son secret manque ou ne se déchiffre pas (jamais de repli). */
export function buildConnectionProvider(row: ConnectionRow): PublishingProvider {
  if (row.credentialSource === "none") {
    // Compte simulé : celui de démonstration, ou un compte isolé propre à la connexion.
    return row.isDefault || !row.accountKey ? new MockProvider(env.mockRunId) : new MockProvider(env.mockRunId, row.accountKey);
  }
  if (row.credentialSource === "environment") return realProvider(row.id, env.bufferApiKey);
  if (!row.ciphertext) throw new Error("aucun secret enregistré pour cette connexion");
  return realProvider(row.id, decryptCredential(row.id, row.ciphertext));
}

/** Fournisseur actif : un routeur de connexions, pour le mode du serveur (réel uniquement si BUFFER_MODE=real). */
export function getProvider(): PublishingProvider {
  const mode = env.bufferMode;
  return new ConnectionRouter({
    mode,
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
    recordState: async (connectionId: string, state: ConnectionState) => {
      await rpc("record_provider_connection_state", {
        p_connection_id: connectionId, p_ok: state.ok, p_error: state.error ?? null, p_rate_limit: state.rateLimit ?? null,
        p_pause_seconds: state.pauseSeconds ?? 0, p_pause_reason: state.pauseReason ?? null, p_synced: state.synced ?? false,
      });
    },
    build: buildConnectionProvider,
    // Base antérieure à 0012 : seul le Buffer simulé reste utilisable (tests, démonstration). En mode réel, la
    // migration est exigée : aucune opération ne part avec une clé qui ne serait rattachée à aucune connexion.
    ...(mode === "mock" ? { legacy: () => new MockProvider(env.mockRunId) } : {}),
  });
}
