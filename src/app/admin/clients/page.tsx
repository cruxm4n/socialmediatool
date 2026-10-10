import type { Metadata } from "next";

import { ClientsView } from "@/components/admin/clients-view";
import { requireAdmin } from "@/server/auth";
import { listMembers } from "@/server/data";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Clients" };

export default async function Page() {
  const session = await requireAdmin();
  const [workspace, members] = await Promise.all([loadWorkspace(), listMembers()]);
  return <ClientsView organizations={session.organizations} channels={workspace.channels} posts={workspace.posts} members={members} />;
}
