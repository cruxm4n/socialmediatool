import type { Metadata } from "next";

import { NotificationsView } from "@/components/notifications/notifications-view";
import { requireAdmin } from "@/server/auth";
import { getNotificationPreferences, listNotifications, listProfiles } from "@/server/data";
import { notificationMode } from "@/server/notifications";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Notifications" };

export default async function Page() {
  const session = await requireAdmin();
  const [notifications, preferences, profiles, workspace] = await Promise.all([
    listNotifications(60),
    getNotificationPreferences(session.profile.id),
    listProfiles(),
    loadWorkspace(),
  ]);
  const titles = new Map(workspace.posts.map((post) => [post.id, post.title]));
  const names = new Map(profiles.map((profile) => [profile.id, profile.fullName]));
  const rows =
    notifications?.map((item) => ({
      ...item,
      title: titles.get(item.postId) ?? "Publication",
      href: `/admin/publications/${item.postId}`,
      recipientName: names.get(item.recipientId) ?? null,
    })) ?? null;
  return <NotificationsView audience="admin" preferences={preferences} rows={rows} delivery={notificationMode()} />;
}
