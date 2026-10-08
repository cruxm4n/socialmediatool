import type { Metadata } from "next";

import { AdminOverview } from "@/components/dashboard/admin-views";
import { requireAdmin } from "@/server/auth";
import { listEvents, listProfiles } from "@/server/data";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Vue d'ensemble" };

export default async function Page() {
  await requireAdmin();
  const [workspace, profiles, events] = await Promise.all([loadWorkspace(), listProfiles(), listEvents({ limit: 60 })]);
  return <AdminOverview posts={workspace.posts} channels={workspace.channels} events={events} profiles={profiles} now={workspace.now} />;
}
