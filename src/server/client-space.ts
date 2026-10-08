import "server-only";

import { cache } from "react";

import type { Organization } from "@/lib/types";
import { loadWorkspace } from "@/server/workspace";

/**
 * Posts d'une organisation pour l'espace client.
 * La base ne renvoie déjà que les posts des organisations de l'utilisateur ; on garde ici
 * ceux de l'organisation affichée, pour un utilisateur membre de plusieurs clients.
 */
export const loadClientSpace = cache(async (organization: Organization) => {
  const workspace = await loadWorkspace();
  return {
    posts: workspace.posts.filter((post) => post.organization?.id === organization.id),
    now: workspace.now,
  };
});
