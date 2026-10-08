import type { Metadata } from "next";

import { PostsView } from "@/components/publications/posts-view";
import { DISPLAY_STATUSES, type DisplayStatus } from "@/lib/types";
import { requireAdmin } from "@/server/auth";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Publications" };

export default async function Page({ searchParams }: PageProps<"/admin/publications">) {
  await requireAdmin();
  const [workspace, params] = await Promise.all([loadWorkspace(), searchParams]);
  // Filtre initial transmis par les indicateurs de la vue d'ensemble (?statut=…).
  const requested = typeof params.statut === "string" ? params.statut : "";
  const initialStatus = (DISPLAY_STATUSES as readonly string[]).includes(requested) ? (requested as DisplayStatus) : "all";
  return <PostsView key={initialStatus} posts={workspace.posts} initialStatus={initialStatus} />;
}
