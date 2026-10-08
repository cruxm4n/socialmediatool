import type { Metadata } from "next";

import { ClientsView } from "@/components/dashboard/admin-views";
import { requireAdmin } from "@/server/auth";
import { listMembers, listProfiles } from "@/server/data";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Clients" };

export default async function Page() {
  await requireAdmin();
  const [workspace, profiles, members] = await Promise.all([loadWorkspace(), listProfiles(), listMembers()]);
  return <ClientsView channels={workspace.channels} posts={workspace.posts} profiles={profiles} members={members} />;
}
