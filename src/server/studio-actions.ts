"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/action-result";
import { pilotLeadSatisfied } from "@/lib/domain/schedule-margins";
import { canMoveTo, dedupeHashtags, normalizeHashtag } from "@/lib/domain/studio";
import { getSession } from "@/server/auth";
import { getPost } from "@/server/data";
import { env } from "@/server/env";
import { getProvider } from "@/server/publishing";
import { confirmDraftAbsent, findDraftForPost, pushDraftToBuffer, reconcileDraftPush, studioFailure, type PushResult } from "@/server/studio";
import { ProviderError } from "@/server/publishing/provider";
import { createSessionClient } from "@/server/supabase/clients";
import { activeRateLimitPause, pauseMessage } from "@/server/quota";
import { recordRateLimit, runSync } from "@/server/sync";

/*
 * Actions du Content Studio, réservées à l'administrateur. Le contrôle ci-dessous évite un appel
 * inutile ; ce sont les fonctions SQL (private.require_admin) qui font autorité.
 */

const SESSION_EXPIRED: ActionResult = { ok: false, message: "Votre session a expiré. Reconnectez-vous.", expired: true };
const MIGRATION_REQUIRED: ActionResult = { ok: false, message: "Le Studio demande la migration 0008 de la base (voir docs/STUDIO.md)." };

async function refusal(): Promise<ActionResult | null> {
  const session = await getSession();
  if (!session) return SESSION_EXPIRED;
  return session.profile.role === "admin" ? null : { ok: false, message: "Réservé à l'administrateur." };
}

async function call<T>(name: string, params: Record<string, unknown>): Promise<{ data: T; failure: null } | { data: null; failure: ActionResult & { code?: string } }> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.rpc(name, params);
  if (!error) return { data: data as T, failure: null };
  if (error.code === "PGRST202") return { data: null, failure: MIGRATION_REQUIRED };
  return { data: null, failure: studioFailure(error.message) };
}

const draftSchema = z.object({
  id: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().optional(),
  organizationId: z.string().uuid(),
  title: z.string().max(120),
  dueAt: z.string().datetime().nullable(),
  hashtags: z.array(z.string().max(80)).max(60),
  mediaIds: z.array(z.string().uuid()).max(20),
  variants: z.array(z.object({ channelId: z.string().uuid(), text: z.string().max(10000) })).max(20),
});
export type StudioDraftInput = z.input<typeof draftSchema>;

/** Crée ou enregistre un contenu (appelé par la sauvegarde automatique). */
export async function saveStudioDraft(input: StudioDraftInput): Promise<ActionResult & { id?: string; revision?: number; code?: string }> {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Contenu invalide : vérifiez la date et la longueur des textes." };
  const denied = await refusal();
  if (denied) return denied;
  const { id, expectedRevision, hashtags, ...rest } = parsed.data;
  const result = await call<{ id: string; revision: number }>("studio_save_draft", {
    p_id: id ?? null,
    p_expected_revision: expectedRevision ?? null,
    // Les hashtags sont remis en forme ici aussi : le serveur ne se fie pas au navigateur.
    p_payload: { ...rest, hashtags: dedupeHashtags(hashtags.map(normalizeHashtag).filter((tag): tag is string => tag !== null)).slice(0, 30) },
  });
  if (result.failure) return result.failure;
  // Aucun rafraîchissement de page pendant la saisie : l'éditeur garde son état local, la liste se relit à l'ouverture.
  return { ok: true, message: "Enregistré.", id: result.data.id, revision: result.data.revision };
}

/**
 * Envoie le contenu en validation : un brouillon tagué par canal dans Buffer. Ne programme rien.
 * `force` est accepté pour compatibilité mais ne contourne plus rien : un envoi interrompu ou de résultat inconnu
 * se résout (brouillon retrouvé, ou absence confirmée par une personne), il ne se force pas.
 */
export async function submitStudioDraft(input: { id: string; force?: boolean }): Promise<PushResult> {
  const empty = { created: 0, updated: 0, failed: 0 };
  const parsed = z.object({ id: z.string().uuid(), force: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide.", ...empty };
  const denied = await refusal();
  if (denied) return { ...denied, ...empty };
  const result = await pushDraftToBuffer(parsed.data.id);
  revalidatePath("/", "layout");
  return result;
}

/** Interroge Buffer (lecture seule) après un envoi au résultat inconnu : retrouve le brouillon ou autorise un renvoi. */
export async function reconcileStudioDraft(input: { id: string }): Promise<PushResult> {
  const empty = { created: 0, updated: 0, failed: 0 };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide.", ...empty };
  const denied = await refusal();
  if (denied) return { ...denied, ...empty };
  const result = await reconcileDraftPush(parsed.data.id);
  revalidatePath("/", "layout");
  return result;
}

/**
 * Confirmation d'une PERSONNE : elle a vérifié dans Buffer qu'aucun brouillon ne correspond. Cadence ne le déduit
 * jamais d'une recherche (lecture limitée, texte modifié dans Buffer) : c'est une DÉROGATION à la garantie
 * automatique, pour une tentative précise et avec une preuve consignée ; le risque de doublon subsiste.
 */
export async function confirmStudioDraftAbsent(input: { id: string; evidence: string }): Promise<PushResult> {
  const empty = { created: 0, updated: 0, failed: 0 };
  // La preuve (ce qui a été vérifié, et où) est consignée avec la tentative : sans elle, aucune dérogation.
  const parsed = z.object({ id: z.string().uuid(), evidence: z.string().trim().min(10).max(500) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Indiquez ce que vous avez vérifié dans Buffer (au moins quelques mots).", ...empty };
  const denied = await refusal();
  if (denied) return { ...denied, ...empty };
  const result = await confirmDraftAbsent(parsed.data.id, parsed.data.evidence);
  revalidatePath("/", "layout");
  return result;
}

export async function setStudioDraftArchived(input: { id: string; archived: boolean }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid(), archived: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const denied = await refusal();
  if (denied) return denied;
  const result = await call("studio_set_draft_archived", { p_id: parsed.data.id, p_archived: parsed.data.archived });
  if (result.failure) return result.failure;
  revalidatePath("/admin", "layout");
  return { ok: true, message: parsed.data.archived ? "Contenu archivé. Les brouillons déjà créés dans Buffer n'y sont pas supprimés." : "Contenu restauré." };
}

const mediaSchema = z.object({
  organizationId: z.string().uuid(),
  path: z.string().min(1).max(500),
  fileName: z.string().max(200),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().positive().nullable(),
});

/** Ajoute à la bibliothèque un fichier que le navigateur vient de déposer dans l'espace de stockage. */
export async function registerMedia(input: z.input<typeof mediaSchema>): Promise<ActionResult & { id?: string }> {
  const parsed = mediaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Fichier invalide." };
  const denied = await refusal();
  if (denied) return denied;
  const { organizationId, path, fileName, mimeType, sizeBytes, width, height, durationMs } = parsed.data;
  const result = await call<string>("studio_register_media", {
    p_organization_id: organizationId, p_path: path, p_file_name: fileName, p_mime_type: mimeType, p_size_bytes: sizeBytes,
    p_width: width, p_height: height, p_duration_ms: durationMs,
  });
  if (result.failure) return result.failure;
  revalidatePath("/admin/studio", "layout");
  return { ok: true, message: "Média ajouté à la bibliothèque.", id: result.data };
}

export async function setMediaArchived(input: { id: string; archived: boolean }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid(), archived: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const denied = await refusal();
  if (denied) return denied;
  const result = await call("studio_set_media_archived", { p_id: parsed.data.id, p_archived: parsed.data.archived });
  if (result.failure) return result.failure;
  revalidatePath("/admin/studio", "layout");
  return { ok: true, message: parsed.data.archived ? "Média retiré de la bibliothèque. Les contenus qui l'utilisent le gardent." : "Média restauré." };
}

const moveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("studio"), draftId: z.string().uuid(), dueAt: z.string().datetime() }),
  z.object({ kind: z.literal("post"), postId: z.string().uuid(), dueAt: z.string().datetime() }),
]);

/**
 * Change la date d'un contenu depuis le calendrier.
 * - Contenu du Studio pas encore envoyé : seule la date du contenu change.
 * - Brouillon présent dans Buffer : la date est changée dans Buffer, puis Buffer est relu. Comme la
 *   date fait partie de ce que le client valide, une approbation déjà donnée est annulée par la base.
 * - Publication programmée ou publiée : refusé.
 */
export async function moveCalendarItem(input: z.input<typeof moveSchema>): Promise<ActionResult> {
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const denied = await refusal();
  if (denied) return denied;
  if (!canMoveTo(parsed.data.dueAt, new Date().toISOString())) return { ok: false, message: "Impossible de déplacer une publication dans le passé." };
  // Profil pilote : toute reprogrammation exige une échéance à plus de 24 h.
  if (env.profile === "pilot" && !pilotLeadSatisfied(parsed.data.dueAt)) return { ok: false, message: "Profil pilote : la nouvelle date doit être à plus de 24 heures." };

  if (parsed.data.kind === "studio") {
    const result = await call("studio_reschedule_draft", { p_id: parsed.data.draftId, p_expected_revision: null, p_due_at: parsed.data.dueAt });
    if (result.failure) return result.failure;
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Date modifiée." };
  }

  const post = await getPost(parsed.data.postId);
  if (!post || post.removedAt) return { ok: false, message: "Cette publication est introuvable." };
  if (post.bufferStatus !== "draft") {
    return { ok: false, message: "Seul un brouillon peut être déplacé d'ici. Une publication programmée se modifie dans Buffer, ce qui annule sa validation." };
  }

  // Publication issue du Studio : c'est le contenu entier qui change de date, sur tous ses canaux.
  const origin = await findDraftForPost(post.bufferPostId);
  if (origin) {
    const moved = await call("studio_reschedule_draft", { p_id: origin.draftId, p_expected_revision: null, p_due_at: parsed.data.dueAt });
    if (moved.failure) return moved.failure;
    const pushed = await pushDraftToBuffer(origin.draftId);
    revalidatePath("/", "layout");
    return pushed.ok ? { ok: true, message: "Date modifiée dans le Studio et dans Buffer." } : { ok: false, message: pushed.message, expired: pushed.expired };
  }

  try {
    const provider = getProvider();
    const pause = await activeRateLimitPause(provider.mode);
    if (pause) return { ok: false, message: pauseMessage(pause) };
    const live = await provider.getPost(post.bufferPostId);
    if (!live) return { ok: false, message: "Ce post n'existe plus dans Buffer." };
    await provider.rescheduleDraft(live, parsed.data.dueAt);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "rate_limit") await recordRateLimit(error, getProvider().mode);
    if (error instanceof ProviderError && error.outcome === "unknown") {
      // La réponse est perdue : la date a peut-être changé. Buffer est relu pour le constater.
      await runSync("calendrier").catch(() => undefined);
      revalidatePath("/", "layout");
      return { ok: false, message: "Buffer n'a pas répondu : le changement de date est incertain. L'état a été relu, vérifiez la date affichée avant de réessayer." };
    }
    return { ok: false, message: `Buffer n'a pas accepté le changement de date : ${error instanceof Error ? error.message : String(error)}` };
  }
  await runSync("calendrier").catch(() => undefined);
  revalidatePath("/", "layout");
  return { ok: true, message: post.approvalStatus === "approved" ? "Date modifiée dans Buffer. La validation du client est à redemander." : "Date modifiée dans Buffer." };
}
