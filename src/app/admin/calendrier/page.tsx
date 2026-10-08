import type { Metadata } from "next";

import { AdminCalendarView } from "@/components/dashboard/admin-views";
import { requireAdmin } from "@/server/auth";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Calendrier" };

export default async function Page() {
  await requireAdmin();
  const workspace = await loadWorkspace();
  return <AdminCalendarView posts={workspace.posts} now={workspace.now} />;
}
