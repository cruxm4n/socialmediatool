import type { Metadata } from "next";

import { ApprovalsView } from "@/components/client/client-views";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";

export const metadata: Metadata = { title: "À valider" };

export default async function Page({ params }: PageProps<"/client/[org]/a-valider">) {
  const { org } = await params;
  const space = await requireClientSpace(org);
  const { posts, now } = await loadClientSpace(space.organization);
  return <ApprovalsView organization={space.organization} posts={posts} now={now} />;
}
