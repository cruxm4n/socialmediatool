import type { Metadata } from "next";

import { SyncView } from "@/components/dashboard/sync-view";
import { requireAdmin } from "@/server/auth";
import { listSyncRuns } from "@/server/data";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Synchronisation" };

export default async function Page() {
  await requireAdmin();
  const runs = await listSyncRuns(25);
  return <SyncView runs={runs} mode={env.bufferMode} reviewTag={env.reviewTag} />;
}
