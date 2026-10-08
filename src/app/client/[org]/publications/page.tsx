import type { Metadata } from "next";

import { ClientPostsView } from "@/components/client/client-views";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";

export const metadata: Metadata = { title: "Publications" };

export default async function Page({ params }: PageProps<"/client/[org]/publications">) {
  const { org } = await params;
  const space = await requireClientSpace(org);
  const { posts, now } = await loadClientSpace(space.organization);
  return <ClientPostsView organization={space.organization} posts={posts} now={now} />;
}
