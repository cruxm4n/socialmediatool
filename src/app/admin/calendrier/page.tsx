import type { Metadata } from "next";

import { AdminCalendarView } from "@/components/dashboard/admin-views";
import { studioPostViews } from "@/lib/view";
import { requireAdmin } from "@/server/auth";
import { listMedia, listStudioDrafts } from "@/server/studio";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Calendrier" };

export default async function Page() {
  await requireAdmin();
  const [workspace, drafts] = await Promise.all([loadWorkspace(), listStudioDrafts()]);
  // Sans la migration 0008 (drafts null), le calendrier montre simplement les publications Buffer.
  const media = drafts?.some((draft) => draft.mediaIds.length > 0) ? ((await listMedia(null, drafts.flatMap((draft) => draft.mediaIds))) ?? []) : [];
  const studioPosts = studioPostViews(drafts ?? [], workspace.channels, workspace.organizations, media);
  return <AdminCalendarView posts={workspace.posts} studioPosts={studioPosts} now={workspace.now} />;
}
