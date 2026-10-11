import type { Metadata } from "next";

import { NotificationsView } from "@/components/notifications/notifications-view";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";
import { getNotificationPreferences, listNotifications } from "@/server/data";
import { notificationMode } from "@/server/notifications";

export const metadata: Metadata = { title: "Notifications" };

export default async function Page({ params }: PageProps<"/client/[org]/notifications">) {
  const { org } = await params;
  const session = await requireClientSpace(org);
  const [notifications, preferences, space] = await Promise.all([
    listNotifications(30),
    getNotificationPreferences(session.profile.id),
    loadClientSpace(session.organization),
  ]);
  const titles = new Map(space.posts.map((post) => [post.id, post.title]));
  // Un utilisateur membre de plusieurs clients ne voit ici que les notifications du client affiché.
  const rows =
    notifications
      ?.filter((item) => item.recipientId === session.profile.id && item.organizationId === session.organization.id)
      .map((item) => ({
        ...item,
        // Le détail technique d'un envoi ne concerne pas le client.
        error: null,
        title: titles.get(item.postId) ?? "Publication",
        href: titles.has(item.postId) ? `/client/${org}/publications/${item.postId}` : null,
        recipientName: null,
      })) ?? null;
  return <NotificationsView audience="client" preferences={preferences} rows={rows} emailEnabled={notificationMode() === "webhook"} />;
}
