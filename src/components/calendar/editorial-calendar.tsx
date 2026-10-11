"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarX2, Check, ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";

import { MediaThumb } from "@/components/shared/media-thumb";
import { NetworkIcon } from "@/components/shared/network-icon";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { StatusBadge, statusBar } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  addDays,
  addMonths,
  capitalize,
  dayKeyOf,
  dayNumber,
  formatDayLong,
  formatMonthTitle,
  formatWeekTitle,
  isSameMonth,
  monthGrid,
  timeOf,
  weekDays,
  weekdayLabel,
  type DayKey,
} from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { STATUS_META } from "@/lib/domain/status";
import type { DisplayStatus, Network } from "@/lib/types";
import { DEFAULT_TIMEZONE, type PostView } from "@/lib/view";
import { cn } from "@/lib/utils";

type CalendarView = "month" | "week";

interface CalendarEvent {
  post: PostView;
  day: DayKey;
  time: string;
  href: string;
}

const MAX_CHIPS = 3;

/** Calendrier en lecture seule : vues, filtres et consultation des publications. */
export function EditorialCalendar({
  posts,
  now,
  hrefFor,
  statuses,
  showOrg = false,
}: {
  posts: PostView[];
  now: string;
  hrefFor: (post: PostView) => string;
  /** Statuts proposés dans le filtre et la légende. */
  statuses: readonly DisplayStatus[];
  showOrg?: boolean;
}) {
  const today = dayKeyOf(now, DEFAULT_TIMEZONE);
  const availableNetworks = useMemo(() => [...new Set(posts.map((post) => post.network))], [posts]);

  const [view, setView] = useState<CalendarView>("month");
  const [cursor, setCursor] = useState<DayKey>(today);
  const [selectedDay, setSelectedDay] = useState<DayKey>(today);
  const [hiddenNetworks, setHiddenNetworks] = useState<Network[]>([]);
  const [status, setStatus] = useState<DisplayStatus | "all">("all");

  const eventsByDay = useMemo(() => {
    const map = new Map<DayKey, CalendarEvent[]>();
    for (const post of posts) {
      if (!post.dueAt) continue;
      if (hiddenNetworks.includes(post.network)) continue;
      if (status !== "all" && post.status !== status) continue;
      const event: CalendarEvent = {
        post,
        day: dayKeyOf(post.dueAt, post.timezone),
        time: timeOf(post.dueAt, post.timezone),
        href: hrefFor(post),
      };
      const list = map.get(event.day);
      if (list) list.push(event);
      else map.set(event.day, [event]);
    }
    for (const list of map.values()) list.sort((a, b) => a.time.localeCompare(b.time));
    return map;
  }, [posts, hiddenNetworks, status, hrefFor]);

  const move = (direction: 1 | -1) => {
    const next = view === "month" ? addMonths(cursor, direction) : addDays(cursor, 7 * direction);
    setCursor(next);
    setSelectedDay(next);
  };

  const toggleNetwork = (network: Network) =>
    setHiddenNetworks((current) => (current.includes(network) ? current.filter((item) => item !== network) : [...current, network]));

  const visibleDays = view === "month" ? monthGrid(cursor).flat() : weekDays(cursor);
  const visibleCount = visibleDays.reduce((total, day) => total + (eventsByDay.get(day)?.length ?? 0), 0);
  const undated = posts.filter((post) => !post.dueAt && !hiddenNetworks.includes(post.network) && (status === "all" || post.status === status)).length;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-lg" aria-label="Période précédente" onClick={() => move(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-lg" aria-label="Période suivante" onClick={() => move(1)}>
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              setCursor(today);
              setSelectedDay(today);
            }}
          >
            Aujourd&apos;hui
          </Button>
        </div>
        <h2 className="font-display text-xl font-medium" aria-live="polite" data-testid="calendar-title">
          {view === "month" ? formatMonthTitle(cursor) : formatWeekTitle(cursor)}
        </h2>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {availableNetworks.length > 1 && (
            <div className="flex items-center gap-1" role="group" aria-label="Filtrer par réseau">
              {availableNetworks.map((network) => {
                const selected = !hiddenNetworks.includes(network);
                return (
                  <button
                    key={network}
                    type="button"
                    aria-pressed={selected}
                    aria-label={NETWORK_LABELS[network]}
                    onClick={() => toggleNetwork(network)}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg border bg-card outline-none transition-all focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected ? "border-border" : "border-dashed opacity-40 grayscale hover:opacity-70",
                    )}
                  >
                    <NetworkIcon network={network} size="sm" />
                  </button>
                );
              })}
            </div>
          )}

          <Select value={status} onValueChange={(value) => setStatus(value as DisplayStatus | "all")}>
            <SelectTrigger className="h-9! w-52 bg-card" aria-label="Filtrer par statut">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les statuts</SelectItem>
              {statuses.map((option) => (
                <SelectItem key={option} value={option}>
                  {STATUS_META[option].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex h-9 items-center rounded-lg bg-muted p-0.5" role="group" aria-label="Vue du calendrier">
            {(["month", "week"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={cn(
                  "h-8 rounded-md px-3 text-sm font-medium outline-none transition-all focus-visible:ring-3 focus-visible:ring-ring/50",
                  view === option ? "bg-card shadow-soft" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "month" ? "Mois" : "Semaine"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {statuses.map((option) => (
          <span key={option} className="flex items-center gap-1.5">
            <span className={cn("h-3 w-1 rounded-full", statusBar(option))} />
            {STATUS_META[option].label}
          </span>
        ))}
        <span className="ml-auto">Les dates se modifient dans Buffer.</span>
      </div>

      {view === "month" ? (
        <>
          <div className="overflow-hidden rounded-2xl border bg-card">
            <div className="grid grid-cols-7 border-b bg-muted/50 text-center text-xs font-medium text-muted-foreground">
              {weekDays(cursor).map((day) => (
                <div key={day} className="py-2 capitalize">
                  {weekdayLabel(day)}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {monthGrid(cursor).flat().map((day) => (
                <MonthCell
                  key={day}
                  day={day}
                  today={today}
                  events={eventsByDay.get(day) ?? []}
                  outside={!isSameMonth(day, cursor)}
                  selected={day === selectedDay}
                  onSelect={() => setSelectedDay(day)}
                  showOrg={showOrg}
                />
              ))}
            </div>
          </div>

          {/* Sur mobile, le détail du jour sélectionné s'affiche sous la grille. */}
          <section className="md:hidden" aria-label="Publications du jour sélectionné">
            <h3 className="mb-2 text-sm font-semibold">{capitalize(formatDayLong(selectedDay))}</h3>
            {(eventsByDay.get(selectedDay) ?? []).length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Aucune publication ce jour-là.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {(eventsByDay.get(selectedDay) ?? []).map((event) => (
                  <EventCard key={event.post.id} event={event} showOrg={showOrg} compact />
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-7 md:gap-2">
          {weekDays(cursor).map((day) => (
            <WeekColumn key={day} day={day} past={day < today}>
              <div className="flex items-center gap-2 px-1 pt-0.5 md:flex-col md:items-start md:gap-0.5">
                <span className="text-xs font-medium text-muted-foreground capitalize">{weekdayLabel(day)}</span>
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
                    day === today ? "bg-brand text-brand-foreground" : day < today ? "text-muted-foreground" : "",
                  )}
                >
                  {dayNumber(day)}
                </span>
              </div>
              {(eventsByDay.get(day) ?? []).map((event) => (
                <EventCard key={event.post.id} event={event} showOrg={showOrg} />
              ))}
            </WeekColumn>
          ))}
        </div>
      )}

      {visibleCount === 0 && (
        <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
          <CalendarX2 className="size-4" />
          {status === "all" && hiddenNetworks.length === 0 ? "Aucune publication sur cette période." : "Aucune publication sur cette période avec les filtres actuels."}
        </p>
      )}
      {undated > 0 && (
        <p className="text-xs text-muted-foreground">
          {undated} publication{undated > 1 ? "s" : ""} sans date prévue dans Buffer n&apos;appar{undated > 1 ? "aissent" : "aît"} pas dans le calendrier.
        </p>
      )}
    </div>
  );
}

function WeekColumn({ day, past, children }: { day: DayKey; past: boolean; children: React.ReactNode }) {
  return (
    <div
      data-day={day}
      className={cn("flex min-h-24 flex-col gap-2 rounded-2xl border bg-card p-2 md:min-h-[28rem]", past && "bg-muted/30")}
    >
      {children}
    </div>
  );
}

function MonthCell({
  day,
  today,
  events,
  outside,
  selected,
  onSelect,
  showOrg,
}: {
  day: DayKey;
  today: DayKey;
  events: CalendarEvent[];
  outside: boolean;
  selected: boolean;
  onSelect: () => void;
  showOrg: boolean;
}) {
  const past = day < today;
  const hidden = events.length - MAX_CHIPS;

  return (
    <div
      data-day={day}
      className={cn(
        "relative min-h-16 border-r border-b p-1 nth-[7n]:border-r-0 md:min-h-36 md:p-1.5",
        outside && "bg-muted/40",
        past && !outside && "bg-muted/20",
        selected && "max-md:bg-brand-soft/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-current={day === today ? "date" : undefined}
        aria-label={`${formatDayLong(day)} ${day.slice(0, 4)} · ${events.length} publication${events.length > 1 ? "s" : ""}`}
        className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-md:absolute max-md:inset-0 max-md:flex max-md:items-start max-md:p-1"
      >
        <span className={cn(
          "flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums",
          day === today ? "bg-brand font-semibold text-brand-foreground" : outside || past ? "text-muted-foreground/70" : "text-foreground",
        )}
        >
          {dayNumber(day)}
        </span>
      </button>

      {/* Mobile : de simples pastilles par réseau. */}
      <div className="mt-1 flex flex-wrap gap-0.5 md:hidden" aria-hidden="true">
        {events.slice(0, 6).map((event) => (
          <NetworkIcon key={event.post.id} network={event.post.network} size="xs" className="size-2.5 rounded-full [&>svg]:hidden" />
        ))}
      </div>

      <div className="mt-1 hidden gap-1 md:grid">
        {events.slice(0, MAX_CHIPS).map((event) => (
          <EventChip key={event.post.id} event={event} showOrg={showOrg} />
        ))}
        {hidden > 0 && (
          <Popover>
            <PopoverTrigger
              onClick={(event) => event.stopPropagation()}
              className="h-6 rounded-md px-1.5 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              + {hidden} autre{hidden > 1 ? "s" : ""}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-2">
              <p className="px-1 pb-2 text-xs font-semibold">{capitalize(formatDayLong(day))}</p>
              <div className="grid grid-cols-1 gap-1">
                {events.map((event) => (
                  <EventChip key={event.post.id} event={event} showOrg={showOrg} />
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}

function StateMark({ status }: { status: DisplayStatus }) {
  if (status === "published") return <Check className="size-3 shrink-0 text-tone-green" aria-label="Publié" />;
  if (status === "error") return <TriangleAlert className="size-3 shrink-0 text-tone-red" aria-label="Erreur" />;
  return null;
}

/** Ligne compacte d'une publication (vue mensuelle). */
function EventChip({ event, showOrg }: { event: CalendarEvent; showOrg: boolean }) {
  const { post } = event;
  return (
    <Link
      href={event.href}
      data-post={post.bufferPostId}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
      title={`${event.time} · ${NETWORK_LABELS[post.network]} · ${STATUS_META[post.status].label} · ${post.title}`}
      className="flex h-11 min-w-0 items-stretch overflow-hidden rounded-lg border bg-card text-xs outline-none transition-shadow hover:shadow-soft focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className={cn("w-1 shrink-0", statusBar(post.status))} aria-hidden="true" />
      {post.assets[0] && <MediaThumb asset={post.assets[0]} className="my-1 ml-1 size-9 shrink-0 rounded-md" />}
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-1.5">
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <NetworkIcon network={post.network} size="xs" className="size-3.5" />
          <span className="tabular-nums">{event.time}</span>
          <StateMark status={post.status} />
          {showOrg && post.organization && (
            <OrgAvatar organization={post.organization} size="sm" className="ml-auto size-3.5 rounded-[3px] text-[7px]" />
          )}
        </span>
        <span className="truncate leading-tight font-medium">{post.title}</span>
      </span>
    </Link>
  );
}

/** Carte détaillée d'une publication (vue hebdomadaire et liste mobile). */
function EventCard({ event, showOrg, compact = false }: { event: CalendarEvent; showOrg: boolean; compact?: boolean }) {
  const { post } = event;
  return (
    <Link
      href={event.href}
      data-post={post.bufferPostId}
      className={cn(
        "group relative flex gap-2.5 overflow-hidden rounded-xl border bg-card p-2 pl-3 outline-none transition-shadow hover:shadow-soft focus-visible:ring-3 focus-visible:ring-ring/50",
        !compact && "md:flex-col md:gap-2",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", statusBar(post.status))} aria-hidden="true" />
      {post.assets[0] && (
        <MediaThumb asset={post.assets[0]} className={cn("size-14 shrink-0 rounded-lg", !compact && "md:aspect-square md:size-auto md:w-full")} />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <NetworkIcon network={post.network} size="xs" />
          <span className="tabular-nums">{event.time}</span>
          {showOrg && post.organization && (
            <OrgAvatar organization={post.organization} size="sm" className="ml-auto size-4 rounded-[4px] text-[8px]" />
          )}
        </p>
        <p className="mt-1 line-clamp-2 text-sm leading-snug font-medium">{post.title}</p>
        <StatusBadge status={post.status} className="mt-1.5 h-5 px-2 text-[11px]" />
      </div>
    </Link>
  );
}
