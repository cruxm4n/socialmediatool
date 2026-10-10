import "server-only";

import { errorCodeIn } from "@/lib/domain/errors";
import { composeText, hasBlockingIssue, STUDIO_ERRORS, validateDraft, type StudioMedia } from "@/lib/domain/studio";
import { toNetwork, type MediaAsset, type PostVersion, type StudioDraft } from "@/lib/types";
import { listChannels } from "@/server/data";
import { getProvider } from "@/server/publishing";
import { ProviderError, type DraftContent, type ProviderPost } from "@/server/publishing/provider";
import { createSessionClient } from "@/server/supabase/clients";
import { activeRateLimitPause, pauseMessage } from "@/server/quota";
import { pilotLeadSatisfied } from "@/lib/domain/schedule-margins";
import { env } from "@/server/env";
import { recordRateLimit, runSync } from "@/server/sync";

/*
 * Content Studio, côté serveur : lectures (toujours avec la session de l'administrateur, la base
 * décide) et envoi d'un contenu vers Buffer. Le Studio ne crée que des BROUILLONS tagués ; la
 * validation et la programmation restent celles du circuit existant.
 */

const BUCKET = "media";
/** Durée de l'adresse d'affichage d'un média dans Cadence. */
const DISPLAY_URL_SECONDS = 60 * 60;
/** Durée de l'adresse remise à Buffer pour télécharger un média. */
const BUFFER_URL_SECONDS = 7 * 24 * 60 * 60;

/** Refus d'une fonction SQL du Studio, traduit. `code` permet à l'écran de réagir (renvoi à confirmer…). */
export function studioFailure(message: string | undefined): { ok: false; message: string; code?: string; expired?: boolean } {
  if (message?.includes("not_authenticated") || message?.includes("permission denied for function")) {
    return { ok: false, message: "Votre session a expiré. Reconnectez-vous.", expired: true };
  }
  const code = errorCodeIn(message, Object.keys(STUDIO_ERRORS));
  return { ok: false, code, message: code ? STUDIO_ERRORS[code] : `Action impossible : ${message ?? "erreur inconnue"}` };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- lignes brutes renvoyées par l'API Supabase */
function toDraft(row: any): StudioDraft {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    dueAt: row.due_at,
    hashtags: row.hashtags ?? [],
    mediaIds: row.media_ids ?? [],
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    variants: (row.studio_variants ?? [])
      .filter((variant: any) => variant.removed_at === null)
      .map((variant: any) => ({
        id: variant.id,
        channelId: variant.channel_id,
        text: variant.text,
        bufferPostId: variant.buffer_post_id,
        pushState: variant.push_state,
        pushError: variant.push_error,
        pushedRevision: variant.pushed_revision,
        pushUnknownAt: variant.push_unknown_at ?? null,
      })),
  };
}

function toMedia(row: any, url: string | null): MediaAsset {
  return {
    id: row.id,
    organizationId: row.organization_id,
    fileName: row.file_name,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    url,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const DRAFT_COLUMNS = "*, studio_variants(*)";

/** Table ou fonction absente : la base n'a pas reçu la migration (ce n'est pas une panne). */
const isMissingSchema = (error: { code?: string } | null) => !!error && ["42P01", "PGRST205", "PGRST202", "42703"].includes(error.code ?? "");

/**
 * Contenus du Studio, les plus récemment modifiés d'abord. null : la base n'a pas la migration 0008.
 * Toute autre erreur (panne, droits) est levée : elle n'est jamais présentée comme une migration absente.
 */
export async function listStudioDrafts(): Promise<StudioDraft[] | null> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("studio_drafts").select(DRAFT_COLUMNS).order("updated_at", { ascending: false }).limit(200);
  if (isMissingSchema(error)) return null;
  if (error) throw new Error(`Lecture impossible (contenus du Studio) : ${error.message}`);
  return data.map(toDraft);
}

export async function getStudioDraft(id: string): Promise<StudioDraft | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("studio_drafts").select(DRAFT_COLUMNS).eq("id", id).maybeSingle();
  if (isMissingSchema(error)) return null;
  if (error) throw new Error(`Lecture impossible (contenu du Studio) : ${error.message}`);
  return data ? toDraft(data) : null;
}

/**
 * Médias d'un client, avec une adresse d'affichage temporaire. `includeIds` : médias à renvoyer
 * même archivés (un contenu existant garde les siens). null : la base n'a pas la migration 0008.
 */
export async function listMedia(organizationId: string | null, includeIds: string[] = []): Promise<MediaAsset[] | null> {
  const supabase = await createSessionClient();
  let query = supabase.from("media_assets").select("*").order("created_at", { ascending: false }).limit(300);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query;
  if (isMissingSchema(error)) return null;
  if (error) throw new Error(`Lecture impossible (médias) : ${error.message}`);

  // Les médias explicitement référencés sont lus à part : un ancien média ne disparaît pas derrière le plafond de la liste.
  const have = new Set(data.map((row) => row.id as string));
  const missing = includeIds.filter((id) => !have.has(id));
  let extra: typeof data = [];
  if (missing.length > 0) {
    let referenced = supabase.from("media_assets").select("*").in("id", missing);
    if (organizationId) referenced = referenced.eq("organization_id", organizationId);
    const found = await referenced;
    if (found.error) throw new Error(`Lecture impossible (médias référencés) : ${found.error.message}`);
    extra = found.data;
  }

  const rows = [...data.filter((row) => row.archived_at === null || includeIds.includes(row.id)), ...extra];
  if (rows.length === 0) return [];
  const signed = await supabase.storage.from(BUCKET).createSignedUrls(rows.map((row) => row.storage_path), DISPLAY_URL_SECONDS);
  const urls = new Map((signed.data ?? []).map((item) => [item.path, item.signedUrl]));
  return rows.map((row) => toMedia(row, urls.get(row.storage_path) ?? null));
}

/** Versions successives d'une publication, la plus récente d'abord. Vide si la base n'a pas la migration 0008. */
export async function listPostVersions(postId: string): Promise<PostVersion[]> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("post_versions").select("version, text, due_at, assets, created_at").eq("post_id", postId).order("version", { ascending: false });
  if (isMissingSchema(error)) return [];
  if (error) throw new Error(`Lecture impossible (versions) : ${error.message}`);
  return data.map((row) => ({ version: row.version, text: row.text, dueAt: row.due_at, assets: row.assets ?? [], createdAt: row.created_at }));
}

/** Contenu du Studio dont est issue une publication Buffer, s'il y en a un. */
export async function findDraftForPost(bufferPostId: string): Promise<{ draftId: string; revision: number } | null> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("studio_variants").select("draft_id, studio_drafts(revision)").eq("buffer_post_id", bufferPostId).is("removed_at", null).maybeSingle();
  if (isMissingSchema(error)) return null;
  if (error) throw new Error(`Lecture impossible (origine d'une publication) : ${error.message}`);
  if (!data) return null;
  const parent = data.studio_drafts as unknown as { revision: number } | { revision: number }[] | null;
  const revision = Array.isArray(parent) ? parent[0]?.revision : parent?.revision;
  return { draftId: data.draft_id, revision: revision ?? 0 };
}

export interface PushResult {
  ok: boolean;
  message: string;
  code?: string;
  expired?: boolean;
  /** Brouillons créés dans Buffer. */
  created: number;
  /** Brouillons existants mis à jour dans Buffer. */
  updated: number;
  /** Envois refusés ou échoués avec certitude (renvoi possible). */
  failed: number;
  /** Envois dont le résultat est inconnu : réconciliation avec Buffer requise avant tout renvoi. */
  unknown?: number;
  /** Brouillons dont l'entrée dans le circuit de validation du client est vérifiée. */
  submitted?: number;
}

/** Photographie de ce qui est envoyé : tout vient de la réservation, rien n'est relu ailleurs. */
interface ClaimedVariant {
  variant_id: string;
  channel_id: string;
  buffer_channel_id: string;
  service: string;
  text: string;
  buffer_post_id: string | null;
  revision: number;
  due_at: string;
  hashtags: string[];
  media_ids: string[];
  organization_id: string;
  /** Identité de CETTE tentative : toute réponse tardive d'une autre tentative est reconnue comme telle. */
  attempt_id: string | null;
}

const describe = (error: unknown) => (error instanceof Error ? (error.name === "TimeoutError" ? "Buffer ne répond pas (délai dépassé)." : error.message) : String(error));

const retryHint = (error: ProviderError) =>
  error.kind === "rate_limit" ? ` Quota Buffer atteint${error.retryAfterSeconds ? ` : réessayez dans ${Math.ceil(error.retryAfterSeconds / 60)} min` : ""}.` : "";

/**
 * Envoie un contenu en validation : crée (ou met à jour) un brouillon tagué par canal dans Buffer.
 *
 * Cohérence : la base réserve les textes ET renvoie, dans la même opération verrouillée, la révision,
 * la date, les hashtags et les médias. L'envoi n'utilise que cette photographie : une modification
 * enregistrée pendant l'envoi ne peut pas se mélanger à l'ancien contenu.
 *
 * Anti-doublon : un brouillon créé n'est jamais recréé (identifiant retenu). Si Buffer n'a pas répondu à
 * une création, le résultat est INCONNU : aucun nouvel essai automatique, il faut interroger Buffer
 * (reconcileDraftPush) puisque rien ne prouve que Buffer dédoublonne.
 *
 * Rien n'est programmé ici : le brouillon suit ensuite le circuit habituel.
 */
export async function pushDraftToBuffer(draftId: string): Promise<PushResult> {
  const empty = { created: 0, updated: 0, failed: 0, unknown: 0, submitted: 0 };
  const supabase = await createSessionClient();
  const provider = getProvider();

  /** Tentative courante de chaque variante réservée : toute confirmation la représente. */
  const attempts = new Map<string, string | null>();
  const complete = (variantId: string, ok: boolean, bufferPostId: string | null, revision: number | null, error: string | null = null, uncertain = false) =>
    supabase.rpc("studio_complete_push", {
      p_variant_id: variantId, p_ok: ok, p_buffer_post_id: bufferPostId, p_error: error, p_revision: revision,
      ...(uncertain ? { p_uncertain: true } : {}),
      ...(attempts.get(variantId) ? { p_attempt_id: attempts.get(variantId) } : {}),
    });
  /** L'enregistrement local d'une création réussie est retenté : l'identifiant du brouillon ne doit pas se perdre. */
  const completeWithRetry = async (variantId: string, bufferPostId: string, revision: number) => {
    let last = await complete(variantId, true, bufferPostId, revision);
    for (let attempt = 0; attempt < 2 && last.error; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      last = await complete(variantId, true, bufferPostId, revision);
    }
    return last;
  };

  // Contrôle préalable (sans rien réserver) : refus rapide d'un contenu incomplet.
  const draft = await getStudioDraft(draftId);
  if (!draft) return { ...studioFailure("not_found"), ...empty };
  const channels = await listChannels();
  const slots = channels
    .filter((channel) => channel.organizationId === draft.organizationId)
    .map((channel) => ({ id: channel.id, network: toNetwork(channel.service), name: channel.displayName ?? channel.name, isDisconnected: channel.isDisconnected }));
  const firstMedia = await listMedia(draft.organizationId, draft.mediaIds);
  const firstOrdered = draft.mediaIds.map((id) => firstMedia?.find((item) => item.id === id)).filter((item): item is MediaAsset => !!item);
  if (firstOrdered.length !== draft.mediaIds.length) return { ok: false, message: "Un média de ce contenu est introuvable.", ...empty };
  const early = validateDraft({ dueAt: draft.dueAt, hashtags: draft.hashtags, media: firstOrdered as StudioMedia[], variants: draft.variants }, slots, new Date().toISOString());
  if (hasBlockingIssue(early)) return { ok: false, message: early.find((issue) => issue.level === "error")!.message, ...empty };

  // Profil pilote : échéance d'au moins 24 h à chaque envoi (et non seulement à la rédaction).
  if (env.profile === "pilot" && !pilotLeadSatisfied(draft.dueAt)) {
    return { ok: false, code: "pilot_lead", message: "Profil pilote : la date prévue doit être à plus de 24 heures. Déplacez la date avant l'envoi.", ...empty };
  }
  // Une pause de quota s'applique aussi aux actions manuelles qui écrivent dans Buffer.
  const pause = await activeRateLimitPause(provider.mode);
  if (pause) return { ok: false, code: "quota_paused", message: pauseMessage(pause), ...empty };

  const claim = await supabase.rpc("studio_claim_push", { p_draft_id: draftId, p_force: false });
  if (claim.error) return { ...studioFailure(claim.error.message), ...empty };
  const claimed = (claim.data ?? []) as ClaimedVariant[];
  for (const row of claimed) attempts.set(row.variant_id, row.attempt_id ?? null);
  if (claimed.length === 0) return { ok: true, message: "Ce contenu est déjà à jour dans Buffer.", ...empty };

  /** Libère toutes les réservations avec un échec certain (rien n'est parti chez Buffer). */
  const releaseAll = async (message: string, code?: string): Promise<PushResult> => {
    for (const row of claimed) await complete(row.variant_id, false, row.buffer_post_id, null, message);
    return { ok: false, message, code, ...empty, failed: claimed.length };
  };

  // Contrôles refaits sur la photographie réservée (et non sur la lecture précédente).
  const snap = claimed[0];
  const media = await listMedia(snap.organization_id, snap.media_ids).catch(() => null);
  const ordered = snap.media_ids.map((id) => media?.find((item) => item.id === id)).filter((item): item is MediaAsset => !!item);
  if (ordered.length !== snap.media_ids.length) return releaseAll("Un média de ce contenu est introuvable.");
  const issues = validateDraft(
    { dueAt: snap.due_at, hashtags: snap.hashtags, media: ordered as StudioMedia[], variants: claimed.map((row) => ({ channelId: row.channel_id, text: row.text })) },
    slots,
    new Date().toISOString(),
  );
  if (hasBlockingIssue(issues)) return releaseAll(issues.find((issue) => issue.level === "error")!.message);

  // Adresses que Buffer utilisera pour télécharger les médias.
  let assets: DraftContent["assets"] = [];
  if (ordered.length > 0) {
    const { data: rows } = await supabase.from("media_assets").select("id, storage_path").in("id", snap.media_ids);
    const paths = new Map((rows ?? []).map((row) => [row.id as string, row.storage_path as string]));
    const signed = await supabase.storage.from(BUCKET).createSignedUrls(ordered.map((item) => paths.get(item.id) ?? ""), BUFFER_URL_SECONDS);
    const urls = new Map((signed.data ?? []).map((item) => [item.path, item.signedUrl]));
    assets = ordered.map((item) => ({ type: item.kind, url: urls.get(paths.get(item.id) ?? "") ?? "" }));
    if (signed.error || assets.some((asset) => !asset.url)) return releaseAll("Les médias n'ont pas pu être préparés pour Buffer. Réessayez.");
  }

  const result = { ...empty };
  const pushedIds: string[] = [];
  /** Brouillons créés par une tentative qui n'est plus la courante : consignés, à supprimer dans Buffer. */
  const orphaned: string[] = [];
  /** Texte exact envoyé pour chaque brouillon : sert à vérifier que Buffer, relu, porte bien CETTE version. */
  const pushedText = new Map<string, string>();
  /** Date envoyée : la ligne observée doit la porter aussi (une ancienne ligne locale ne vaut pas soumission). */
  const pushedDue = Date.parse(claimed[0].due_at);
  let blocked: string | null = null;
  let rateLimited: ProviderError | null = null;

  for (const row of claimed) {
    if (blocked) {
      result.failed += 1;
      await complete(row.variant_id, false, row.buffer_post_id, null, blocked);
      continue;
    }
    /**
     * Identifiant d'un post créé ou mis à jour pendant CETTE tentative. L'ancien identifiant enregistré (qui
     * peut désigner un brouillon supprimé dans Buffer) n'en fait pas partie : il ne prouve rien d'une création.
     */
    let createdId: string | null = null;
    let creating = false;
    try {
      const content: DraftContent = { channelId: row.buffer_channel_id, service: row.service, text: composeText(row.text, snap.hashtags), dueAt: snap.due_at, assets };
      const live = row.buffer_post_id ? await provider.getPost(row.buffer_post_id) : null;
      if (live && (live.status === "sent" || live.status === "sending")) throw new ProviderError("Cette publication est déjà publiée : elle ne peut plus être modifiée.");
      creating = !live;
      // Le brouillon a été supprimé à la main dans Buffer : il est recréé (la tentative est conservée en base).
      const post = live ? await provider.updateDraft(live.id, content) : await provider.createDraft(content);
      createdId = post.id;
      const saved = await completeWithRetry(row.variant_id, post.id, row.revision);
      if (saved.error) throw new Error(`Le brouillon existe dans Buffer mais n'a pas pu être enregistré ici : ${saved.error.message}`);
      // Création d'une tentative qui n'est plus la courante : consignée comme brouillon orphelin, jamais rattachée.
      if (saved.data === "orphan") {
        orphaned.push(post.id);
      }
      if (saved.data === "orphan") throw new Error("Le brouillon créé dans Buffer ne correspond plus à la tentative en cours : il est consigné comme orphelin (à supprimer dans Buffer).");
      pushedIds.push(post.id);
      pushedText.set(post.id, content.text);
      if (live) result.updated += 1;
      else result.created += 1;
    } catch (error) {
      createdId = (error instanceof ProviderError ? error.createdPostId : undefined) ?? createdId;
      // Une création dont la réponse est perdue n'est ni un succès ni un échec : on ne sait pas. Même si un ancien
      // identifiant était connu : seul un identifiant obtenu pendant cette tentative lève l'incertitude.
      // Pendant une CRÉATION, seul un échec prouvé sans effet (refus typé, quota, clé refusée, avant l'envoi) est
      // certain : toute autre erreur — réponse perdue, illisible, exception inattendue — est un résultat inconnu.
      const certainFailure = error instanceof ProviderError && error.outcome === "failed";
      const uncertain = creating && !createdId && !certainFailure;
      if (uncertain) result.unknown += 1;
      else result.failed += 1;
      // Panne ou quota : inutile d'insister sur les canaux suivants.
      if (error instanceof ProviderError && error.kind !== "api" && !error.connectionId) blocked = describe(error) + retryHint(error);
      if (error instanceof ProviderError && error.kind === "rate_limit" && !error.connectionId) rateLimited ??= error;
      // Un échec de MISE À JOUR garde l'identifiant connu ; une CRÉATION sans identifiant obtenu n'en transmet aucun
      // (l'ancien identifiant, peut-être supprimé dans Buffer, ne dit rien de ce que cette tentative a créé).
      await complete(row.variant_id, false, createdId ?? (creating ? null : row.buffer_post_id), null, describe(error) + (error instanceof ProviderError ? retryHint(error) : ""), uncertain);
    }
  }
  if (rateLimited) await recordRateLimit(rateLimited, provider.mode);

  // Relecture immédiate de Buffer : les brouillons créés entrent dans le circuit de validation.
  // Le message ne l'affirme qu'une fois vérifié dans la base, et pour CETTE version du texte : une ancienne ligne
  // locale encore « en attente » ne vaut pas soumission de la nouvelle révision.
  let syncError: string | null = null;
  if (pushedIds.length > 0) {
    const startedAt = Date.now() - 1000;
    const sync = await runSync("studio").catch((error: unknown) => ({ ok: false, error: describe(error) }));
    if (!sync.ok) syncError = sync.error ?? "synchronisation incomplète";
    const { data: seen } = await supabase
      .from("posts")
      .select("buffer_post_id, approval_status, text, synced_at, due_at, owner_organization_id, ownership, removed_at, has_review_tag, buffer_status")
      .in("buffer_post_id", pushedIds);
    const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim();
    result.submitted = (seen ?? []).filter((row) => {
      if (row.approval_status !== "pending") return false;
      // Éligibilité à la validation : propriétaire connu et conforme, non retiré, tag posé, toujours en brouillon.
      if (row.ownership !== "assigned" || row.owner_organization_id !== snap.organization_id || row.removed_at !== null) return false;
      if (row.has_review_tag === false || (row.buffer_status !== undefined && !["draft", "needs_approval"].includes(row.buffer_status as string))) return false;
      if (typeof row.due_at === "string" && Number.isFinite(pushedDue) && Date.parse(row.due_at) !== pushedDue) return false;
      const wanted = pushedText.get(row.buffer_post_id as string);
      if (typeof row.text === "string" && wanted !== undefined && normalize(row.text) !== normalize(wanted)) return false;
      // Une relecture en échec ne confirme que ce qui a été relu depuis le début de cet envoi.
      const fresh = typeof row.synced_at === "string" && Date.parse(row.synced_at) >= startedAt;
      return sync.ok || fresh;
    }).length;
  }

  const done = result.created + result.updated;
  const s = (n: number) => (n > 1 ? "s" : "");
  const parts: string[] = [];
  if (done > 0) {
    parts.push(
      `${done} brouillon${s(done)} ${result.created > 0 ? "créé" : "mis à jour"}${s(done)} dans Buffer`,
    );
  }
  const submissionOk = done === 0 || result.submitted === done;
  if (done > 0) {
    parts[0] += submissionOk
      ? " et soumis au client."
      : ` ; la soumission au client n'est pas confirmée (${result.submitted}/${done} en attente de décision${syncError ? ` — ${syncError}` : ""}). Lancez une synchronisation.`;
  }
  if (result.unknown > 0) {
    parts.push(`${result.unknown} canal${result.unknown > 1 ? "aux" : ""} à résultat inconnu : Buffer n'a pas répondu, le brouillon existe peut-être. Utilisez « Vérifier dans Buffer » avant tout renvoi.`);
  }
  if (orphaned.length > 0) {
    parts.push(`${orphaned.length} brouillon${orphaned.length > 1 ? "s" : ""} orphelin${orphaned.length > 1 ? "s" : ""} créé${orphaned.length > 1 ? "s" : ""} dans Buffer sans tentative correspondante (consigné${orphaned.length > 1 ? "s" : ""}) : à supprimer dans Buffer avant tout renvoi.`);
  }
  if (result.failed > 0) {
    parts.push(`${result.failed} canal${result.failed > 1 ? "aux" : ""} en échec${blocked ? ` : ${blocked}` : ". Le détail figure sur chaque canal ; rien n'a été créé en double."}`);
  }
  const ok = result.failed === 0 && result.unknown === 0 && submissionOk;
  return { ok, ...result, code: result.unknown > 0 ? "push_unknown" : !submissionOk ? "submission_unconfirmed" : undefined, message: parts.join(" ") };
}

/**
 * Réconciliation après un résultat inconnu : interroge Buffer (lecture seule) pour savoir si le brouillon
 * a été créé. Trouvé → adopté (il sera mis à jour, jamais recréé). Absent après le délai de sécurité et
 * lecture complète → un nouvel envoi est de nouveau possible. Ambigu → intervention manuelle.
 */
export async function reconcileDraftPush(draftId: string): Promise<PushResult> {
  const empty = { created: 0, updated: 0, failed: 0, unknown: 0, submitted: 0 };
  const supabase = await createSessionClient();
  const provider = getProvider();
  const draft = await getStudioDraft(draftId);
  if (!draft) return { ...studioFailure("not_found"), ...empty };

  // Un envoi abandonné (processus arrêté après l'appel à Buffer) est, par nature, de résultat inconnu.
  const expired = await supabase.rpc("studio_expire_abandoned", { p_draft_id: draftId });
  if (expired.error) return { ...studioFailure(expired.error.message), ...empty };

  // Toutes les variantes du contenu, y compris celles retirées depuis : la tentative reste à résoudre.
  const { data: rows, error } = await supabase.from("studio_variants").select("id, channel_id, push_attempt").eq("draft_id", draftId).eq("push_state", "unknown");
  if (error) return { ok: false, message: `Lecture impossible : ${error.message}`, ...empty };
  if (!rows || rows.length === 0) return { ok: true, message: "Aucun envoi à résultat inconnu pour ce contenu.", ...empty };

  // La réconciliation lit Buffer : elle respecte une pause de quota comme toute autre opération.
  const pause = await activeRateLimitPause(provider.mode);
  if (pause) return { ok: false, code: "quota_paused", message: pauseMessage(pause), ...empty, unknown: rows.length };

  const channels = await listChannels();
  type Attempt = { text: string; dueAt: string; hashtags: string[]; bufferChannelId?: string; assetKinds?: string[] };
  const messages: string[] = [];
  let unresolved = 0;
  let code: string = "push_unknown";
  for (const variant of rows) {
    const attempt = variant.push_attempt as Attempt | null;
    const channelId = (variant as { channel_id?: string }).channel_id ?? draft.variants.find((item) => item.id === variant.id)?.channelId;
    const bufferChannelId = attempt?.bufferChannelId ?? channels.find((item) => item.id === channelId)?.bufferChannelId;
    if (!attempt || !bufferChannelId) {
      unresolved += 1;
      messages.push("Une tentative n'a pas pu être retrouvée : vérifiez dans Buffer.");
      continue;
    }
    let found: { candidates: ProviderPost[]; possible?: ProviderPost[]; complete: boolean };
    try {
      found = await provider.findDraftCandidates({
        channelId: bufferChannelId, text: composeText(attempt.text, attempt.hashtags), dueAt: attempt.dueAt, assetKinds: attempt.assetKinds,
      });
    } catch (cause) {
      unresolved += 1;
      if (cause instanceof ProviderError && cause.kind === "rate_limit") await recordRateLimit(cause, provider.mode);
      messages.push(`Buffer n'a pas pu être interrogé : ${describe(cause)}`);
      continue;
    }
    // Les brouillons déjà rattachés à un autre canal/contenu ne sont pas des candidats.
    const ids = [...found.candidates, ...(found.possible ?? [])].map((post) => post.id);
    const known = ids.length > 0 ? await supabase.from("studio_variants").select("buffer_post_id").in("buffer_post_id", ids) : { data: [] as { buffer_post_id: string }[], error: null };
    // Les identifiants déjà pris ne peuvent pas être lus : aucune adoption, et rien n'est libéré.
    if (known.error) {
      unresolved += 1;
      messages.push(`Les brouillons déjà rattachés n'ont pas pu être lus (${known.error.message}) : aucune adoption n'a été tentée.`);
      continue;
    }
    const taken = new Set((known.data ?? []).map((row) => row.buffer_post_id as string));
    const candidates = found.candidates.filter((post) => !taken.has(post.id));
    const possible = (found.possible ?? []).filter((post) => !taken.has(post.id));

    // Adoption automatique seulement pour une correspondance exacte, unique, encore en brouillon, SANS média : l'identité
    // des médias ne se prouve pas (adresses réhébergées). Sinon une personne tranche, et rien n'est rattaché seul.
    const mediaCount = attempt.assetKinds?.length ?? 0;
    const adoptable = candidates.length === 1 && possible.length === 0 && mediaCount === 0 && ["draft", "needs_approval"].includes(candidates[0].status);
    if (candidates.length === 1 && possible.length === 0 && !adoptable) {
      unresolved += 1;
      messages.push(
        mediaCount > 0
          ? "Un brouillon correspond au texte, au canal et à la date, mais l'identité de ses médias ne peut pas être prouvée : vérifiez-le dans Buffer avant de décider."
          : `Un brouillon correspond mais son statut est « ${candidates[0].status} » : ne le rattachez pas automatiquement, vérifiez-le dans Buffer.`,
      );
    } else if (adoptable) {
      const resolved = await supabase.rpc("studio_resolve_unknown", { p_variant_id: variant.id, p_buffer_post_id: candidates[0].id, p_confirmed_absent: false });
      if (resolved.error) { unresolved += 1; messages.push(studioFailure(resolved.error.message).message); continue; }
      messages.push(candidates[0].status === "sent" || candidates[0].status === "error"
        ? `Brouillon retrouvé dans Buffer (statut « ${candidates[0].status} ») : vérifiez-le dans Buffer, il ne sera pas recréé.`
        : "Brouillon retrouvé dans Buffer : il sera mis à jour au prochain envoi, sans être recréé.");
    } else if (candidates.length + possible.length > 0) {
      // Plusieurs correspondances ou ressemblances (texte modifié, médias différents…) : à trancher par une personne.
      unresolved += 1;
      messages.push(`${candidates.length + possible.length} brouillon${candidates.length + possible.length > 1 ? "s" : ""} ressemblant${candidates.length + possible.length > 1 ? "s" : ""} dans Buffer pour ce canal : vérifiez-les dans Buffer (supprimez les doublons ou le brouillon en trop), puis relancez la vérification.`);
    } else {
      // Aucune correspondance : cela NE prouve PAS l'absence (lecture limitée, texte modifié dans Buffer, médias).
      unresolved += 1;
      code = "push_absent_unproven";
      messages.push(found.complete
        ? "Aucune correspondance trouvée dans Buffer, mais Cadence ne peut pas en conclure qu'aucun brouillon n'existe (texte modifié, lecture limitée). Vérifiez dans Buffer, puis confirmez l'absence."
        : "La lecture de Buffer est incomplète : aucune correspondance trouvée, sans preuve d'absence. Vérifiez dans Buffer, puis confirmez l'absence.");
    }
  }
  return { ok: unresolved === 0, ...empty, unknown: unresolved, code: unresolved > 0 ? code : undefined, message: messages.join(" ") };
}

/**
 * Confirmation HUMAINE qu'aucun brouillon ne correspond dans Buffer : la seule voie qui rend un nouvel envoi
 * possible après un résultat inconnu sans retrouver le brouillon. Cadence ne la déduit jamais d'une recherche.
 */
export async function confirmDraftAbsent(draftId: string, evidence: string): Promise<PushResult> {
  const empty = { created: 0, updated: 0, failed: 0, unknown: 0, submitted: 0 };
  const supabase = await createSessionClient();
  const expired = await supabase.rpc("studio_expire_abandoned", { p_draft_id: draftId });
  if (expired.error) return { ...studioFailure(expired.error.message), ...empty };
  const { data: rows, error } = await supabase.from("studio_variants").select("id").eq("draft_id", draftId).eq("push_state", "unknown");
  if (error) return { ok: false, message: `Lecture impossible : ${error.message}`, ...empty };
  if (!rows || rows.length === 0) return { ok: true, message: "Aucun envoi à résultat inconnu pour ce contenu.", ...empty };
  let refused: string | null = null;
  for (const row of rows) {
    const resolved = await supabase.rpc("studio_resolve_unknown", { p_variant_id: row.id, p_buffer_post_id: null, p_confirmed_absent: true, p_operator_confirmed: true, p_evidence: evidence });
    if (resolved.error) refused = resolved.error.message;
  }
  if (refused) return { ...studioFailure(refused), ...empty, unknown: rows.length };
  return { ok: true, ...empty, message: "Absence confirmée : le contenu peut être renvoyé." };
}
