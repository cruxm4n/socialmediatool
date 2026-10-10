import { STUDIO_MIN_LEAD_MS } from "@/lib/domain/schedule-margins";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import type { Network } from "@/lib/types";

/*
 * Content Studio : hashtags, formats acceptés par réseau, contrôles avant envoi, conflits de calendrier.
 * Règles pures, sans réseau ni base.
 *
 * Les limites ci-dessous sont celles publiées par les réseaux à la date d'écriture (octobre 2026).
 * Elles servent à prévenir tôt ; Buffer reste juge au moment de créer le brouillon.
 */

export interface NetworkRules {
  maxChars: number;
  maxHashtags: number | null;
  /** Nombre maximal de médias dans une publication (au-delà de 1 : carrousel). */
  maxMedia: number;
  requiresMedia: boolean;
  /** true : un seul type de média par publication (pas d'image et de vidéo mêlées). */
  noMixedMedia: boolean;
  /** true : n'accepte que la vidéo. */
  videoOnly?: boolean;
  maxVideoSeconds: number;
  allowsGif: boolean;
  /** Au-delà : simple avertissement (limite d'usage du réseau, non imposée par Buffer). */
  warnHashtags?: number;
}

export const NETWORK_RULES: Record<Network, NetworkRules> = {
  // Limites de caractères : Buffer, https://developers.buffer.com/guides/character-limits.html (10 octobre 2026).
  // LinkedIn : Buffer annonce davantage d'images ; 9 reste une borne prudente (jamais un refus à tort côté Buffer).
  linkedin: { maxChars: 3000, maxHashtags: null, maxMedia: 9, requiresMedia: false, noMixedMedia: true, maxVideoSeconds: 600, allowsGif: true },
  instagram: { maxChars: 2196, maxHashtags: 30, warnHashtags: 5, maxMedia: 10, requiresMedia: true, noMixedMedia: false, maxVideoSeconds: 900, allowsGif: false },
  facebook: { maxChars: 5000, maxHashtags: null, maxMedia: 10, requiresMedia: false, noMixedMedia: true, maxVideoSeconds: 14400, allowsGif: true },
  tiktok: { maxChars: 2200, maxHashtags: null, maxMedia: 1, requiresMedia: true, noMixedMedia: true, videoOnly: true, maxVideoSeconds: 600, allowsGif: false },
  twitter: { maxChars: 280, maxHashtags: null, maxMedia: 4, requiresMedia: false, noMixedMedia: true, maxVideoSeconds: 140, allowsGif: true },
  other: { maxChars: 3000, maxHashtags: null, maxMedia: 4, requiresMedia: false, noMixedMedia: true, maxVideoSeconds: 600, allowsGif: true },
};

/** Types de fichiers acceptés au dépôt (les mêmes que l'espace de stockage). */
export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime"] as const;
/** Limite de l'espace de stockage, par fichier. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Au-delà, une image est refusée par plusieurs réseaux. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface StudioMedia {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fileName: string;
}

export interface Issue {
  level: "error" | "warning";
  message: string;
}

// --- Hashtags ----------------------------------------------------------------

/** « Café de spécialité » → « #Cafédespécialité ». null si rien d'utilisable. */
export function normalizeHashtag(input: string): string | null {
  const cleaned = input.normalize("NFC").replace(/[^\p{L}\p{N}_]/gu, "");
  return cleaned.length > 0 && cleaned.length <= 79 ? `#${cleaned}` : null;
}

/** Découpe une saisie libre (« #café, torréfaction lyon ») en hashtags uniques, dans l'ordre. */
export function parseHashtags(input: string): string[] {
  return dedupeHashtags(input.split(/[\s,;]+/).map(normalizeHashtag).filter((tag): tag is string => tag !== null));
}

export function dedupeHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLocaleLowerCase("fr");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;

/** Hashtags déjà écrits dans le texte. */
export function hashtagsIn(text: string): string[] {
  return text.match(HASHTAG_PATTERN) ?? [];
}

/** Texte publié : le texte du réseau, puis les hashtags communs qu'il ne contient pas déjà. */
export function composeText(text: string, hashtags: string[]): string {
  const body = text.trimEnd();
  const present = new Set(hashtagsIn(body).map((tag) => tag.toLocaleLowerCase("fr")));
  const extra = dedupeHashtags(hashtags).filter((tag) => !present.has(tag.toLocaleLowerCase("fr")));
  if (extra.length === 0) return body;
  return body.length > 0 ? `${body}\n\n${extra.join(" ")}` : extra.join(" ");
}

/** Longueur comptée comme le font les réseaux : en caractères visibles, pas en unités UTF-16. */
export function textLength(text: string): number {
  return [...text].length;
}

// --- Contrôles ---------------------------------------------------------------

export function validateFile(file: { type: string; size: number; name: string }): Issue | null {
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { level: "error", message: `« ${file.name} » : format non pris en charge. Formats acceptés : JPEG, PNG, WebP, GIF, MP4, MOV.` };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { level: "error", message: `« ${file.name} » dépasse 50 Mo, la limite de l'espace de stockage.` };
  }
  return null;
}

/** Ce qui empêche (erreur) ou risque de gêner (avertissement) la publication de ce texte et de ces médias sur ce réseau. */
export function validateVariant(network: Network, text: string, hashtags: string[], media: StudioMedia[]): Issue[] {
  const rules = NETWORK_RULES[network];
  const label = NETWORK_LABELS[network];
  const issues: Issue[] = [];
  const full = composeText(text, hashtags);
  const length = textLength(full);
  const images = media.filter((item) => item.kind === "image");
  const videos = media.filter((item) => item.kind === "video");

  if (length === 0 && media.length === 0) issues.push({ level: "error", message: `${label} : ajoutez un texte ou un média.` });
  if (length > rules.maxChars) {
    issues.push({ level: "error", message: `${label} : ${length} caractères, ${length - rules.maxChars} de trop (maximum ${rules.maxChars}, hashtags compris).` });
  }
  const tagCount = hashtagsIn(full).length;
  if (rules.maxHashtags !== null && tagCount > rules.maxHashtags) {
    issues.push({ level: "error", message: `${label} : ${tagCount} hashtags, maximum ${rules.maxHashtags}.` });
  }
  if (rules.warnHashtags !== undefined && tagCount > rules.warnHashtags && (rules.maxHashtags === null || tagCount <= rules.maxHashtags)) {
    issues.push({ level: "warning", message: `${label} : ${tagCount} hashtags ; le réseau n'en accepte plus que ${rules.warnHashtags} par publication, au-delà ils peuvent être ignorés.` });
  }
  if (rules.requiresMedia && media.length === 0) {
    issues.push({ level: "error", message: `${label} : un média est obligatoire${rules.videoOnly ? " (vidéo)" : ""}.` });
  }
  if (rules.videoOnly && images.length > 0) issues.push({ level: "error", message: `${label} : seules les vidéos sont acceptées.` });
  if (media.length > rules.maxMedia) {
    issues.push({ level: "error", message: `${label} : ${media.length} médias, maximum ${rules.maxMedia}.` });
  }
  if (rules.noMixedMedia && images.length > 0 && videos.length > 0) {
    issues.push({ level: "error", message: `${label} : images et vidéo ne peuvent pas être mêlées dans une même publication.` });
  }
  if (rules.noMixedMedia && videos.length > 1) issues.push({ level: "error", message: `${label} : une seule vidéo par publication.` });

  for (const item of media) {
    if (item.mimeType === "image/gif" && !rules.allowsGif) issues.push({ level: "error", message: `${label} : les GIF ne sont pas acceptés (« ${item.fileName} »).` });
    if (item.mimeType === "image/webp") issues.push({ level: "warning", message: `${label} : le format WebP n'est pas accepté partout ; préférez JPEG ou PNG (« ${item.fileName} »).` });
    if (item.kind === "image" && item.sizeBytes > MAX_IMAGE_BYTES) {
      issues.push({ level: "warning", message: `${label} : image de plus de 8 Mo, elle risque d'être refusée (« ${item.fileName} »).` });
    }
    if (item.kind === "video" && item.durationMs !== null && item.durationMs > rules.maxVideoSeconds * 1000) {
      issues.push({ level: "error", message: `${label} : vidéo de ${Math.round(item.durationMs / 1000)} s, maximum ${rules.maxVideoSeconds} s (« ${item.fileName} »).` });
    }
    if (network === "instagram" && item.width && item.height) {
      const ratio = item.width / item.height;
      if (ratio < 0.8 - 0.01 || ratio > 1.91 + 0.01) {
        issues.push({ level: "warning", message: `Instagram : « ${item.fileName} » sera recadré (format accepté entre 4:5 et 1,91:1).` });
      }
    }
  }
  return issues;
}

export interface ChannelSlot {
  id: string;
  network: Network;
  name: string;
  isDisconnected: boolean;
}

export interface DraftInput {
  dueAt: string | null;
  hashtags: string[];
  media: StudioMedia[];
  variants: { channelId: string; text: string }[];
}

/** Délai minimal avant la date prévue pour envoyer en validation : il faut laisser au client le temps de répondre. */
export const MIN_LEAD_MS = STUDIO_MIN_LEAD_MS;

/** Tous les contrôles d'un contenu avant son envoi en validation. */
export function validateDraft(draft: DraftInput, channels: ChannelSlot[], now: string): Issue[] {
  const issues: Issue[] = [];
  if (draft.variants.length === 0) issues.push({ level: "error", message: "Choisissez au moins un canal." });
  if (!draft.dueAt) issues.push({ level: "error", message: "Choisissez la date et l'heure de publication." });
  else if (Date.parse(draft.dueAt) <= Date.parse(now) + MIN_LEAD_MS) issues.push({ level: "error", message: "La date de publication est passée ou trop proche." });

  for (const variant of draft.variants) {
    const channel = channels.find((item) => item.id === variant.channelId);
    if (!channel) {
      issues.push({ level: "error", message: "Un canal sélectionné n'appartient plus à ce client." });
      continue;
    }
    if (channel.isDisconnected) issues.push({ level: "error", message: `${channel.name} est déconnecté dans Buffer : reconnectez-le avant d'envoyer.` });
    issues.push(...validateVariant(channel.network, variant.text, draft.hashtags, draft.media));
  }
  return issues;
}

export const hasBlockingIssue = (issues: Issue[]) => issues.some((issue) => issue.level === "error");

// --- Conflits de calendrier ---------------------------------------------------

/** Deux publications du même canal à moins de ce délai : probablement une erreur. */
export const CONFLICT_WINDOW_MS = 30 * 60_000;

export interface ScheduledItem {
  id: string;
  channelId: string;
  dueAt: string | null;
  title: string;
}

/** Publications déjà prévues sur les mêmes canaux, trop près de la date envisagée. */
export function findConflicts(dueAt: string | null, channelIds: string[], scheduled: ScheduledItem[], ignoreIds: string[] = []): ScheduledItem[] {
  if (!dueAt) return [];
  const target = Date.parse(dueAt);
  return scheduled.filter(
    (item) =>
      item.dueAt !== null &&
      channelIds.includes(item.channelId) &&
      !ignoreIds.includes(item.id) &&
      Math.abs(Date.parse(item.dueAt) - target) < CONFLICT_WINDOW_MS,
  );
}

/** Un déplacement dans le calendrier garde l'heure et change le jour. Refusé vers le passé. */
export function canMoveTo(newDueAt: string, now: string): boolean {
  return Date.parse(newDueAt) > Date.parse(now) + MIN_LEAD_MS;
}

/** Refus des fonctions SQL du Studio, en clair. */
export const STUDIO_ERRORS: Record<string, string> = {
  forbidden: "Réservé à l'administrateur.",
  not_found: "Ce contenu est introuvable.",
  organization_unavailable: "Ce client est introuvable ou archivé.",
  draft_archived: "Ce contenu est archivé : restaurez-le pour le modifier.",
  stale_revision: "Ce contenu a été modifié ailleurs (autre onglet ?). Rechargez la page pour repartir de la dernière version.",
  invalid_hashtags: "Trop de hashtags, ou un hashtag trop long.",
  too_many_media: "Vingt médias au plus par contenu.",
  invalid_media: "Un média sélectionné n'appartient pas à ce client.",
  invalid_channel: "Un canal sélectionné n'appartient pas (ou plus) à ce client.",
  text_too_long: "Un texte est trop long.",
  variant_in_buffer: "Ce canal a déjà son brouillon dans Buffer : il ne peut plus être retiré d'ici. Supprimez le brouillon dans Buffer si nécessaire.",
  date_invalid: "La date de publication est absente, passée ou trop proche.",
  no_variant: "Choisissez au moins un canal.",
  push_in_progress: "Un envoi est déjà en cours pour ce contenu.",
  push_unknown: "Buffer n'a pas répondu à une création : le brouillon existe peut-être. Utilisez « Vérifier dans Buffer » avant de renvoyer.",
  unknown_too_recent: "L'envoi est trop récent pour conclure : une réponse tardive de Buffer est encore possible. Réessayez dans quelques minutes.",
  buffer_post_taken: "Ce brouillon Buffer est déjà rattaché à un autre contenu.",
  push_uncertain: "Un envoi précédent s'est interrompu : on ignore si Buffer a créé le brouillon. Utilisez « Vérifier dans Buffer » avant de renvoyer.",
  push_absent_unproven: "Aucun brouillon retrouvé, mais Cadence ne peut pas prouver qu'il n'existe pas. Vérifiez dans Buffer, puis confirmez l'absence.",
  absence_requires_operator: "L'absence d'un brouillon ne peut être confirmée que par une personne ayant vérifié dans Buffer.",
  invalid_media_type: "Format de fichier non pris en charge.",
  invalid_media_size: "Fichier vide ou de plus de 50 Mo.",
  invalid_media_path: "Emplacement de fichier refusé.",
  media_not_uploaded: "Le fichier n'a pas été reçu par l'espace de stockage. Réessayez.",
};
