import { AdminProvider } from "@/components/shell/admin-context";
import { AdminShell } from "@/components/shell/admin-shell";
import { requireAdmin } from "@/server/auth";
import { listSyncRuns } from "@/server/data";
import { env } from "@/server/env";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const session = await requireAdmin();
  const [lastRun] = await listSyncRuns(1);

  return (
    <AdminProvider
      profile={session.profile}
      organizations={session.organizations}
      mode={env.bufferMode}
      lastSyncAt={lastRun?.createdAt ?? null}
      lastSyncFailed={lastRun?.status === "error"}
    >
      <AdminShell>{children}</AdminShell>
    </AdminProvider>
  );
}
