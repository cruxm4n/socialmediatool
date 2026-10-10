import type { Metadata } from "next";

import { MigrationNeeded, StudioList } from "@/components/studio/studio-views";
import { requireAdmin } from "@/server/auth";
import { listChannels } from "@/server/data";
import { listStudioDrafts } from "@/server/studio";

export const metadata: Metadata = { title: "Studio" };

export default async function Page() {
  await requireAdmin();
  const [drafts, channels] = await Promise.all([listStudioDrafts(), listChannels()]);
  if (!drafts) return <MigrationNeeded />;
  return <StudioList drafts={drafts} channels={channels} now={new Date().toISOString()} />;
}
