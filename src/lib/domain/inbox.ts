import { SCHEDULING_MIN_LEAD_MS } from "@/lib/domain/schedule-margins";
import type { Tone } from "@/lib/domain/status";
import type { Post } from "@/lib/types";

/*
 * « À traiter » : ce qui demande une action de l'administrateur, regroupé par nature.
 * Règles pures. Une publication n'apparaît que dans une catégorie, la plus grave.
 */

export const INBOX_KEYS = ["errors", "unvalidated", "late", "attribution", "changes", "pending"] as const;
export type InboxKey = (typeof INBOX_KEYS)[number];

export const INBOX_META: Record<InboxKey, { label: string; hint: string; tone: Tone }> = {
  errors: { label: "Erreurs de programmation", hint: "Buffer refuse ou signale un échec : à corriger dans Buffer.", tone: "red" },
  unvalidated: { label: "Programmées sans validation", hint: "Programmées à la main dans Buffer, sans accord du client.", tone: "red" },
  late: { label: "En retard", hint: "La date prévue est passée et rien n'a été publié.", tone: "amber" },
  attribution: { label: "À attribuer à un client", hint: "Importées depuis un canal transféré ou détaché : visibles de vous seul tant qu'elles ne sont pas attribuées.", tone: "amber" },
  changes: { label: "Modifications demandées", hint: "Le client attend une nouvelle version.", tone: "rose" },
  pending: { label: "Validations en attente", hint: "Soumises au client, sans réponse pour l'instant.", tone: "amber" },
};

type InboxPost = Pick<Post, "id" | "bufferStatus" | "approvalStatus" | "scheduleState" | "dueAt" | "removedAt" | "submittedAt"> & Partial<Pick<Post, "ownership">>;

/** Une publication programmée n'est « en retard » qu'après ce délai : Buffer publie rarement à la seconde. */
const SENDING_GRACE_MS = 15 * 60_000;
/** Une validation approuvée doit être programmable : en dessous de ce délai la réservation la refuse. */
const SCHEDULING_LEAD_MS = SCHEDULING_MIN_LEAD_MS;
/** Une validation en attente devient urgente quand la date prévue approche. */
const URGENT_WITHIN_MS = 48 * 60 * 60_000;

export function inboxKeyOf(post: InboxPost, now: string): InboxKey | null {
  if (post.removedAt || post.bufferStatus === "sent") return null;
  const current = Date.parse(now);
  const due = post.dueAt ? Date.parse(post.dueAt) : null;
  const programmed = post.bufferStatus === "scheduled" || post.bufferStatus === "sending";

  if (post.bufferStatus === "error" || post.scheduleState === "failed") return "errors";
  if (programmed && post.approvalStatus !== "approved") return "unvalidated";
  if (programmed) return due !== null && due + SENDING_GRACE_MS < current ? "late" : null;
  // Approuvé mais plus programmable (échéance trop proche) : il ne partira pas sans intervention.
  if (post.approvalStatus === "approved" && due !== null && due <= current + SCHEDULING_LEAD_MS) return "late";
  // Import dont l'appartenance est ambiguë : l'administrateur doit l'attribuer.
  if (post.ownership === "ambiguous") return "attribution";
  // Brouillon dans le circuit de validation dont la date est passée : il ne pourra plus être programmé tel quel.
  if (post.approvalStatus !== "none" && due !== null && due <= current) return "late";
  if (post.approvalStatus === "changes_requested") return "changes";
  if (post.approvalStatus === "pending") return "pending";
  return null;
}

/** Validation en attente dont la publication est prévue dans les 48 heures. */
export function isUrgentPending(post: InboxPost, now: string): boolean {
  return inboxKeyOf(post, now) === "pending" && post.dueAt !== null && Date.parse(post.dueAt) - Date.parse(now) <= URGENT_WITHIN_MS;
}

export interface InboxGroup<T> {
  key: InboxKey;
  posts: T[];
  /** Parmi les validations en attente : celles dont la date approche. */
  urgent: number;
}

/** Groupes non vides, du plus grave au moins grave ; dans chaque groupe, la date prévue la plus proche d'abord. */
export function buildInbox<T extends InboxPost>(posts: T[], now: string): InboxGroup<T>[] {
  return INBOX_KEYS.map((key) => {
    const matching = posts
      .filter((post) => inboxKeyOf(post, now) === key)
      .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
    return { key, posts: matching, urgent: key === "pending" ? matching.filter((post) => isUrgentPending(post, now)).length : 0 };
  }).filter((group) => group.posts.length > 0);
}

/**
 * Adresse du canal dans Buffer, ouverte sur l'onglet où se trouve la publication.
 * L'API de Buffer ne fournit pas de lien direct vers une publication ; le canal et l'onglet sont
 * le lien le plus précis disponible. null pour les données simulées.
 */
export function bufferUrl(post: Pick<Post, "bufferPostId" | "bufferStatus">, bufferChannelId: string | null | undefined): string | null {
  if (!bufferChannelId || post.bufferPostId.startsWith("mock-") || bufferChannelId.startsWith("mock-")) return null;
  const base = `https://publish.buffer.com/channels/${encodeURIComponent(bufferChannelId)}`;
  if (post.bufferStatus === "draft" || post.bufferStatus === "needs_approval") return `${base}?tab=drafts`;
  if (post.bufferStatus === "sent") return `${base}?tab=sent`;
  return base;
}
