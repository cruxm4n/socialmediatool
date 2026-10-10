import type { Metadata } from "next";

import { MigrationNeeded, NewDraftChooser } from "@/components/studio/studio-views";
import { requireAdmin } from "@/server/auth";
import { listStudioDrafts } from "@/server/studio";
import { renderStudioEditor } from "@/server/studio-page";

export const metadata: Metadata = { title: "Nouveau contenu" };

export default async function Page({ searchParams }: PageProps<"/admin/studio/nouveau">) {
  const [session, params] = await Promise.all([requireAdmin(), searchParams]);
  if (!(await listStudioDrafts())) return <MigrationNeeded />;
  const active = session.organizations.filter((organization) => organization.archivedAt === null);
  const organization = active.find((item) => item.id === params.client);
  if (!organization) return <NewDraftChooser organizations={active} />;
  return renderStudioEditor(organization, null);
}
