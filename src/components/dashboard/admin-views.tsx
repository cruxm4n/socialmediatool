"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, CalendarDays, CircleAlert, CircleCheckBig, Clock, Inbox, MessageSquareWarning, PartyPopper, TriangleAlert, type LucideIcon } from "lucide-react";

import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { EditorialCalendar } from "@/components/calendar/editorial-calendar";
import { AttentionBanner } from "@/components/dashboard/attention-banner";
import { ActivityTimeline } from "@/components/publications/activity";
import { PostCard } from "@/components/publications/post-card";
import { NetworkIcon } from "@/components/shared/network-icon";
import { EmptyState, PageHeader } from "@/components/shared/page-header";
import { statusBar, TONE_CLASSES } from "@/components/shared/status-badge";
import { matchesOrgFilter, useAdmin } from "@/components/shell/admin-context";
import { SyncButton } from "@/components/shell/sync-button";
import { Button } from "@/components/ui/button";
import { leaveIfExpired } from "@/lib/action-result";
import { addDays, capitalize, dayKeyOf, dayNumber, formatDateTime, formatDayLong, timeOf, weekdayLabel, zonedToUtcIso, type DayKey } from "@/lib/dates";
import { canMoveTo, findConflicts } from "@/lib/domain/studio";
import { buildInbox } from "@/lib/domain/inbox";
import type { Tone } from "@/lib/domain/status";
import { DISPLAY_STATUSES, type Channel, type DisplayStatus, type PostEvent, type Profile } from "@/lib/types";
import { DEFAULT_TIMEZONE, studioDraftIdOf, type PostView } from "@/lib/view";
import { moveCalendarItem } from "@/server/studio-actions";
import { cn } from "@/lib/utils";

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

  const inbox = buildInbox(scoped, now);
  // Les validations en attente dépendent du client : elles figurent dans le bandeau, pas dans les cartes à reprendre.
  const toHandle = inbox.filter((group) => group.key !== "pending").flatMap((group) => group.posts);
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

      {lastSyncAt && <AttentionBanner groups={inbox} />}

      {unassigned.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-tone-amber-soft px-4 py-3 text-sm text-tone-amber">
          <CircleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 basis-64">
            {unassigned.length} {unassigned.length > 1 ? "canaux" : "canal"} Buffer {unassigned.length > 1 ? "ne sont rattachés" : "n'est rattaché"} à aucun client : {unassigned.length > 1 ? "leurs" : "ses"} publications ne peuvent être validées par personne.
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
            À reprendre en priorité
          </h2>
          {toHandle.length === 0 ? (
            <EmptyState icon={PartyPopper} title="Rien à reprendre" description="Aucune erreur, aucun retard, aucune demande de modification." />
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

export function AdminCalendarView({ posts, studioPosts = [], now }: { posts: PostView[]; studioPosts?: PostView[]; now: string }) {
  const { orgFilter } = useAdmin();
  const router = useRouter();
  const [moving, startMove] = useTransition();
  const [pending, setPending] = useState<{ post: PostView; dueAt: string; reasons: string[] } | null>(null);
  // Les contenus du Studio pas encore envoyés à Buffer figurent au calendrier comme des brouillons.
  const scoped = [...posts, ...studioPosts].filter((post) => matchesOrgFilter(orgFilter, post.organization?.id));

  const run = (post: PostView, dueAt: string) =>
    startMove(async () => {
      setPending(null);
      const draftId = studioDraftIdOf(post.id);
      try {
        const result = await moveCalendarItem(draftId ? { kind: "studio", draftId, dueAt } : { kind: "post", postId: post.id, dueAt });
        if (leaveIfExpired(result)) return;
        if (result.ok) toast.success(result.message);
        else toast.error("Date inchangée", { description: result.message });
      } catch {
        toast.error("La confirmation n'a pas été reçue", { description: "Rechargez le calendrier pour vérifier la date avant de réessayer." });
      }
      router.refresh();
    });

  const onMove = (post: PostView, day: DayKey) => {
    if (!post.dueAt || moving) return;
    // Le jour change, l'heure est conservée, dans le fuseau du client.
    const dueAt = zonedToUtcIso(day, timeOf(post.dueAt, post.timezone), post.timezone);
    if (!canMoveTo(dueAt, new Date().toISOString())) {
      toast.error("Impossible de déplacer une publication dans le passé.");
      return;
    }
    const reasons: string[] = [];
    if (post.approvalStatus === "approved") reasons.push("Cette publication est approuvée. La date fait partie de ce que le client a validé : la changer annule son accord, il devra le redonner.");
    for (const other of findConflicts(dueAt, [post.channelId], scoped.map((item) => ({ id: item.id, channelId: item.channelId, dueAt: item.dueAt, title: item.title })), [post.id])) {
      reasons.push(`Une autre publication est déjà prévue sur ce canal à ${formatDateTime(other.dueAt!, post.timezone)} : « ${other.title} ».`);
    }
    if (reasons.length > 0) setPending({ post, dueAt, reasons });
    else run(post, dueAt);
  };

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader
        title="Calendrier"
        description="Toutes les publications à leur date prévue : celles de Buffer et les contenus en préparation dans le Studio. Le client affiché dépend du sélecteur en haut de page."
      />
      <EditorialCalendar
        posts={scoped}
        now={now}
        statuses={DISPLAY_STATUSES}
        showOrg={orgFilter === "all"}
        hrefFor={(post) => {
          const draftId = studioDraftIdOf(post.id);
          return draftId ? `/admin/studio/${draftId}` : `/admin/publications/${post.id}`;
        }}
        reschedule={{ canMove: (post) => !post.removedAt && post.bufferStatus === "draft" && !!post.dueAt, onMove }}
      />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title="Changer la date de cette publication ?"
        confirmLabel="Déplacer quand même"
        pending={moving}
        onConfirm={() => pending && run(pending.post, pending.dueAt)}
      >
        {pending && (
          <>
            <p>
              « {pending.post.title} » passerait au <span className="font-medium text-foreground">{formatDateTime(pending.dueAt, pending.post.timezone)}</span>.
            </p>
            <ul className="mt-2 grid list-disc gap-1 pl-5">
              {pending.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
