import type { Metadata } from "next";

import { ClientCalendarView } from "@/components/client/client-views";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";

export const metadata: Metadata = { title: "Calendrier" };

export default async function Page({ params }: PageProps<"/client/[org]/calendrier">) {
  const { org } = await params;
  const space = await requireClientSpace(org);
  const { posts, now } = await loadClientSpace(space.organization);
  return <ClientCalendarView organization={space.organization} posts={posts} now={now} />;
}
