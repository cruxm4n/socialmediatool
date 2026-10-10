import type { Metadata } from "next";

import { MediaPage, MigrationNeeded } from "@/components/studio/studio-views";
import { requireAdmin } from "@/server/auth";
import { listMedia } from "@/server/studio";

export const metadata: Metadata = { title: "Médias" };

export default async function Page() {
  await requireAdmin();
  const media = await listMedia(null);
  if (!media) return <MigrationNeeded />;
  return <MediaPage media={media} />;
}
