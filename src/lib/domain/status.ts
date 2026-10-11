import type { DisplayStatus, Post, PostEventType } from "@/lib/types";

export type Tone = "neutral" | "amber" | "rose" | "green" | "blue" | "red";

interface StatusMeta {
  label: string;
  description: string;
  tone: Tone;
}

export const STATUS_META: Record<DisplayStatus, StatusMeta> = {
  draft: {
    label: "Brouillon",
    description: "Brouillon dans Buffer, pas encore soumis au client.",
    tone: "neutral",
  },
  pending_approval: {
    label: "À valider",
    description: "Soumis au client, en attente de sa décision.",
    tone: "amber",
  },
  changes_requested: {
    label: "Modifications demandées",
    description: "Le client a demandé des ajustements.",
    tone: "rose",
  },
  approved: {
    label: "Approuvé",
    description: "Validé par le client, en attente de programmation dans Buffer.",
    tone: "green",
  },
  scheduled: {
    label: "Programmé",
    description: "Programmé dans Buffer à la date prévue.",
    tone: "blue",
  },
  published: {
    label: "Publié",
    description: "Publié sur le réseau par Buffer.",
    tone: "green",
  },
  error: {
    label: "Erreur",
    description: "Buffer signale une erreur, ou la programmation a échoué.",
    tone: "red",
  },
};

type StatusInput = Pick<Post, "bufferStatus" | "approvalStatus" | "scheduleState">;

/**
 * Statut unique affiché à l'écran.
 * Ce que dit Buffer (publié, programmé, erreur) l'emporte sur l'état de validation,
 * car c'est Buffer qui publie réellement.
 */
export function deriveStatus(post: StatusInput): DisplayStatus {
  if (post.bufferStatus === "sent") return "published";
  if (post.bufferStatus === "error" || post.scheduleState === "failed") return "error";
  if (post.bufferStatus === "scheduled" || post.bufferStatus === "sending") return "scheduled";
  if (post.approvalStatus === "approved") return "approved";
  if (post.approvalStatus === "changes_requested") return "changes_requested";
  if (post.approvalStatus === "pending") return "pending_approval";
  return "draft";
}

export interface PostAlert {
  level: "error" | "warning";
  message: string;
}

type AlertInput = StatusInput & Pick<Post, "dueAt" | "bufferError" | "scheduleError" | "assets" | "text">;

/** Situations anormales à signaler à l'administrateur. */
export function getPostAlerts(post: AlertInput, now: string): PostAlert[] {
  const alerts: PostAlert[] = [];
  const programmed = post.bufferStatus === "scheduled" || post.bufferStatus === "sending";

  if (programmed && post.approvalStatus !== "approved") {
    alerts.push({
      level: "error",
      message:
        "Programmé dans Buffer sans validation du client : repassez-le en brouillon dans Buffer si c'est une erreur.",
    });
  }
  if (post.bufferStatus === "error") {
    alerts.push({ level: "error", message: post.bufferError ?? "Buffer signale une erreur sur ce post." });
  }
  if (post.scheduleState === "failed") {
    alerts.push({
      level: "error",
      message: `La programmation dans Buffer a échoué : ${post.scheduleError ?? "erreur inconnue"}. Une nouvelle tentative aura lieu à la prochaine synchronisation.`,
    });
  }
  if (post.scheduleState === "unschedule_pending") {
    alerts.push({
      level: "warning",
      message: "Programmé dans Buffer alors que la validation n'est plus valable : repassez-le en brouillon dans Buffer (Cadence n'y modifie rien).",
    });
  }
  if (post.bufferStatus === "draft" && post.approvalStatus !== "none") {
    if (post.dueAt && Date.parse(post.dueAt) <= Date.parse(now)) {
      alerts.push({ level: "warning", message: "La date prévue est dépassée : le client ne peut pas approuver ce brouillon. Corrigez-la dans Buffer." });
    }
  }
  return alerts;
}

/** Le client peut-il encore décider ? Même règle que la fonction SQL decide_post. */
export function canDecide(post: Pick<Post, "approvalStatus" | "bufferStatus" | "removedAt">): boolean {
  return post.approvalStatus === "pending" && post.bufferStatus === "draft" && post.removedAt === null;
}

/** Buffer n'a pas de titre : on utilise la première ligne du texte. */
export function postTitle(post: Pick<Post, "text">, maxLength = 70): string {
  const firstLine = post.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  if (!firstLine) return "Post sans texte";
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength).replace(/\s+\S*$/, "")}…` : firstLine;
}

/** Événements présentés au client : ses décisions et la vie de la publication, pas les incidents techniques. */
export const CLIENT_EVENT_TYPES: PostEventType[] = [
  "submitted",
  "resubmitted",
  "approved",
  "changes_requested",
  "commented",
  "approval_invalidated",
  "scheduled",
  "published",
];

/**
 * La date prévue permet-elle l'approbation ? Même règle que la fonction SQL decide_post : un brouillon sans date
 * est approuvable (l'agence fixera la date en programmant dans Buffer) ; une date déjà dépassée ne l'est pas.
 */
export function hasUsableDueDate(post: Pick<Post, "dueAt">, now: string): boolean {
  return post.dueAt === null || Date.parse(post.dueAt) > Date.parse(now);
}

/** N'accepte que les liens http(s) : une adresse venue de l'extérieur ne doit jamais pouvoir exécuter du code. */
export function safeExternalUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
