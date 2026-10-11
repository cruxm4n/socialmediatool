import type { Metadata } from "next";

import { SyncView } from "@/components/dashboard/sync-view";
import { requireAdmin } from "@/server/auth";
import { getSyncStatus, listSyncRuns } from "@/server/data";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Synchronisation" };

export default async function Page() {
  await requireAdmin();
  const [runs, status] = await Promise.all([listSyncRuns(25), getSyncStatus()]);
  return <SyncView runs={runs} status={status} intervalMinutes={env.syncIntervalMinutes} now={new Date().toISOString()} mode={env.bufferMode} reviewTag={env.reviewTagLabel} />;
}
