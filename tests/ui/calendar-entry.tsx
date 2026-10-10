import { createRoot } from "react-dom/client";

import { EditorialCalendar } from "@/components/calendar/editorial-calendar";
import type { PostView } from "@/lib/view";

const post = (id: string, network: PostView["network"], dueAt: string | null): PostView => ({
  id, bufferPostId: `mock-ui-${id}`, network, dueAt, timezone: "Europe/Paris",
  channel: null, channelOrganization: null, ownerDiffersFromChannel: false, channelId: "mock-ui-channel", service: network,
  bufferStatus: "draft", bufferError: null, externalLink: null, sentAt: null,
  hasReviewTag: true, contentHash: `hash-${id}`, version: 1, approvalStatus: "pending",
  approvedVersion: null, approvedAt: null, approvedById: null, submittedAt: null,
  scheduleState: "idle", scheduleError: null, scheduleAttempts: 0, removedAt: null,
  syncedAt: "2026-10-08T10:00:00.000Z", createdAt: "2026-10-08T10:00:00.000Z",
  title: `Publication ${id}`, text: `Publication ${id}`, assets: [], status: "pending_approval", organization: null,
});

createRoot(document.getElementById("root")!).render(
  <EditorialCalendar
    now="2026-10-08T10:00:00.000Z"
    posts={[post("dated", "linkedin", "2026-10-09T09:00:00.000Z"), post("undated", "instagram", null)]}
    statuses={["pending_approval", "scheduled"]}
    hrefFor={(item) => `/posts/${item.id}`}
  />,
);
