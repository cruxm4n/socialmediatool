"use client";

import { useState } from "react";
import Link from "next/link";
import { FileSearch, Search } from "lucide-react";

import { MediaThumb } from "@/components/shared/media-thumb";
import { NetworkIcon } from "@/components/shared/network-icon";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { EmptyState, PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { matchesOrgFilter, useAdmin } from "@/components/shell/admin-context";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { STATUS_META } from "@/lib/domain/status";
import { DISPLAY_STATUSES, type DisplayStatus } from "@/lib/types";
import type { PostView } from "@/lib/view";
import { cn } from "@/lib/utils";

const normalize = (value: string) => value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function PostsView({ posts, initialStatus = "all" }: { posts: PostView[]; initialStatus?: DisplayStatus | "all" }) {
  const { orgFilter, organizations } = useAdmin();
  const [status, setStatus] = useState<DisplayStatus | "all">(initialStatus);
  const [query, setQuery] = useState("");

  const scoped = posts.filter((post) => matchesOrgFilter(orgFilter, post.organization?.id));
  const needle = normalize(query.trim());
  const filtered = scoped.filter(
    (post) =>
      (status === "all" || post.status === status) &&
      (needle.length === 0 || normalize(`${post.text} ${post.organization?.name ?? ""} ${NETWORK_LABELS[post.network]}`).includes(needle)),
  );

  const tabs: { value: DisplayStatus | "all"; label: string; count: number }[] = [
    { value: "all", label: "Toutes", count: scoped.length },
    ...DISPLAY_STATUSES.map((value) => ({
      value,
      label: STATUS_META[value].label,
      count: scoped.filter((post) => post.status === value).length,
    })),
  ];
  const selectedOrg = organizations.find((organization) => organization.id === orgFilter);

  return (
    <div className="grid animate-rise gap-6">
      <PageHeader
        title="Publications"
        description={
          selectedOrg
            ? `Les publications Buffer de ${selectedOrg.name}.`
            : "Toutes les publications récupérées dans Buffer, tous clients confondus."
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="-mx-4 flex flex-1 gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="tablist" aria-label="Filtrer par statut">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              onClick={() => setStatus(tab.value)}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                status === tab.value ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              <span className={cn("text-xs tabular-nums", status === tab.value ? "text-primary-foreground/70" : "text-muted-foreground/70")}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            aria-label="Rechercher une publication"
            placeholder="Rechercher…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full rounded-lg border bg-card pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          title="Aucune publication ici"
          description={
            posts.length === 0
              ? "Aucun post n'a encore été récupéré. Créez un brouillon dans Buffer puis lancez une synchronisation."
              : "Aucune publication ne correspond à ces filtres."
          }
          action={
            (status !== "all" || query) && (
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  setStatus("all");
                  setQuery("");
                }}
              >
                Effacer les filtres
              </Button>
            )
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-2xl border bg-card">
          {filtered.map((post) => (
            <li key={post.id} className="border-b last:border-b-0">
              <Link
                href={`/admin/publications/${post.id}`}
                data-post={post.bufferPostId}
                className="flex items-center gap-3 px-3 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 sm:gap-4 sm:px-4"
              >
                <MediaThumb asset={post.assets[0]} className="size-14 shrink-0 rounded-xl sm:size-16" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{post.title}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                    {post.organization ? (
                      <>
                        <OrgAvatar organization={post.organization} size="sm" className="size-4 rounded-[4px] text-[8px]" />
                        <span className="truncate">{post.organization.name}</span>
                      </>
                    ) : (
                      <span className="font-medium text-tone-amber">Canal non rattaché à un client</span>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>v{post.version}</span>
                  </p>
                  <div className="mt-2 flex items-center gap-3 md:hidden">
                    <StatusBadge status={post.status} />
                  </div>
                </div>
                <span className="flex w-28 shrink-0 items-center gap-2 text-sm text-muted-foreground max-md:hidden">
                  <NetworkIcon network={post.network} /> {NETWORK_LABELS[post.network]}
                </span>
                <p className="hidden w-36 shrink-0 text-sm text-muted-foreground tabular-nums lg:block">
                  {post.dueAt ? formatDateTime(post.dueAt, post.timezone) : "Sans date"}
                </p>
                <div className="hidden w-52 shrink-0 justify-end md:flex">
                  <StatusBadge status={post.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
