import { deriveStatus, postTitle } from "@/lib/domain/status";
import { composeText } from "@/lib/domain/studio";
import { toNetwork, type Channel, type DisplayStatus, type MediaAsset, type Network, type Organization, type Post, type PostAsset, type StudioDraft } from "@/lib/types";

/** Post enrichi de tout ce dont l'interface a besoin pour l'afficher. */
export interface PostView extends Post {
  network: Network;
  status: DisplayStatus;
  title: string;
  channel: Channel | null;
  /** Client propriétaire de la publication (propriété explicite). null : ambiguë, non attribuée ou client inconnu. */
  organization: Organization | null;
  /** Client auquel le canal est rattaché AUJOURD'HUI. Peut différer du propriétaire après un transfert. */
  channelOrganization: Organization | null;
  /** true : le propriétaire de la publication n'est plus le client du canal (historique d'un ancien client). */
  ownerDiffersFromChannel: boolean;
  /** Fuseau d'affichage : celui du client, ou Paris si le canal n'est rattaché à personne. */
  timezone: string;
}

export const DEFAULT_TIMEZONE = "Europe/Paris";

export function buildPostViews(posts: Post[], channels: Channel[], organizations: Organization[]): PostView[] {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const organizationById = new Map(organizations.map((organization) => [organization.id, organization]));
  return posts.map((post) => {
    const channel = channelById.get(post.channelId) ?? null;
    let organization: Organization | null;
    if (post.ownership !== undefined) {
      // Schéma à propriété explicite : le client affiché est le propriétaire enregistré de la publication,
      // jamais celui du canal actuel (le canal a pu être transféré) ni une date d'import.
      organization = post.ownership === "assigned" && post.ownerOrganizationId ? (organizationById.get(post.ownerOrganizationId) ?? null) : null;
    } else {
      // Ancien schéma (avant 0009) : repli sur le canal, avec masquage de l'historique antérieur à un transfert.
      const predatesTransfer = !!channel?.visibleFrom && Date.parse(post.createdAt) < Date.parse(channel.visibleFrom);
      organization = channel?.organizationId && !predatesTransfer ? (organizationById.get(channel.organizationId) ?? null) : null;
    }
    const channelOrganization = channel?.organizationId ? (organizationById.get(channel.organizationId) ?? null) : null;
    return {
      ...post,
      network: toNetwork(post.service),
      status: deriveStatus(post),
      title: postTitle(post),
      channel,
      organization,
      channelOrganization,
      ownerDiffersFromChannel: !!organization && !!channel && channel.organizationId !== organization.id,
      timezone: organization?.timezone ?? DEFAULT_TIMEZONE,
    };
  });
}

/** Les composants clients n'ont besoin que du statut dérivé, jamais des diagnostics fournisseurs. */
export function redactPostDiagnostics(post: PostView): PostView {
  return { ...post, bufferError: null, scheduleError: null };
}

/** Médias de la bibliothèque sous la forme attendue par les aperçus. */
export function toPostAssets(media: MediaAsset[]): PostAsset[] {
  return media
    .filter((item) => item.url)
    .map((item) => ({ type: item.kind, source: item.url!, thumbnail: item.kind === "video" ? "" : item.url!, mimeType: item.mimeType }));
}

const STUDIO_PREFIX = "studio:";
/** Identifiant du contenu du Studio derrière une entrée de calendrier, ou null pour une publication Buffer. */
export function studioDraftIdOf(postId: string): string | null {
  return postId.startsWith(STUDIO_PREFIX) ? postId.split(":")[1] : null;
}

/**
 * Contenus du Studio pas encore envoyés à Buffer, présentés comme des brouillons dans le calendrier
 * et les aperçus. Une entrée par canal. Dès qu'un texte est dans Buffer, c'est la publication Buffer
 * qui le représente : il n'apparaît plus ici.
 */
export function studioPostViews(drafts: StudioDraft[], channels: Channel[], organizations: Organization[], media: MediaAsset[]): PostView[] {
  const mediaById = new Map(media.map((item) => [item.id, item]));
  return drafts
    .filter((draft) => draft.status !== "archived")
    .flatMap((draft) => {
      const organization = organizations.find((item) => item.id === draft.organizationId) ?? null;
      const assets = toPostAssets(draft.mediaIds.map((id) => mediaById.get(id)).filter((item): item is MediaAsset => !!item));
      return draft.variants
        .filter((variant) => variant.bufferPostId === null)
        .flatMap((variant) => {
          const channel = channels.find((item) => item.id === variant.channelId);
          if (!channel) return [];
          const text = composeText(variant.text, draft.hashtags);
          const post: Post = {
            id: `${STUDIO_PREFIX}${draft.id}:${variant.id}`,
            bufferPostId: `${STUDIO_PREFIX}${variant.id}`,
            channelId: channel.id,
            service: channel.service,
            text,
            assets,
            dueAt: draft.dueAt,
            bufferStatus: "draft",
            bufferError: null,
            externalLink: null,
            sentAt: null,
            hasReviewTag: false,
            contentHash: "",
            version: 1,
            approvalStatus: "none",
            approvedVersion: null,
            approvedAt: null,
            approvedById: null,
            submittedAt: null,
            scheduleState: "idle",
            scheduleError: null,
            scheduleAttempts: 0,
            removedAt: null,
            syncedAt: draft.updatedAt,
            createdAt: draft.createdAt,
          };
          return [{
            ...post,
            network: toNetwork(channel.service),
            status: "draft" as const,
            title: draft.title || postTitle(post),
            channel,
            organization,
            channelOrganization: organization,
            ownerDiffersFromChannel: false,
            timezone: organization?.timezone ?? DEFAULT_TIMEZONE,
          }];
        });
    });
}
