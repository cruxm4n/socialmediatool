import "server-only";

import { buildPostViews, type PostView } from "@/lib/view";
import type { Channel, Organization } from "@/lib/types";
import { getSession } from "@/server/auth";
import { listChannels, listPosts } from "@/server/data";

export interface Workspace {
  posts: PostView[];
  channels: Channel[];
  organizations: Organization[];
  /** Instant du rendu, transmis à l'interface pour que serveur et navigateur affichent la même chose. */
  now: string;
}

/** Posts, canaux et organisations visibles par l'utilisateur connecté (filtrés par la base). */
export async function loadWorkspace(): Promise<Workspace> {
  const [session, posts, channels] = await Promise.all([getSession(), listPosts(), listChannels()]);
  const organizations = session?.organizations ?? [];
  return {
    posts: buildPostViews(posts, channels, organizations),
    channels,
    organizations,
    now: new Date().toISOString(),
  };
}
