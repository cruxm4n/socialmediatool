import { formatDateTime } from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { postTitle } from "@/lib/domain/status";
import { toNetwork } from "@/lib/types";

/*
 * Notifications : libellés, préférences et rédaction des messages.
 * Règles pures. La file d'attente et l'anti-doublon vivent dans la base (migration 0007).
 */

export const NOTIFICATION_KINDS = ["review_requested", "changes_requested", "approved", "schedule_error"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationStatus = "pending" | "sending" | "sent" | "simulated" | "failed" | "cancelled";

export interface NotificationPreferences {
  review_requested: boolean;
  changes_requested: boolean;
  approved: boolean;
  schedule_error: boolean;
}

/** Valeurs appliquées tant que l'utilisateur n'a rien réglé (mêmes défauts que la base). */
export const DEFAULT_PREFERENCES: NotificationPreferences = { review_requested: true, changes_requested: true, approved: false, schedule_error: true };

export const KIND_META: Record<NotificationKind, { label: string; description: string; audience: "client" | "admin" }> = {
  review_requested: { label: "Publication à valider", description: "Une publication attend votre validation, ou a changé depuis votre accord.", audience: "client" },
  changes_requested: { label: "Modifications demandées", description: "Un client demande des modifications sur une publication.", audience: "admin" },
  approved: { label: "Publication approuvée", description: "Un client approuve une publication. Facultatif : désactivé par défaut.", audience: "admin" },
  schedule_error: { label: "Erreur de programmation", description: "Buffer refuse une programmation ou signale un échec de publication.", audience: "admin" },
};

export const STATUS_LABELS: Record<NotificationStatus, string> = {
  pending: "En attente",
  sending: "En cours d'envoi",
  sent: "Envoyée",
  simulated: "Enregistrée, non envoyée",
  failed: "Échec",
  cancelled: "Annulée",
};

/** Notification réservée par la base, prête à être remise. */
export interface QueuedNotification {
  id: string;
  kind: NotificationKind;
  recipient_id: string;
  recipient_name: string;
  recipient_email: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  timezone: string;
  post_id: string;
  post_text: string;
  service: string;
  due_at: string | null;
  detail: string | null;
}

export interface Digest {
  ids: string[];
  kind: NotificationKind;
  recipientId: string;
  recipientName: string;
  recipientEmail: string | null;
  subject: string;
  text: string;
  /** Lien principal du message. null : l'adresse publique de l'application n'est pas configurée. */
  url: string | null;
  items: { postId: string; title: string; network: string; dueAt: string | null; organization: string | null; detail: string | null; url: string | null }[];
}

const plural = (count: number, one: string, many: string) => (count > 1 ? many : one);

const SUBJECTS: Record<NotificationKind, (count: number) => string> = {
  review_requested: (count) => `${count} ${plural(count, "publication à valider", "publications à valider")}`,
  changes_requested: (count) => plural(count, "Modifications demandées sur une publication", `Modifications demandées sur ${count} publications`),
  approved: (count) => `${count} ${plural(count, "publication approuvée", "publications approuvées")}`,
  schedule_error: (count) => `${count} ${plural(count, "erreur de programmation", "erreurs de programmation")}`,
};

const INTROS: Record<NotificationKind, (count: number) => string> = {
  review_requested: (count) => plural(count, "Une publication attend votre validation :", `${count} publications attendent votre validation :`),
  changes_requested: (count) => plural(count, "Un client demande des modifications :", "Des modifications sont demandées :"),
  approved: (count) => plural(count, "Une publication vient d'être approuvée :", `${count} publications viennent d'être approuvées :`),
  schedule_error: (count) => plural(count, "Une publication n'a pas pu être programmée ou publiée :", `${count} publications n'ont pas pu être programmées ou publiées :`),
};

/**
 * Regroupe les notifications en un message par destinataire et par type : dix publications
 * soumises d'un coup donnent un seul e-mail, pas dix.
 */
export function buildDigests(rows: QueuedNotification[], appUrl: string | null, options: { content?: "minimal" | "full" } = {}): Digest[] {
  const base = appUrl ? appUrl.replace(/\/+$/, "") : null;
  // « minimal » : aucun texte de publication ni commentaire dans le message, seulement un lien. Une personne dont
  // l'accès a été retiré entre la mise en file et la lecture ne voit rien : le lien exige une session autorisée.
  const minimal = options.content === "minimal";
  const groups = new Map<string, QueuedNotification[]>();
  for (const row of rows) {
    const key = `${row.recipient_id}:${row.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((group) => {
    const [first] = group;
    const forClient = KIND_META[first.kind].audience === "client";
    const organizations = [...new Set(group.map((row) => row.organization_name).filter((name): name is string => !!name))];
    const postUrl = (row: QueuedNotification) => {
      if (!base) return null;
      if (!forClient) return `${base}/admin/publications/${row.post_id}`;
      return row.organization_slug ? `${base}/client/${row.organization_slug}/publications/${row.post_id}` : null;
    };
    const items = group.map((row) => ({
      postId: row.post_id,
      title: minimal ? "" : postTitle({ text: row.post_text }),
      // Message générique : ni réseau, ni nom de client, ni date, ni extrait (voir D31 et la mission V3, C04).
      network: minimal ? "" : NETWORK_LABELS[toNetwork(row.service)],
      dueAt: minimal ? null : row.due_at,
      organization: minimal ? null : row.organization_name,
      detail: minimal ? null : row.detail,
      url: postUrl(row),
    }));
    const url = !base ? null : forClient ? (first.organization_slug ? `${base}/client/${first.organization_slug}/a-valider` : null) : `${base}/admin`;

    const lines = minimal
      ? items.flatMap((item, index) => [`• Élément ${index + 1}`, ...(item.url ? [`  ${item.url}`] : [])])
      : group.flatMap((row, index) => {
      const item = items[index];
      const when = row.due_at ? formatDateTime(row.due_at, row.timezone) : "sans date";
      const owner = !forClient && item.organization ? `${item.organization} · ` : "";
      return [
        `• ${owner}${item.network} · ${when} — « ${item.title} »`,
        ...(item.detail ? [`  ${first.kind === "changes_requested" ? "Demande" : "Détail"} : ${item.detail}`] : []),
        ...(item.url ? [`  ${item.url}`] : []),
      ];
    });
    const text = [
      `Bonjour ${first.recipient_name.split(" ")[0]},`,
      "",
      minimal ? INTROS[first.kind](group.length).replace(/ :$/, ".") : INTROS[first.kind](group.length),
      "",
      ...lines,
      ...(url ? ["", `${forClient ? "Tout voir et répondre" : "Ouvrir Cadence"} : ${url}`] : []),
      ...(minimal ? ["", "Le contenu n'est pas inclus dans ce message : connectez-vous à Cadence pour le consulter."] : []),
      "",
      "Vous recevez ce message car vous utilisez Cadence. Vos préférences de notification se règlent dans l'application.",
    ].join("\n");

    return {
      ids: group.map((row) => row.id),
      kind: first.kind,
      recipientId: first.recipient_id,
      recipientName: first.recipient_name,
      recipientEmail: first.recipient_email,
      subject: `${SUBJECTS[first.kind](group.length)}${!minimal && organizations.length === 1 ? ` — ${organizations[0]}` : ""}`,
      text,
      url,
      items,
    };
  });
}
