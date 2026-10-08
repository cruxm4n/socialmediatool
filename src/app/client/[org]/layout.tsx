import { ClientShell } from "@/components/client/client-shell";
import { canDecide } from "@/lib/domain/status";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";

export default async function ClientLayout({ children, params }: LayoutProps<"/client/[org]">) {
  const { org } = await params;
  const space = await requireClientSpace(org);
  const { posts } = await loadClientSpace(space.organization);

  return (
    <ClientShell organization={space.organization} profile={space.profile} pendingCount={posts.filter(canDecide).length}>
      {children}
    </ClientShell>
  );
}
