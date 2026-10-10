import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireAdmin } from "@/server/auth";
import { getStudioDraft } from "@/server/studio";
import { renderStudioEditor } from "@/server/studio-page";

export const metadata: Metadata = { title: "Contenu" };

export default async function Page({ params }: PageProps<"/admin/studio/[id]">) {
  const [session, { id }] = await Promise.all([requireAdmin(), params]);
  const draft = await getStudioDraft(id);
  if (!draft) notFound();
  const organization = session.organizations.find((item) => item.id === draft.organizationId);
  if (!organization) notFound();
  return renderStudioEditor(organization, draft);
}
