"use server";

import { randomBytes, randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/action-result";
import { errorCodeIn } from "@/lib/domain/errors";
import { getSession } from "@/server/auth";
import { CREDENTIAL_KEY_VERSION, credentialHint, credentialKeyAvailable, encryptCredential } from "@/server/credentials";
import { env } from "@/server/env";
import { createSessionClient } from "@/server/supabase/clients";

/*
 * Gestion des connexions fournisseur (comptes Buffer) par l'administrateur.
 *
 * - Le rôle est revérifié ici ET dans la base (fonctions admin_*) : l'interface n'est jamais une preuve de droit.
 * - Une clé saisie est chiffrée par le serveur avant d'atteindre la base ; elle n'est ni renvoyée, ni journalisée,
 *   ni réaffichée. Aucune de ces actions n'appelle Buffer.
 */

const SESSION_EXPIRED: ActionResult = { ok: false, message: "Votre session a expiré. Reconnectez-vous.", expired: true };

const ERRORS: Record<string, string> = {
  forbidden: "Réservé à l'administrateur.",
  not_found: "Cette connexion est introuvable.",
  invalid_connection: "Demande invalide.",
  invalid_mode: "Demande invalide.",
  organization_unavailable: "Ce client est introuvable ou archivé.",
  credential_required: "Une clé est nécessaire.",
  provider_connection_revoked: "Cette connexion est révoquée : créez-en une nouvelle.",
  provider_account_mismatch: "Cette clé appartient à un autre compte Buffer : créez une nouvelle connexion plutôt que de remplacer celle-ci.",
  default_connection: "Le compte simulé de démonstration ne se révoque pas.",
  provider_connections_environment_idx: "Une connexion utilise déjà la clé du serveur.",
};

async function adminRefusal(): Promise<ActionResult | null> {
  const session = await getSession();
  if (!session) return SESSION_EXPIRED;
  return session.profile.role === "admin" ? null : { ok: false, message: "Réservé à l'administrateur." };
}

function failure(message: string | undefined, code?: string): ActionResult {
  if (code === "PGRST202") return { ok: false, message: "Cette action demande la migration 0012 de la base (connexions fournisseur)." };
  if (message?.includes("not_authenticated") || message?.includes("permission denied for function")) return SESSION_EXPIRED;
  const known = errorCodeIn(message, Object.keys(ERRORS));
  return { ok: false, message: known ? ERRORS[known] : "Action impossible. Rechargez la page et réessayez." };
}

const label = z.string().trim().min(1).max(80);
const organizationId = z.string().uuid().nullable();
/** Une clé d'API : texte imprimable, sans espace. Sa forme exacte n'est pas supposée. */
const apiKey = z.string().trim().min(16).max(512).regex(/^\S+$/);

/** Compte Buffer SIMULÉ, isolé, propre à un client (ou partagé) : aucun secret, aucun appel externe. */
export async function createMockConnection(input: { organizationId: string | null; label: string }): Promise<ActionResult> {
  const parsed = z.object({ organizationId, label }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Donnez un nom à cette connexion (80 caractères au plus)." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
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
 * Compte Buffer RÉEL : la clé est chiffrée puis enregistrée. Rien n'est envoyé à Buffer ; la connexion ne sert que
 * lorsque le serveur fonctionne en mode réel.
 */
export async function createRealConnection(input: { organizationId: string | null; label: string; apiKey: string }): Promise<ActionResult> {
  const parsed = z.object({ organizationId, label, apiKey }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Vérifiez le nom de la connexion et la clé (16 caractères au moins, sans espace)." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  if (!credentialKeyAvailable()) return { ok: false, message: "Le serveur n'a pas de clé de chiffrement (CADENCE_CREDENTIALS_KEY) : aucune clé Buffer ne peut être enregistrée." };
  const id = randomUUID();
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("admin_create_provider_connection", {
    p_id: id, p_mode: "real", p_label: parsed.data.label, p_organization_id: parsed.data.organizationId, p_credential_source: "stored",
    p_ciphertext: encryptCredential(id, parsed.data.apiKey), p_key_version: CREDENTIAL_KEY_VERSION, p_hint: credentialHint(parsed.data.apiKey),
  });
  if (error) return failure(error.message, error.code);
  revalidatePath("/admin", "layout");
  return {
    ok: true,
    message: env.bufferMode === "real"
      ? "Connexion enregistrée, clé chiffrée. Elle sera lue à la prochaine synchronisation."
      : "Connexion enregistrée, clé chiffrée. Elle restera inutilisée tant que le serveur est en mode simulé.",
  };
}

/** Remplace la clé d'une connexion réelle (même compte Buffer). L'ancienne clé n'est pas conservée. */
export async function replaceConnectionCredential(input: { connectionId: string; apiKey: string }): Promise<ActionResult> {
  const parsed = z.object({ connectionId: z.string().uuid(), apiKey }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Saisissez une clé valide (16 caractères au moins, sans espace)." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  if (!credentialKeyAvailable()) return { ok: false, message: "Le serveur n'a pas de clé de chiffrement (CADENCE_CREDENTIALS_KEY)." };
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("admin_set_provider_credential", {
    p_connection_id: parsed.data.connectionId, p_ciphertext: encryptCredential(parsed.data.connectionId, parsed.data.apiKey),
    p_key_version: CREDENTIAL_KEY_VERSION, p_hint: credentialHint(parsed.data.apiKey),
  });
  if (error) return failure(error.message, error.code);
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Clé remplacée. L'ancienne n'est plus enregistrée." };
}

export interface RevokeResult extends ActionResult {
  /** Effets externes non rapprochés qui ont fait refuser la révocation. */
  unresolved?: { scheduled: number; pending: number; uncertain: number };
}

/**
 * Révoque une connexion : plus aucune opération ne passe par elle et sa clé est effacée. Refusée tant que des
 * programmations, annulations ou envois incertains ne sont pas rapprochés, sauf `force` (décision tracée).
 */
export async function revokeConnection(input: { connectionId: string; force?: boolean }): Promise<RevokeResult> {
  const parsed = z.object({ connectionId: z.string().uuid(), force: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  const supabase = await createSessionClient();
  const { data, error } = await supabase.rpc("admin_revoke_provider_connection", { p_connection_id: parsed.data.connectionId, p_force: parsed.data.force ?? false });
  if (error) return failure(error.message, error.code);
  const result = data as { revoked: boolean; unresolved?: { scheduled: number; pending: number; uncertain: number } };
  if (!result.revoked) {
    const open = result.unresolved ?? { scheduled: 0, pending: 0, uncertain: 0 };
    return {
      ok: false, unresolved: open,
      message: `Révocation refusée : ${open.scheduled} publication(s) encore programmée(s), ${open.pending} opération(s) en cours et ${open.uncertain} envoi(s) incertain(s) dépendent de ce compte.`,
    };
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Connexion révoquée : sa clé est effacée, son historique est conservé." };
}
