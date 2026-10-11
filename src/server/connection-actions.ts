"use server";

import { randomBytes, randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/action-result";
import type { ConnectionDetail } from "@/lib/domain/connections";
import { errorCodeIn } from "@/lib/domain/errors";
import { rpc } from "@/server/automation-rpc";
import { getSession } from "@/server/auth";
import {
  credentialHint, credentialKeyAvailable, credentialStorageFingerprint, currentKeyVersion, decryptCredential, encryptCredential,
} from "@/server/credentials";
import { env, simulatedBufferAllowed } from "@/server/env";
import { BufferProvider, type BufferAccount } from "@/server/publishing/buffer-provider";
import { ProviderError } from "@/server/publishing/provider";
import type { ConnectionRow } from "@/server/publishing/router";
import { createSessionClient } from "@/server/supabase/clients";

/*
 * Gestion des connexions fournisseur (comptes Buffer) par l'administrateur.
 *
 * - Le rôle est revérifié ici ET dans la base : l'interface n'est jamais une preuve de droit.
 * - Une clé saisie est chiffrée par le serveur avant d'atteindre la base ; elle n'est ni renvoyée, ni journalisée,
 *   ni réaffichée.
 * - L'IDENTITÉ du compte auquel appartient une clé est constatée par le serveur auprès de Buffer (lecture seule,
 *   `account.id`) et enregistrée par des fonctions SQL protégées par le secret d'automatisation : le navigateur ne
 *   peut ni déclarer une identité ni enregistrer une clé réelle directement. Sans identité constatée, une clé ne
 *   sert à aucune opération. Un échec de vérification (clé refusée, délai, quota) ne remplace jamais la clé en place.
 * - Serveur en simulation : aucun appel à Buffer n'a lieu ; une clé peut être enregistrée, « non vérifiée ».
 */

const SESSION_EXPIRED: ActionResult = { ok: false, message: "Votre session a expiré. Reconnectez-vous.", expired: true };

const ERRORS: Record<string, string> = {
  forbidden: "Réservé à l'administrateur.",
  not_found: "Cette connexion est introuvable.",
  invalid_connection: "Demande invalide.",
  invalid_mode: "Demande invalide.",
  server_only: "Cette opération passe par le serveur de Cadence.",
  organization_unavailable: "Ce client est introuvable ou archivé.",
  credential_required: "Une clé est nécessaire.",
  verification_required: "Cette connexion est déjà rattachée à un compte Buffer : la nouvelle clé doit être vérifiée auprès de Buffer, ce qui est impossible tant que le serveur est en simulation.",
  provider_connection_revoked: "Cette connexion est révoquée ou en cours de révocation : créez-en une nouvelle.",
  provider_account_mismatch: "Cette clé appartient à un autre compte Buffer : créez une nouvelle connexion plutôt que de remplacer celle-ci.",
  provider_account_already_connected: "Ce compte Buffer est déjà relié par une autre connexion : un compte ne sert qu'un seul client.",
  provider_credential_reused: "Cette clé est déjà enregistrée pour une autre connexion : une clé ne sert qu'un seul client.",
  provider_credentials_fingerprint_idx: "Cette clé est déjà enregistrée pour une autre connexion : une clé ne sert qu'un seul client.",
  provider_connections_external_account_idx: "Ce compte Buffer est déjà relié par une autre connexion : un compte ne sert qu'un seul client.",
  default_connection: "Le compte simulé de démonstration ne se révoque pas.",
  provider_connections_environment_idx: "Une connexion utilise déjà la clé du serveur.",
};

async function adminActor(): Promise<{ actor: string } | { refusal: ActionResult }> {
  const session = await getSession();
  if (!session) return { refusal: SESSION_EXPIRED };
  return session.profile.role === "admin" ? { actor: session.profile.id } : { refusal: { ok: false, message: "Réservé à l'administrateur." } };
}

function failure(message: string | undefined, code?: string): ActionResult {
  if (code === "PGRST202" || message?.includes("absente) : appliquez les migrations")) {
    return { ok: false, message: "Cette action demande les migrations 0012 et 0013 de la base (connexions fournisseur)." };
  }
  if (message?.includes("not_authenticated") || message?.includes("permission denied for function")) return SESSION_EXPIRED;
  const known = errorCodeIn(message, Object.keys(ERRORS));
  return { ok: false, message: known ? ERRORS[known] : "Action impossible. Rechargez la page et réessayez." };
}

const label = z.string().trim().min(1).max(80);
const organizationId = z.string().uuid().nullable();
/** Une clé d'API : texte imprimable, sans espace. Sa forme exacte n'est pas supposée. */
const apiKey = z.string().trim().min(16).max(512).regex(/^\S+$/);

type Verification = { ok: true; account: BufferAccount } | { ok: false; message: string };

/**
 * Demande à Buffer à quel compte appartient cette clé (lecture seule). Tout ce qui n'est pas une réponse nette
 * (clé refusée, délai, quota, réponse illisible) est un ÉCHEC : aucune identité n'est supposée.
 */
async function identify(key: string): Promise<Verification> {
  try {
    return { ok: true, account: await new BufferProvider(key, env.reviewTags).describeAccount() };
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "rate_limit") return { ok: false, message: "Buffer limite les requêtes de ce compte pour le moment : la clé n'a pas pu être vérifiée. Réessayez plus tard." };
    if (error instanceof ProviderError && error.kind === "network") return { ok: false, message: "Buffer n'a pas répondu : la clé n'a pas pu être vérifiée. Rien n'a été modifié." };
    if (error instanceof ProviderError) return { ok: false, message: `Buffer n'a pas accepté cette clé : ${error.message}` };
    return { ok: false, message: "La clé n'a pas pu être vérifiée auprès de Buffer. Rien n'a été modifié." };
  }
}

const accountSummary = (account: BufferAccount) =>
  `compte « ${account.label} », ${account.channels.length} ${account.channels.length > 1 ? "canaux" : "canal"}`;

/** Compte Buffer SIMULÉ, isolé, propre à un client (ou partagé) : aucun secret, aucun appel externe. */
export async function createMockConnection(input: { organizationId: string | null; label: string }): Promise<ActionResult> {
  const parsed = z.object({ organizationId, label }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Donnez un nom à cette connexion (80 caractères au plus)." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  if (!simulatedBufferAllowed() || env.bufferMode !== "mock") return { ok: false, message: "Les comptes simulés n'existent pas sur ce serveur : il utilise le vrai Buffer." };
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("admin_create_provider_connection", {
    p_id: randomUUID(), p_mode: "mock", p_label: parsed.data.label, p_organization_id: parsed.data.organizationId,
    p_credential_source: "none", p_account_key: `c${randomBytes(5).toString("hex")}`,
  });
  if (error) return failure(error.message, error.code);
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Compte simulé créé. Ses canaux apparaîtront à la prochaine synchronisation." };
}

/**
 * Compte Buffer RÉEL. Serveur en mode réel : la clé est d'abord vérifiée auprès de Buffer (lecture seule) ; refusée
 * ou non vérifiable, elle n'est pas enregistrée. Serveur en simulation : aucun appel, la clé est enregistrée
 * « non vérifiée » et reste inutilisable.
 */
export async function createRealConnection(input: { organizationId: string | null; label: string; apiKey: string }): Promise<ActionResult> {
  const parsed = z.object({ organizationId, label, apiKey }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Vérifiez le nom de la connexion et la clé (16 caractères au moins, sans espace)." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  if (!credentialKeyAvailable()) return { ok: false, message: "Le serveur n'a pas de clé de chiffrement (CADENCE_CREDENTIALS_KEY) : aucune clé Buffer ne peut être enregistrée." };

  const real = env.bufferMode === "real";
  const verification = real ? await identify(parsed.data.apiKey) : null;
  if (verification && !verification.ok) return { ok: false, message: verification.message };
  const account = verification?.ok ? verification.account : null;

  const id = randomUUID();
  try {
    await rpc("server_create_provider_connection", {
      p_actor: who.actor, p_id: id, p_label: parsed.data.label, p_organization_id: parsed.data.organizationId,
      p_ciphertext: encryptCredential(id, parsed.data.apiKey), p_key_version: currentKeyVersion(), p_hint: credentialHint(parsed.data.apiKey),
      p_fingerprint: credentialStorageFingerprint(parsed.data.apiKey),
      p_external_account_id: account?.id ?? null, p_external_account_label: account?.label ?? null,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : undefined);
  }
  revalidatePath("/admin", "layout");
  return {
    ok: true,
    message: account
      ? `Connexion vérifiée auprès de Buffer (${accountSummary(account)}) et enregistrée, clé chiffrée. Ses canaux apparaîtront à la prochaine synchronisation.`
      : "Connexion enregistrée, clé chiffrée, NON vérifiée : le serveur est en simulation et n'appelle pas Buffer. Elle restera inutilisable tant qu'elle n'aura pas été vérifiée en mode réel.",
  };
}

/**
 * Remplace la clé d'une connexion réelle par une autre clé du MÊME compte Buffer. La nouvelle clé est vérifiée
 * avant tout : si elle est refusée, non vérifiable ou d'un autre compte, l'ancienne reste en place.
 */
export async function replaceConnectionCredential(input: { connectionId: string; apiKey: string }): Promise<ActionResult> {
  const parsed = z.object({ connectionId: z.string().uuid(), apiKey }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Saisissez une clé valide (16 caractères au moins, sans espace)." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  if (!credentialKeyAvailable()) return { ok: false, message: "Le serveur n'a pas de clé de chiffrement (CADENCE_CREDENTIALS_KEY)." };

  const real = env.bufferMode === "real";
  const verification = real ? await identify(parsed.data.apiKey) : null;
  if (verification && !verification.ok) return { ok: false, message: `${verification.message} L'ancienne clé reste en place.` };
  const account = verification?.ok ? verification.account : null;

  let outcome: string;
  try {
    outcome = await rpc<string>("server_set_provider_credential", {
      p_actor: who.actor, p_connection_id: parsed.data.connectionId,
      p_ciphertext: encryptCredential(parsed.data.connectionId, parsed.data.apiKey), p_key_version: currentKeyVersion(),
      p_hint: credentialHint(parsed.data.apiKey), p_fingerprint: credentialStorageFingerprint(parsed.data.apiKey),
      p_external_account_id: account?.id ?? null, p_external_account_label: account?.label ?? null,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : undefined);
  }
  revalidatePath("/admin", "layout");
  if (outcome === "account_mismatch") return { ok: false, message: `${ERRORS.provider_account_mismatch} L'ancienne clé reste en place.` };
  if (outcome === "account_already_connected") return { ok: false, message: `${ERRORS.provider_account_already_connected} L'ancienne clé reste en place.` };
  if (outcome === "credential_reused") return { ok: false, message: `${ERRORS.provider_credential_reused} L'ancienne clé reste en place.` };
  return {
    ok: true,
    message: account ? "Clé remplacée : même compte Buffer, vérifié. L'ancienne clé n'est plus enregistrée." : "Clé remplacée, NON vérifiée (serveur en simulation). L'ancienne n'est plus enregistrée.",
  };
}

export interface VerifyResult extends ActionResult {
  account?: { label: string; channels: { service: string; name: string; isDisconnected: boolean }[] };
}

/**
 * Vérifie la clé ENREGISTRÉE d'une connexion auprès de Buffer (lecture seule) : compte constaté, réseaux connectés.
 * Sans effet chez Buffer. En simulation, aucun appel n'a lieu et l'action le dit.
 */
export async function verifyConnection(input: { connectionId: string }): Promise<VerifyResult> {
  const parsed = z.object({ connectionId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  if (env.bufferMode !== "real") return { ok: false, message: "Le serveur est en simulation : il n'appelle pas Buffer, la connexion ne peut pas être vérifiée ici." };

  let row: ConnectionRow | undefined;
  try {
    row = ((await rpc<ConnectionRow[] | null>("provider_connections_for_run", { p_mode: "real" })) ?? []).find((item) => item.id === parsed.data.connectionId);
  } catch (error) {
    return failure(error instanceof Error ? error.message : undefined);
  }
  if (!row) return { ok: false, message: "Cette connexion est introuvable, simulée ou révoquée." };

  let key: string;
  try {
    key = row.credentialSource === "environment" ? env.bufferApiKey : decryptCredential(row.id, row.ciphertext ?? "", row.keyVersion);
  } catch (error) {
    return { ok: false, message: `La clé enregistrée est illisible : ${error instanceof Error ? error.message : "clé de chiffrement différente"}` };
  }
  const verification = await identify(key);
  let outcome: string;
  try {
    outcome = await rpc<string>("server_record_provider_verification", {
      p_actor: who.actor, p_connection_id: row.id, p_ok: verification.ok,
      p_external_account_id: verification.ok ? verification.account.id : null,
      p_external_account_label: verification.ok ? verification.account.label : null,
      p_detail: verification.ok ? null : verification.message,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : undefined);
  }
  revalidatePath("/admin", "layout");
  if (!verification.ok) return { ok: false, message: verification.message };
  if (outcome === "account_mismatch") return { ok: false, message: "La clé enregistrée appartient à un autre compte Buffer que celui de cette connexion : elle n'est plus utilisée. Remplacez-la par une clé du bon compte." };
  if (outcome === "account_already_connected") return { ok: false, message: ERRORS.provider_account_already_connected };
  const { account } = verification;
  return {
    ok: true,
    message: `Connexion vérifiée : ${accountSummary(account)}.`,
    account: { label: account.label, channels: account.channels.map(({ service, name, isDisconnected }) => ({ service, name, isDisconnected })) },
  };
}

export interface RevokeResult extends ActionResult {
  /** Effets externes non rapprochés qui empêchent la révocation définitive. */
  unresolved?: { scheduled: number; pending: number; uncertain: number };
  /** La révocation est demandée : nouveaux effets bloqués, clé conservée pour annuler ce qui est engagé. */
  revoking?: boolean;
}

const openOf = (value: unknown) => {
  const open = (value ?? {}) as Partial<Record<"scheduled" | "pending" | "uncertain", number>>;
  return { scheduled: open.scheduled ?? 0, pending: open.pending ?? 0, uncertain: open.uncertain ?? 0 };
};

/**
 * Révoque une connexion. Sans effet externe en attente : révocation immédiate, clé effacée.
 * Avec des effets en attente : la révocation est DEMANDÉE (plus aucun nouvel effet, la clé reste pour annuler et
 * rapprocher) ; elle devient définitive quand il ne reste rien, ou sur décision forcée et tracée (`force`).
 */
export async function revokeConnection(input: { connectionId: string; force?: boolean }): Promise<RevokeResult> {
  const parsed = z.object({ connectionId: z.string().uuid(), force: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  const supabase = await createSessionClient();
  const { data, error } = parsed.data.force
    ? await supabase.rpc("admin_revoke_provider_connection", { p_connection_id: parsed.data.connectionId, p_force: true })
    : await supabase.rpc("admin_request_provider_revocation", { p_connection_id: parsed.data.connectionId });
  if (error) return failure(error.message, error.code);
  const result = data as { revoked: boolean; revoking?: boolean; forced?: boolean; unresolved?: unknown };
  revalidatePath("/admin", "layout");
  if (result.revoked) {
    return {
      ok: true,
      message: result.forced
        ? "Connexion révoquée de force : sa clé est effacée. Les opérations qui restaient en attente ne sont PAS annulées chez Buffer : traitez-les dans Buffer."
        : "Connexion révoquée : sa clé est effacée, son historique est conservé.",
    };
  }
  const open = openOf(result.unresolved);
  return {
    ok: false, revoking: true, unresolved: open,
    message: `Révocation demandée : plus aucune nouvelle opération ne part par ce compte. Restent à annuler ou à rapprocher : ${open.scheduled} publication(s) programmée(s), ${open.pending} opération(s) en cours, ${open.uncertain} envoi(s) incertain(s).`,
  };
}

/** Annule une demande de révocation : la connexion redevient active. */
export async function cancelRevocation(input: { connectionId: string }): Promise<ActionResult> {
  const parsed = z.object({ connectionId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("admin_cancel_provider_revocation", { p_connection_id: parsed.data.connectionId });
  if (error) return failure(error.message, error.code);
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Demande de révocation annulée : la connexion est de nouveau active." };
}

/** Canaux, programmations en attente et envois non résolus d'une connexion (administrateur uniquement). */
export async function connectionDetail(input: { connectionId: string }): Promise<ActionResult & { detail?: ConnectionDetail }> {
  const parsed = z.object({ connectionId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  const supabase = await createSessionClient();
  const { data, error } = await supabase.rpc("admin_provider_connection_detail", { p_connection_id: parsed.data.connectionId });
  if (error) return failure(error.message, error.code);
  return { ok: true, message: "", detail: data as ConnectionDetail };
}

/**
 * Rotation de la clé maître : re-chiffre avec la clé COURANTE chaque clé Buffer encore chiffrée avec une ancienne
 * (CADENCE_CREDENTIALS_PREVIOUS_KEYS). Aucun appel à Buffer ; aucune clé ne change de valeur ; rien n'est journalisé
 * de leur contenu. Rejouable : une clé déjà à jour est ignorée.
 */
export async function reencryptCredentials(): Promise<ActionResult> {
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  if (!credentialKeyAvailable()) return { ok: false, message: "Le serveur n'a pas de clé de chiffrement (CADENCE_CREDENTIALS_KEY)." };
  let rows: ConnectionRow[];
  let target: number;
  try {
    target = currentKeyVersion();
    rows = ((await rpc<ConnectionRow[] | null>("provider_connections_for_run", { p_mode: "real" })) ?? []).filter((row) => row.credentialSource === "stored" && row.ciphertext);
  } catch (error) {
    return failure(error instanceof Error ? error.message : undefined);
  }
  let done = 0;
  const unreadable: string[] = [];
  for (const row of rows) {
    const from = row.keyVersion ?? 1;
    if (from === target) continue;
    try {
      const secret = decryptCredential(row.id, row.ciphertext!, from);
      const changed = await rpc<boolean>("server_reencrypt_provider_credential", {
        p_actor: who.actor, p_connection_id: row.id, p_ciphertext: encryptCredential(row.id, secret), p_key_version: target,
        p_from_key_version: from, p_fingerprint: credentialStorageFingerprint(secret),
      });
      if (changed) done += 1;
    } catch {
      unreadable.push(row.label);
    }
  }
  revalidatePath("/admin", "layout");
  if (unreadable.length > 0) {
    return { ok: false, message: `${done} clé(s) re-chiffrée(s). ${unreadable.length} clé(s) illisible(s) avec les clés maîtres présentes sur le serveur : ${unreadable.join(", ")}. Ne retirez pas l'ancienne clé maître.` };
  }
  return { ok: true, message: done > 0 ? `${done} clé(s) re-chiffrée(s) avec la clé maître n° ${target}. L'ancienne clé maître peut être retirée du serveur.` : `Toutes les clés sont déjà chiffrées avec la clé maître n° ${target}.` };
}
