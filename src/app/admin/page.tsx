import type { Metadata } from "next";

import { AdminOverview } from "@/components/dashboard/admin-views";
import { requireAdmin } from "@/server/auth";
import { listEvents, listProfiles } from "@/server/data";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Vue d'ensemble" };

export default async function Page() {
  await requireAdmin();
  const [workspace, profiles] = await Promise.all([loadWorkspace(), listProfiles()]);
  const events = await listEvents(workspace.posts.map((post) => post.id), 30);
  return <AdminOverview posts={workspace.posts} channels={workspace.channels} events={events} profiles={profiles} now={workspace.now} />;
}
