"use client";

import { useState } from "react";
import { Menu } from "lucide-react";

import { AdminSidebarContent } from "@/components/shell/admin-sidebar";
import { useAdmin } from "@/components/shell/admin-context";
import { OrgSwitcher } from "@/components/shell/org-switcher";
import { SyncButton } from "@/components/shell/sync-button";
import { UserMenu } from "@/components/shell/user-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { formatDateTime } from "@/lib/dates";
import { DEFAULT_TIMEZONE } from "@/lib/view";
import { cn } from "@/lib/utils";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { profile, lastSyncAt, lastSyncFailed } = useAdmin();

  return (
    <div className="min-h-dvh lg:pl-64">
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
        <p
          className={cn("ml-auto hidden text-xs md:block", lastSyncFailed ? "font-medium text-tone-red" : "text-muted-foreground")}
          data-testid="last-sync"
        >
          {lastSyncAt
            ? `${lastSyncFailed ? "Dernière synchronisation en échec" : "Dernière synchronisation"} : ${formatDateTime(lastSyncAt, DEFAULT_TIMEZONE)}`
            : "Jamais synchronisé"}
        </p>
        <span className="ml-auto md:hidden" />
        <SyncButton />
        <UserMenu profile={profile} />
      </header>

      <main className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
