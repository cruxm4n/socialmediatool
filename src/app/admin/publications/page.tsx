import type { Metadata } from "next";

import { PostsView } from "@/components/publications/posts-view";
import { INBOX_KEYS, type InboxKey } from "@/lib/domain/inbox";
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
  // Filtre « À traiter » transmis par le bandeau de la vue d'ensemble (?filtre=…).
  const attention = typeof params.filtre === "string" && (INBOX_KEYS as readonly string[]).includes(params.filtre) ? (params.filtre as InboxKey) : null;
  return <PostsView key={`${initialStatus}-${attention}`} posts={workspace.posts} channels={workspace.channels} now={workspace.now} initialStatus={initialStatus} initialAttention={attention} />;
}
