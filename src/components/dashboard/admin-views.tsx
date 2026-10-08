"use client";

import { useTransition } from "react";
import Link from "next/link";
import { ArrowRight, CalendarDays, CircleAlert, CircleCheckBig, Clock, Inbox, MessageSquareWarning, PartyPopper, TriangleAlert, type LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { EditorialCalendar } from "@/components/calendar/editorial-calendar";
import { ActivityTimeline } from "@/components/publications/activity";
import { PostCard } from "@/components/publications/post-card";
import { NetworkIcon } from "@/components/shared/network-icon";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { EmptyState, PageHeader } from "@/components/shared/page-header";
import { statusBar, TONE_CLASSES } from "@/components/shared/status-badge";
import { matchesOrgFilter, useAdmin } from "@/components/shell/admin-context";
import { SyncButton } from "@/components/shell/sync-button";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addDays, capitalize, dayKeyOf, dayNumber, formatDayLong, timeOf, weekdayLabel } from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { getPostAlerts, type Tone } from "@/lib/domain/status";
import { DISPLAY_STATUSES, toNetwork, type Channel, type DisplayStatus, type Organization, type PostEvent, type Profile } from "@/lib/types";
import { DEFAULT_TIMEZONE, type PostView } from "@/lib/view";
import { cn } from "@/lib/utils";
import { leaveIfExpired } from "@/lib/action-result";
import { assignChannel } from "@/server/actions";

function Stat({ icon: Icon, tone, value, label, hint, status }: { icon: LucideIcon; tone: Tone; value: number; label: string; hint: string; status: DisplayStatus }) {
  return (
    <Link
      href={`/admin/publications?statut=${status}`}
      className="rounded-2xl border bg-card p-4 outline-none transition-shadow hover:shadow-soft focus-visible:ring-3 focus-visible:ring-ring/50 sm:p-5"
    >
      <div className="flex items-center justify-between">
        <span className={cn("flex size-9 items-center justify-center rounded-xl", TONE_CLASSES[tone].badge)}>
          <Icon className="size-[18px]" />
        </span>
        <span className="font-display text-4xl font-medium tabular-nums">{value}</span>
      </div>
      <p className="mt-4 text-sm font-semibold">{label}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </Link>
  );
}

export function AdminOverview({
  posts,
  events,
  profiles,
  channels,
  now,
}: {
  posts: PostView[];
  events: PostEvent[];
  profiles: Profile[];
  channels: Channel[];
  now: string;
}) {
  const { profile, orgFilter, organizations, lastSyncAt } = useAdmin();
  const today = dayKeyOf(now, DEFAULT_TIMEZONE);
  const scoped = posts.filter((post) => matchesOrgFilter(orgFilter, post.organization?.id));
  const scopedIds = new Set(scoped.map((post) => post.id));
  const titles = new Map(posts.map((post) => [post.id, post.title]));

  const days = Array.from({ length: 7 }, (_, index) => addDays(today, index));
  const upcoming = scoped
    .filter((post) => post.dueAt)
    .map((post) => ({ post, day: dayKeyOf(post.dueAt!, post.timezone), time: timeOf(post.dueAt!, post.timezone) }))
    .filter((item) => days.includes(item.day))
    .sort((a, b) => a.time.localeCompare(b.time));

  const toHandle = scoped.filter((post) => post.status === "changes_requested" || post.status === "error" || getPostAlerts(post, now).length > 0);
  const unassigned = channels.filter((channel) => !channel.organizationId);
  const selectedOrg = organizations.find((organization) => organization.id === orgFilter);

  return (
    <div className="grid animate-rise grid-cols-1 gap-8">
      <PageHeader
        title={`Bonjour ${profile.fullName.split(" ")[0]}`}
        description={
          <>
            {capitalize(formatDayLong(today))} · {selectedOrg ? selectedOrg.name : `${organizations.length} client${organizations.length > 1 ? "s" : ""} suivi${organizations.length > 1 ? "s" : ""}`}
          </>
        }
        actions={
          <Button asChild variant="outline" size="lg">
            <Link href="/admin/calendrier">
              <CalendarDays /> Ouvrir le calendrier
            </Link>
          </Button>
        }
      />

      {!lastSyncAt && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-dashed p-5">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Inbox className="size-5" />
          </span>
          <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">
            <span className="block font-semibold text-foreground">Aucune synchronisation pour l&apos;instant</span>
            Lancez-en une pour récupérer vos canaux et vos brouillons depuis Buffer.
          </p>
          <SyncButton variant="default" label="Première synchronisation" />
        </div>
      )}

      {unassigned.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-tone-amber-soft px-4 py-3 text-sm text-tone-amber">
          <CircleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 basis-64">
            {unassigned.length} canal{unassigned.length > 1 ? "aux" : ""} Buffer {unassigned.length > 1 ? "ne sont rattachés" : "n'est rattaché"} à aucun client : {unassigned.length > 1 ? "leurs" : "ses"} publications ne peuvent être validées par personne.
          </span>
          <Link href="/admin/clients" className="font-semibold underline underline-offset-2">
            Rattacher
          </Link>
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Stat icon={Clock} tone="amber" value={scoped.filter((post) => post.status === "pending_approval").length} label="En attente du client" hint="Soumises à validation" status="pending_approval" />
        <Stat icon={MessageSquareWarning} tone="rose" value={scoped.filter((post) => post.status === "changes_requested").length} label="Modifications demandées" hint="À reprendre dans Buffer" status="changes_requested" />
        <Stat icon={CircleCheckBig} tone="blue" value={scoped.filter((post) => post.status === "scheduled").length} label="Programmées" hint="Dans Buffer, à venir" status="scheduled" />
        <Stat icon={TriangleAlert} tone="red" value={scoped.filter((post) => post.status === "error").length} label="Erreurs" hint="À vérifier" status="error" />
      </div>

      <section aria-labelledby="week-title">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="week-title" className="font-display text-xl font-medium">
            Les sept prochains jours
          </h2>
          <Link href="/admin/calendrier" className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            Calendrier complet <ArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <div className="grid min-w-[52rem] grid-cols-7 overflow-hidden rounded-2xl border bg-card">
            {days.map((day) => {
              const items = upcoming.filter((item) => item.day === day);
              return (
                <div key={day} className="min-h-40 border-r p-2.5 last:border-r-0">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <span className="capitalize">{weekdayLabel(day)}</span>
                    <span className={cn("flex size-6 items-center justify-center rounded-full tabular-nums", day === today && "bg-brand font-semibold text-brand-foreground")}>
                      {dayNumber(day)}
                    </span>
                  </p>
                  <ul className="mt-2 grid gap-1.5">
                    {items.map(({ post, time }) => (
                      <li key={post.id}>
                        <Link
                          href={`/admin/publications/${post.id}`}
                          className="relative block overflow-hidden rounded-lg border py-1.5 pr-2 pl-3 outline-none transition-shadow hover:shadow-soft focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <span className={cn("absolute inset-y-0 left-0 w-1", statusBar(post.status))} />
                          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                            <NetworkIcon network={post.network} size="xs" />
                            {time}
                          </span>
                          <span className="mt-0.5 line-clamp-2 text-xs leading-snug font-medium">{post.title}</span>
                        </Link>
                      </li>
                    ))}
                    {items.length === 0 && <li className="pt-1 text-xs text-muted-foreground/60">—</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="todo-title">
          <h2 id="todo-title" className="mb-3 font-display text-xl font-medium">
            À traiter
          </h2>
          {toHandle.length === 0 ? (
            <EmptyState icon={PartyPopper} title="Rien à traiter" description="Aucune demande de modification ni erreur en cours." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {toHandle.slice(0, 6).map((post) => (
                <PostCard key={post.id} post={post} href={`/admin/publications/${post.id}`} showOrg />
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="activity-title">
          <h2 id="activity-title" className="mb-4 text-sm font-semibold">
            Activité récente
          </h2>
          <ActivityTimeline
            events={events.filter((event) => scopedIds.has(event.postId)).slice(0, 8)}
            profiles={profiles}
            timezone={DEFAULT_TIMEZONE}
            renderContext={(event) => (
              <Link href={`/admin/publications/${event.postId}`} className="block truncate text-xs font-medium text-brand hover:underline">
                {titles.get(event.postId)}
              </Link>
            )}
          />
        </section>
      </div>
    </div>
  );
}

export function AdminCalendarView({ posts, now }: { posts: PostView[]; now: string }) {
  const { orgFilter } = useAdmin();
  const scoped = posts.filter((post) => matchesOrgFilter(orgFilter, post.organization?.id));
  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="Calendrier" description="Toutes les publications Buffer à leur date prévue. Le client affiché dépend du sélecteur en haut de page." />
      <EditorialCalendar
        posts={scoped}
        now={now}
        statuses={DISPLAY_STATUSES}
        showOrg={orgFilter === "all"}
        hrefFor={(post) => `/admin/publications/${post.id}`}
      />
    </div>
  );
}

const UNASSIGNED = "none";

function ChannelRow({ channel, organizations }: { channel: Channel; organizations: Organization[] }) {
  const [pending, startTransition] = useTransition();
  const network = toNetwork(channel.service);

  const change = (value: string) =>
    startTransition(async () => {
      const result = await assignChannel({ channelId: channel.id, organizationId: value === UNASSIGNED ? null : value });
      if (leaveIfExpired(result)) return;
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    });

  return (
    <li className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0" data-channel={channel.bufferChannelId}>
      <NetworkIcon network={network} size="md" />
      <span className="min-w-0 flex-1 basis-40">
        <span className="block truncate text-sm font-medium">{channel.displayName || channel.name}</span>
        <span className="block text-xs text-muted-foreground">
          {NETWORK_LABELS[network]}
          {channel.isDisconnected && <span className="font-medium text-tone-red"> · déconnecté dans Buffer</span>}
        </span>
      </span>
      <Select value={channel.organizationId ?? UNASSIGNED} onValueChange={change} disabled={pending}>
        <SelectTrigger className="h-9! w-56 bg-card" aria-label={`Client du canal ${channel.displayName || channel.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>Non rattaché</SelectItem>
          {organizations.map((organization) => (
            <SelectItem key={organization.id} value={organization.id}>
              {organization.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </li>
  );
}

export function ClientsView({
  channels,
  profiles,
  members,
  posts,
}: {
  channels: Channel[];
  profiles: Profile[];
  members: { organizationId: string; userId: string }[];
  posts: PostView[];
}) {
  const { organizations } = useAdmin();

  return (
    <div className="grid animate-rise grid-cols-1 gap-8">
      <PageHeader title="Clients" description="Chaque canal Buffer est rattaché à un client : c'est ce lien qui détermine ce que le client voit." />

      <section aria-labelledby="channels-title">
        <h2 id="channels-title" className="mb-3 font-display text-xl font-medium">
          Canaux Buffer
        </h2>
        {channels.length === 0 ? (
          <EmptyState icon={Inbox} title="Aucun canal" description="Lancez une synchronisation pour récupérer vos canaux Buffer." action={<SyncButton variant="default" />} />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-card">
            {channels.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} organizations={organizations} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="orgs-title">
        <h2 id="orgs-title" className="mb-3 font-display text-xl font-medium">
          Organisations
        </h2>
        <div className="grid gap-5 lg:grid-cols-2">
          {organizations.map((organization) => {
            const users = members
              .filter((member) => member.organizationId === organization.id)
              .map((member) => profiles.find((profile) => profile.id === member.userId))
              .filter((profile): profile is Profile => profile !== undefined);
            const orgChannels = channels.filter((channel) => channel.organizationId === organization.id);
            const pending = posts.filter((post) => post.organization?.id === organization.id && post.status === "pending_approval").length;
            return (
              <article key={organization.id} className="rounded-2xl border bg-card p-5 sm:p-6" data-org={organization.slug}>
                <div className="flex items-start gap-4">
                  <OrgAvatar organization={organization} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-xl font-medium">{organization.name}</h3>
                    <p className="text-sm text-muted-foreground">{organization.sector}</p>
                  </div>
                </div>
                <dl className="mt-5 grid gap-4 text-sm">
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Canaux</dt>
                    <dd className="mt-1.5 flex flex-wrap gap-2">
                      {orgChannels.length === 0 && <span className="text-tone-amber">Aucun canal rattaché</span>}
                      {orgChannels.map((channel) => (
                        <span key={channel.id} className="flex items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1 text-xs font-medium">
                          <NetworkIcon network={toNetwork(channel.service)} size="sm" className="rounded-full" />
                          {channel.displayName || channel.name}
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Utilisateurs</dt>
                    <dd className="mt-1.5 grid gap-1">
                      {users.length === 0 && <span className="text-muted-foreground">Aucun utilisateur</span>}
                      {users.map((user) => (
                        <span key={user.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="font-medium">{user.fullName}</span>
                          <span className="text-muted-foreground">{user.jobTitle}</span>
                        </span>
                      ))}
                    </dd>
                  </div>
                </dl>
                <p className="mt-5 border-t pt-4 text-sm text-muted-foreground">
                  {pending === 0 ? "Aucune validation en attente." : `${pending} publication${pending > 1 ? "s" : ""} en attente de validation.`}
                </p>
              </article>
            );
          })}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          La création d&apos;un client et de ses utilisateurs se fait pour l&apos;instant dans Supabase (voir README). Un écran dédié reste à construire.
        </p>
      </section>
    </div>
  );
}
