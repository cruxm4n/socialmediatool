"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { OrgAvatar } from "@/components/shared/org-avatar";
import { Brand } from "@/components/shell/brand";
import { clientNav, isActive } from "@/components/shell/nav";
import { UserMenu } from "@/components/shell/user-menu";
import type { Organization, Profile } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ClientShell({
  organization,
  profile,
  pendingCount,
  children,
}: {
  organization: Organization;
  profile: Profile;
  pendingCount: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const basePath = `/client/${organization.slug}`;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Brand href={basePath} />
          <span className="h-6 w-px bg-border" aria-hidden="true" />
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <OrgAvatar organization={organization} size="sm" />
            <span className="truncate">{organization.name}</span>
          </span>
          <span className="ml-auto" />
          <UserMenu profile={profile} />
        </div>
        <div className="mx-auto w-full max-w-6xl px-1 sm:px-3">
          <nav aria-label="Navigation de l'espace client" className="-mb-px flex gap-1 overflow-x-auto">
            {clientNav(organization.slug).map((item) => {
              const active = isActive(item, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-11 shrink-0 items-center gap-2 px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <item.icon className="size-4" />
                  {item.label}
                  {item.href.endsWith("/a-valider") && pendingCount > 0 && (
                    <span className="rounded-full bg-tone-amber-soft px-1.5 text-[11px] font-semibold text-tone-amber tabular-nums" data-testid="pending-count">
                      {pendingCount}
                    </span>
                  )}
                  {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground" aria-hidden="true" />}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
    </div>
  );
}
