import { AdminProvider } from "@/components/shell/admin-context";
import { AdminShell } from "@/components/shell/admin-shell";
import { requireAdmin } from "@/server/auth";
import { availabilityOf, listProviderConnections } from "@/server/connections";
import { getSyncStatus } from "@/server/data";
import { env } from "@/server/env";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const session = await requireAdmin();
  const [sync, connections] = await Promise.all([getSyncStatus(), listProviderConnections().catch(() => null)]);
  const { accounts, writesEnabled, problem } = availabilityOf(connections);

  return (
    <AdminProvider
      profile={session.profile}
      organizations={session.organizations.filter((organization) => organization.archivedAt === null)}
      mode={env.bufferMode}
      buffer={{ accounts, writesEnabled, problem }}
      sync={sync}
      syncIntervalMinutes={env.syncIntervalMinutes}
      renderedAt={new Date().toISOString()}
      supabase={{ url: env.supabaseUrl, key: env.supabaseKey }}
    >
      <AdminShell>{children}</AdminShell>
    </AdminProvider>
  );
}
