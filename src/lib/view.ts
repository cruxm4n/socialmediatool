import { deriveStatus, postTitle } from "@/lib/domain/status";
import { toNetwork, type Channel, type DisplayStatus, type Network, type Organization, type Post } from "@/lib/types";

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
