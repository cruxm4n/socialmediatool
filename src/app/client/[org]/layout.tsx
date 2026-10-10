import { ClientShell } from "@/components/client/client-shell";
import { canDecide } from "@/lib/domain/status";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";

export default async function ClientLayout({ children, params }: LayoutProps<"/client/[org]">) {
  const { org } = await params;
  const space = await requireClientSpace(org);
  const { posts, now } = await loadClientSpace(space.organization);
  // Le client n'a pas accès au journal de synchronisation : la fraîcheur se lit sur ses propres publications.
  const freshAt = posts.reduce<string | null>((latest, post) => (latest === null || post.syncedAt > latest ? post.syncedAt : latest), null);

  return (
    <ClientShell organization={space.organization} profile={space.profile} pendingCount={posts.filter(canDecide).length} freshAt={freshAt} now={now}>
      {children}
    </ClientShell>
  );
}
