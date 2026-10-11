import Link from "next/link";
import { ArrowRight, PartyPopper } from "lucide-react";

import { TONE_CLASSES } from "@/components/shared/status-badge";
import { INBOX_META, type InboxGroup } from "@/lib/domain/inbox";
import { cn } from "@/lib/utils";

/** Bandeau « À traiter » : une tuile par nature de problème, qui ouvre la liste filtrée. */
export function AttentionBanner({ groups }: { groups: InboxGroup<{ id: string }>[] }) {
  const total = groups.reduce((sum, group) => sum + group.posts.length, 0);

  if (total === 0) {
    return (
      <section aria-labelledby="attention-title" className="flex items-center gap-3 rounded-2xl border bg-card px-5 py-4" data-testid="attention-banner">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-tone-green-soft text-tone-green">
          <PartyPopper className="size-[18px]" />
        </span>
        <p className="text-sm">
          <span id="attention-title" className="font-semibold">
            Rien à traiter.
          </span>{" "}
          <span className="text-muted-foreground">Aucune erreur, aucun retard, aucune validation en attente, rien à programmer.</span>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="attention-title" className="rounded-2xl border bg-card p-4 sm:p-5" data-testid="attention-banner">
      <h2 id="attention-title" className="flex items-baseline gap-2 font-display text-xl font-medium">
        À traiter
        <span className="text-sm font-normal text-muted-foreground tabular-nums">
          {total} publication{total > 1 ? "s" : ""}
        </span>
      </h2>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => {
          const meta = INBOX_META[group.key];
          return (
            <li key={group.key}>
              <Link
                href={`/admin/publications?filtre=${group.key}`}
                data-inbox={group.key}
                className="group flex h-full items-center gap-3 rounded-xl border px-3 py-2.5 outline-none transition-shadow hover:shadow-soft focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg font-display text-xl font-medium tabular-nums", TONE_CLASSES[meta.tone].badge)}>
                  {group.posts.length}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{meta.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {group.urgent > 0 ? `${group.urgent} à publier dans moins de 48 h. ` : ""}
                    {meta.hint}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
