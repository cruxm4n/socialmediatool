import type { Metadata } from "next";

import { PostsView } from "@/components/publications/posts-view";
import { requireAdmin } from "@/server/auth";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Publications" };

export default async function Page() {
  await requireAdmin();
  const workspace = await loadWorkspace();
  return <PostsView posts={workspace.posts} />;
}
