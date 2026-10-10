"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";

import { AdminSidebarContent } from "@/components/shell/admin-sidebar";
import { useAdmin } from "@/components/shell/admin-context";
import { OrgSwitcher } from "@/components/shell/org-switcher";
import { AutoSync, bufferUnavailable, SyncButton } from "@/components/shell/sync-button";
import { UserMenu } from "@/components/shell/user-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TONE_CLASSES } from "@/components/shared/status-badge";
import { syncHealth } from "@/lib/domain/sync-health";
import { cn } from "@/lib/utils";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { profile, lastSyncAt, sync, syncIntervalMinutes, renderedAt, mode, buffer } = useAdmin();
  const unavailable = bufferUnavailable(mode, buffer);
  const health = syncHealth(sync, renderedAt, syncIntervalMinutes);

  return (
    <div className="min-h-dvh lg:pl-64">
      <a href="#main-content" className="sr-only z-50 rounded-lg bg-card px-4 py-3 font-semibold shadow-lift focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Aller au contenu
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r bg-sidebar lg:block">
        <AdminSidebarContent />
      </aside>

      <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur-sm sm:gap-3 sm:px-6 lg:px-8">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger
            aria-label="Ouvrir le menu"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 lg:hidden"
          >
            <Menu className="size-5" />
          </SheetTrigger>
          <SheetContent side="left" className="bg-sidebar p-0 data-[side=left]:w-72">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription className="sr-only">Navigation de l&apos;espace administrateur</SheetDescription>
            <AdminSidebarContent onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Sheet>

        <OrgSwitcher />
        <Link
          href="/admin/synchronisation"
          title={health.detail}
          data-testid="last-sync"
          data-level={health.level}
          className={cn(
            "ml-auto flex h-8 min-w-0 items-center gap-2 rounded-full px-2.5 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            health.level === "ok" || health.level === "never" ? "text-muted-foreground hover:text-foreground" : TONE_CLASSES[health.tone].badge,
          )}
        >
          <span className={cn("size-2 shrink-0 rounded-full", TONE_CLASSES[health.tone].dot, health.level === "running" && "animate-pulse")} aria-hidden="true" />
          <span className="truncate max-md:sr-only">{health.label}</span>
        </Link>
        <AutoSync lastSyncAt={lastSyncAt} disabled={unavailable !== null} />
        <SyncButton />
        <UserMenu profile={profile} notificationsHref="/admin/notifications" />
      </header>

      {unavailable && (
        <p role="status" data-testid="buffer-indisponible" className="border-b bg-tone-amber-soft px-4 py-2 text-sm text-tone-amber sm:px-6 lg:px-8">
          {unavailable}{" "}
          <Link href="/admin/parametres#integrations" className="font-semibold underline underline-offset-4">Paramètres → Intégrations</Link>
        </p>
      )}
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
