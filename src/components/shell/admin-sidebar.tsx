"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useAdmin } from "@/components/shell/admin-context";
import { Brand } from "@/components/shell/brand";
import { ADMIN_NAV, isActive } from "@/components/shell/nav";
import { cn } from "@/lib/utils";

export function AdminSidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { mode, buffer } = useAdmin();
  const state = bufferState(mode, buffer);

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
        <p className="flex items-center gap-2 font-semibold text-foreground" data-testid="etat-buffer" data-state={state.key}>
          <span className={cn("size-2 shrink-0 rounded-full", state.dot)} />
          {state.title}
        </p>
        <p className="mt-1">{state.text}</p>
        {state.link && (
          <Link href="/admin/parametres#integrations" onClick={onNavigate} className="mt-1 inline-block font-medium text-foreground underline-offset-4 hover:underline">
            {state.link}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Ce que le menu dit de Buffer : uniquement ce qui est vrai sur ce serveur à cet instant. */
function bufferState(mode: "real" | "mock", buffer: { accounts: number; writesEnabled: boolean; problem: string | null }) {
  if (mode === "mock") return { key: "simule", dot: "bg-tone-amber", title: "Buffer simulé", text: "Données fictives de démonstration : aucun appel à Buffer.", link: null };
  if (buffer.problem) return { key: "configuration", dot: "bg-tone-red", title: "Buffer : configuration à corriger", text: "Aucune opération vers Buffer n'a lieu tant que la configuration du serveur n'est pas corrigée.", link: "Voir les paramètres" };
  if (buffer.accounts === 0) return { key: "aucun-compte", dot: "bg-tone-red", title: "Aucun compte Buffer connecté", text: "Rien n'est lu ni envoyé. Connectez le compte Buffer de chaque client.", link: "Connecter un compte" };
  const accounts = `${buffer.accounts} compte${buffer.accounts > 1 ? "s" : ""} Buffer connecté${buffer.accounts > 1 ? "s" : ""}`;
  if (!buffer.writesEnabled) return { key: "lecture-seule", dot: "bg-tone-amber", title: `${accounts} — lecture seule`, text: "Les publications sont lues dans Buffer. La programmation après accord est désactivée : elle s'y fait à la main.", link: null };
  return { key: "connecte", dot: "bg-tone-green", title: accounts, text: "Les publications se créent dans Buffer. Dès qu'un client approuve un brouillon, Cadence le programme à sa date.", link: null };
}
