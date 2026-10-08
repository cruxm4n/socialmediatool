"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CircleCheckBig, FileSearch, PartyPopper } from "lucide-react";

import { EditorialCalendar } from "@/components/calendar/editorial-calendar";
import { ActivityTimeline } from "@/components/publications/activity";
import { PostCard } from "@/components/publications/post-card";
import { StatusBanner } from "@/components/publications/post-panels";
import { MediaThumb } from "@/components/shared/media-thumb";
import { NetworkIcon } from "@/components/shared/network-icon";
import { EmptyState, PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { capitalize, dayKeyOf, formatDateTime, formatDayLong } from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { canDecide, CLIENT_EVENT_TYPES, STATUS_META } from "@/lib/domain/status";
import type { DisplayStatus, Organization, PostEvent, Profile } from "@/lib/types";
import type { PostView } from "@/lib/view";
import { cn } from "@/lib/utils";

/** Statuts qu'un client peut rencontrer : un brouillon non soumis ne lui est jamais transmis par la base. */
const CLIENT_STATUSES: DisplayStatus[] = ["pending_approval", "changes_requested", "approved", "scheduled", "published", "error"];

interface SpaceProps {
  organization: Organization;
  posts: PostView[];
  now: string;
}

const basePathOf = (organization: Organization) => `/client/${organization.slug}`;

export function ClientOverview({ organization, posts, now, profile }: SpaceProps & { profile: Profile }) {
  const basePath = basePathOf(organization);
  const pending = posts.filter(canDecide);
  const upcoming = posts
    .filter((post) => post.dueAt !== null && post.dueAt > now && post.status !== "published")
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
    .slice(0, 6);

  return (
    <div className="grid animate-rise grid-cols-1 gap-8">
      <PageHeader title={`Bonjour ${profile.fullName.split(" ")[0]}`} description={capitalize(formatDayLong(dayKeyOf(now, organization.timezone)))} />

      {pending.length > 0 ? (
        <StatusBanner
          tone="amber"
          icon={CircleCheckBig}
          title={`${pending.length} publication${pending.length > 1 ? "s attendent" : " attend"} votre validation`}
          action={
            <Button asChild size="lg">
              <Link href={`${basePath}/a-valider`}>
                Voir les propositions <ArrowRight />
              </Link>
            </Button>
          }
        >
          Relisez chaque proposition, puis approuvez-la ou demandez des modifications.
        </StatusBanner>
      ) : (
        <StatusBanner tone="green" icon={PartyPopper} title="Tout est à jour">
          Aucune proposition n&apos;attend votre validation pour le moment.
        </StatusBanner>
      )}

      {pending.length > 0 && (
        <section aria-labelledby="pending-title">
          <h2 id="pending-title" className="mb-3 font-display text-xl font-medium">
            À valider
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pending.slice(0, 6).map((post) => (
              <PostCard key={post.id} post={post} href={`${basePath}/publications/${post.id}`} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="upcoming-title">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="upcoming-title" className="font-display text-xl font-medium">
            Prochaines publications
          </h2>
          <Link href={`${basePath}/calendrier`} className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            Calendrier <ArrowRight className="size-3.5" />
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <EmptyState icon={FileSearch} title="Aucune publication à venir" />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-card">
            {upcoming.map((post) => (
              <li key={post.id} className="border-b last:border-b-0">
                <Link
                  href={`${basePath}/publications/${post.id}`}
                  className="flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
                >
                  <NetworkIcon network={post.network} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{post.title}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">{formatDateTime(post.dueAt!, post.timezone)}</span>
                  </span>
                  <StatusBadge status={post.status} className="max-sm:hidden" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ClientCalendarView({ organization, posts, now }: SpaceProps) {
  const basePath = basePathOf(organization);
  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="Calendrier" description="Les publications qui vous ont été proposées, à leur date prévue." />
      <EditorialCalendar posts={posts} now={now} statuses={CLIENT_STATUSES} hrefFor={(post) => `${basePath}/publications/${post.id}`} />
    </div>
  );
}

export function ApprovalsView({ organization, posts }: SpaceProps) {
  const basePath = basePathOf(organization);
  const pending = posts.filter(canDecide);

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="À valider" description="Les propositions de votre agence qui attendent votre décision." />
      {pending.length === 0 ? (
        <EmptyState
          icon={PartyPopper}
          title="Tout est validé"
          description="Les nouvelles propositions de votre agence apparaîtront ici."
          action={
            <Button asChild variant="outline" size="lg">
              <Link href={`${basePath}/publications`}>Voir toutes les publications</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4">
          {pending.map((post) => (
            <li key={post.id}>
              <Link
                href={`${basePath}/publications/${post.id}`}
                data-post={post.bufferPostId}
                className="group flex flex-col overflow-hidden rounded-2xl border bg-card outline-none transition-all hover:shadow-lift focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-row"
              >
                <MediaThumb asset={post.assets[0]} className="aspect-16/10 w-full shrink-0 sm:aspect-square sm:w-44" />
                <div className="flex min-w-0 flex-1 flex-col gap-2 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={post.status} />
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <NetworkIcon network={post.network} size="xs" /> {NETWORK_LABELS[post.network]} · version {post.version}
                    </span>
                  </div>
                  <p className="line-clamp-3 leading-relaxed">{post.text || "Post sans texte"}</p>
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {post.dueAt ? `Prévue le ${formatDateTime(post.dueAt, post.timezone)}` : "Date à définir"}
                    </span>
                    <span className="flex items-center gap-1 text-sm font-semibold">
                      Relire et décider <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ClientPostsView({ organization, posts }: SpaceProps) {
  const basePath = basePathOf(organization);
  const [status, setStatus] = useState<DisplayStatus | "all">("all");
  const filtered = posts.filter((post) => status === "all" || post.status === status);
  const options: (DisplayStatus | "all")[] = ["all", ...CLIENT_STATUSES.filter((value) => posts.some((post) => post.status === value))];

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="Publications" description="Toutes les propositions qui vous ont été présentées." />
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="tablist" aria-label="Filtrer par statut">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={status === option}
            onClick={() => setStatus(option)}
            className={cn(
              "h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              status === option ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {option === "all" ? "Toutes" : STATUS_META[option].label}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon={FileSearch} title="Aucune publication" description="Aucune proposition ne correspond à ce filtre." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((post) => (
            <PostCard key={post.id} post={post} href={`${basePath}/publications/${post.id}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ClientHistoryView({
  organization,
  posts,
  events,
  profiles,
}: SpaceProps & { events: PostEvent[]; profiles: Profile[] }) {
  const basePath = basePathOf(organization);
  const titles = new Map(posts.map((post) => [post.id, post.title]));
  const list = events.filter((event) => titles.has(event.postId) && CLIENT_EVENT_TYPES.includes(event.type));

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="Historique" description="Les propositions reçues, vos décisions et les publications effectuées." />
      <div className="rounded-2xl border bg-card p-5 sm:p-6">
        <ActivityTimeline
          events={list}
          profiles={profiles}
          timezone={organization.timezone}
          renderContext={(event) => (
            <Link href={`${basePath}/publications/${event.postId}`} className="block truncate text-xs font-medium text-brand hover:underline">
              {titles.get(event.postId)}
            </Link>
          )}
        />
      </div>
    </div>
  );
}
