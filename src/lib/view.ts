import { deriveStatus, postTitle } from "@/lib/domain/status";
import { toNetwork, type Channel, type DisplayStatus, type Network, type Organization, type Post } from "@/lib/types";

/** Post enrichi de tout ce dont l'interface a besoin pour l'afficher. */
export interface PostView extends Post {
  network: Network;
  status: DisplayStatus;
  title: string;
  channel: Channel | null;
  organization: Organization | null;
  /** Fuseau d'affichage : celui du client, ou Paris si le canal n'est rattaché à personne. */
  timezone: string;
}

export const DEFAULT_TIMEZONE = "Europe/Paris";

export function buildPostViews(posts: Post[], channels: Channel[], organizations: Organization[]): PostView[] {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const organizationById = new Map(organizations.map((organization) => [organization.id, organization]));
  return posts.map((post) => {
    const channel = channelById.get(post.channelId) ?? null;
    const organization = channel?.organizationId ? (organizationById.get(channel.organizationId) ?? null) : null;
    return {
      ...post,
      network: toNetwork(post.service),
      status: deriveStatus(post),
      title: postTitle(post),
      channel,
      organization,
      timezone: organization?.timezone ?? DEFAULT_TIMEZONE,
    };
  });
}
