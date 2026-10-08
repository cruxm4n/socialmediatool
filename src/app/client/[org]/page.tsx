import type { Metadata } from "next";

import { ClientOverview } from "@/components/client/client-views";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";

export const metadata: Metadata = { title: "Vue d'ensemble" };

export default async function Page({ params }: PageProps<"/client/[org]">) {
  const { org } = await params;
  const space = await requireClientSpace(org);
  const { posts, now } = await loadClientSpace(space.organization);
  return <ClientOverview organization={space.organization} posts={posts} now={now} profile={space.profile} />;
}
