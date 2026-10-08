/**
 * Types métier partagés entre le serveur et l'interface.
 * Buffer est la source de vérité du contenu ; Supabase garde la validation.
 */

export const NETWORKS = ["linkedin", "instagram", "facebook", "tiktok", "twitter"] as const;
/** Réseaux dotés d'une icône et d'un aperçu dédiés. Les autres services Buffer tombent dans « other ». */
export type Network = (typeof NETWORKS)[number] | "other";

export function toNetwork(service: string): Network {
  return (NETWORKS as readonly string[]).includes(service) ? (service as Network) : "other";
}

/** Statut du post dans Buffer. */
export type BufferStatus = "draft" | "needs_approval" | "scheduled" | "sending" | "sent" | "error";

/** Validation par le client, gérée par le dashboard. */
export type ApprovalStatus = "none" | "pending" | "changes_requested" | "approved";

/** Avancement de la programmation déclenchée par le dashboard. */
export type ScheduleState = "idle" | "claimed" | "scheduled" | "failed" | "unschedule_pending";

/** Statut unique affiché à l'écran, déduit des trois précédents (voir domain/status.ts). */
export const DISPLAY_STATUSES = [
  "draft",
  "pending_approval",
  "changes_requested",
  "approved",
  "scheduled",
  "published",
  "error",
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export type Role = "admin" | "client";

export interface Organization {
  id: string;
  slug: string;
  name: string;
  sector: string;
  /** Fuseau IANA utilisé pour afficher les dates de cette organisation. */
  timezone: string;
  initials: string;
  color: string;
}

export interface Profile {
  id: string;
  fullName: string;
  jobTitle: string;
  role: Role;
}

export interface Channel {
  id: string;
  bufferChannelId: string;
  service: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  isDisconnected: boolean;
  /** Client auquel ce canal est rattaché. null : pas encore attribué. */
  organizationId: string | null;
}

export interface PostAsset {
  type: "image" | "video" | "document";
  source: string;
  thumbnail: string;
  mimeType?: string;
}

export interface Post {
  id: string;
  bufferPostId: string;
  channelId: string;
  service: string;
  text: string;
  assets: PostAsset[];
  /** Date de publication prévue, en UTC (ISO 8601). */
  dueAt: string | null;
  bufferStatus: BufferStatus;
  bufferError: string | null;
  externalLink: string | null;
  sentAt: string | null;
  hasReviewTag: boolean;
  /** Empreinte du contenu validable. Une décision porte toujours sur une empreinte précise. */
  contentHash: string;
  version: number;
  approvalStatus: ApprovalStatus;
  approvedVersion: number | null;
  approvedAt: string | null;
  approvedById: string | null;
  submittedAt: string | null;
  scheduleState: ScheduleState;
  scheduleError: string | null;
  scheduleAttempts: number;
  removedAt: string | null;
  syncedAt: string;
  createdAt: string;
}

export interface Comment {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  kind: "comment" | "change_request";
  version: number;
  createdAt: string;
}

export type PostEventType =
  | "submitted"
  | "updated"
  | "resubmitted"
  | "withdrawn"
  | "approved"
  | "changes_requested"
  | "commented"
  | "approval_invalidated"
  | "unscheduled_in_buffer"
  | "scheduled"
  | "schedule_failed"
  | "unscheduled"
  | "published"
  | "failed"
  | "removed";

export interface PostEvent {
  id: number;
  postId: string;
  type: PostEventType;
  actorId: string | null;
  detail: string | null;
  version: number;
  createdAt: string;
}

export interface SyncRun {
  id: number;
  mode: string;
  status: "success" | "error";
  triggeredBy: string;
  fetched: number;
  created: number;
  updated: number;
  invalidated: number;
  removed: number;
  error: string | null;
  rateLimit: Record<string, number> | null;
  createdAt: string;
}
