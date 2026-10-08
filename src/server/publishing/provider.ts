import type { BufferStatus, PostAsset } from "@/lib/types";

/**
 * Contrat du fournisseur de publication.
 * Aujourd'hui Buffer (réel ou simulé). Le reste du code ne connaît que cette interface.
 */

export interface ProviderChannel {
  id: string;
  service: string;
  name: string;
  displayName: string | null;
  avatar: string | null;
  isDisconnected: boolean;
  /** Rattachement proposé à la création du canal (utilisé par le Buffer simulé uniquement). */
  organizationSlug?: string;
}

export interface ProviderPost {
  id: string;
  channelId: string;
  service: string;
  status: BufferStatus;
  text: string;
  dueAt: string | null;
  sentAt: string | null;
  updatedAt: string | null;
  externalLink: string | null;
  error: string | null;
  hasReviewTag: boolean;
  /** « automatic » ou « notification » (rappel de publication manuelle). */
  schedulingType: string | null;
  assets: PostAsset[];
}

export type RateLimit = Record<string, number>;

export interface ProviderSnapshot {
  channels: ProviderChannel[];
  posts: ProviderPost[];
  /** false si la liste des posts est tronquée : on ne peut alors rien conclure sur les posts absents. */
  complete: boolean;
  rateLimit: RateLimit | null;
}

export interface PublishingProvider {
  readonly mode: "real" | "mock";
  /** État complet : canaux et posts. */
  fetchSnapshot(): Promise<ProviderSnapshot>;
  getPost(id: string): Promise<ProviderPost | null>;
  /** Passe un brouillon en « programmé » à sa date prévue. */
  schedulePost(post: ProviderPost): Promise<ProviderPost>;
  /** Repasse un post programmé en brouillon. */
  unschedulePost(post: ProviderPost): Promise<ProviderPost>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "api" | "rate_limit" | "network" = "api",
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Le contenu validé par le client est-il encore celui présent chez le fournisseur ? */
export function sameContent(
  approved: { text: string; dueAt: string | null; assets: PostAsset[] },
  live: Pick<ProviderPost, "text" | "dueAt" | "assets">,
): boolean {
  const minute = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
  const sources = (assets: PostAsset[]) => assets.map((asset) => `${asset.type}:${asset.source}`).join(",");
  return (
    approved.text === live.text &&
    minute(approved.dueAt) === minute(live.dueAt) &&
    sources(approved.assets) === sources(live.assets)
  );
}
