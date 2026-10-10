import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ClientDetail } from "@/components/admin/client-detail";
import { requireAdmin } from "@/server/auth";
import { listMembers, listProfiles, listUserEmails } from "@/server/data";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Fiche client" };

export default async function Page({ params }: PageProps<"/admin/clients/[id]">) {
  const [session, { id }] = await Promise.all([requireAdmin(), params]);
  const organization = session.organizations.find((item) => item.id === id);
  if (!organization) notFound();

  const [workspace, profiles, members, emails] = await Promise.all([loadWorkspace(), listProfiles(), listMembers(), listUserEmails()]);
  return (
    <ClientDetail
      organization={organization}
      organizations={session.organizations}
      channels={workspace.channels}
      posts={workspace.posts}
      profiles={profiles}
      members={members}
      emails={emails}
    />
  );
}
