"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useAdmin } from "@/components/shell/admin-context";
import { Brand } from "@/components/shell/brand";
import { ADMIN_NAV, isActive } from "@/components/shell/nav";
import { cn } from "@/lib/utils";

export function AdminSidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { mode } = useAdmin();

  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Brand href="/admin" className="px-1 pt-1" />
      <nav aria-label="Navigation principale" className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {ADMIN_NAV.map((item) => {
          const active = isActive(item, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                active ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              <item.icon className={cn("size-4 shrink-0", active ? "text-brand" : "text-muted-foreground group-hover:text-foreground")} />
              <span className="flex-1 truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="rounded-xl border bg-card p-3 text-xs leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <span className={cn("size-2 rounded-full", mode === "real" ? "bg-tone-green" : "bg-tone-amber")} />
          {mode === "real" ? "Connecté à Buffer" : "Buffer simulé"}
        </p>
        <p className="mt-1">
          {mode === "real"
            ? "Les publications se créent dans Buffer. Ce tableau de bord gère leur validation."
            : "Données fictives de démonstration : aucun appel à Buffer."}
        </p>
      </div>
    </div>
  );
}
