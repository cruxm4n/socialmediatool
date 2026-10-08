import type { Metadata } from "next";

import { ClientHistoryView } from "@/components/client/client-views";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";
import { listEvents, listProfiles } from "@/server/data";

export const metadata: Metadata = { title: "Historique" };

export default async function Page({ params }: PageProps<"/client/[org]/historique">) {
  const { org } = await params;
  const space = await requireClientSpace(org);
  const { posts, now } = await loadClientSpace(space.organization);
  const [events, profiles] = await Promise.all([listEvents(posts.map((post) => post.id), 100), listProfiles()]);
  return <ClientHistoryView organization={space.organization} posts={posts} now={now} events={events} profiles={profiles} />;
}
