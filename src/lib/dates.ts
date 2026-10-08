/**
 * Utilitaires de dates.
 *
 * Règle du projet : les dates sont stockées en UTC (ISO 8601) et affichées
 * dans le fuseau horaire de l'organisation. Un « jour de calendrier » est
 * représenté par une clé texte `AAAA-MM-JJ` (DayKey), indépendante du fuseau.
 */

export type DayKey = string;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const LOCALE = "fr-FR";
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Décompose un instant UTC en date et heure locales du fuseau donné. */
export function zonedParts(iso: string, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(iso));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

export function toDayKey(year: number, month: number, day: number): DayKey {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Jour de calendrier d'un instant UTC, vu depuis le fuseau donné. */
export function dayKeyOf(iso: string, timeZone: string): DayKey {
  const { year, month, day } = zonedParts(iso, timeZone);
  return toDayKey(year, month, day);
}

/** Heure locale `HH:MM` d'un instant UTC. */
export function timeOf(iso: string, timeZone: string): string {
  const { hour, minute } = zonedParts(iso, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

/** Convertit une date et une heure locales (dans un fuseau) en instant UTC. */
export function zonedToUtcIso(dayKey: DayKey, time: string, timeZone: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);

  // Décalage du fuseau à un instant donné = heure locale lue comme UTC − instant.
  const offsetAt = (instant: number) => {
    const parts = zonedParts(new Date(instant).toISOString(), timeZone);
    return (
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant
    );
  };

  let instant = wallClock - offsetAt(wallClock);
  // Second passage : corrige les dates proches d'un changement d'heure.
  instant = wallClock - offsetAt(instant);
  return new Date(instant).toISOString();
}

function keyToUtcDate(dayKey: DayKey): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function utcDateToKey(date: Date): DayKey {
  return toDayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(dayKey: DayKey, amount: number): DayKey {
  const date = keyToUtcDate(dayKey);
  date.setUTCDate(date.getUTCDate() + amount);
  return utcDateToKey(date);
}

export function addMonths(dayKey: DayKey, amount: number): DayKey {
  const [year, month] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return utcDateToKey(date);
}

/** Lundi de la semaine contenant ce jour. */
export function startOfWeek(dayKey: DayKey): DayKey {
  const weekday = keyToUtcDate(dayKey).getUTCDay(); // 0 = dimanche
  return addDays(dayKey, weekday === 0 ? -6 : 1 - weekday);
}

export function weekDays(dayKey: DayKey): DayKey[] {
  const monday = startOfWeek(dayKey);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** Semaines (du lundi au dimanche) couvrant le mois du jour donné. */
export function monthGrid(dayKey: DayKey): DayKey[][] {
  const [year, month] = dayKey.split("-").map(Number);
  const firstDay = toDayKey(year, month, 1);
  const lastDay = addDays(addMonths(firstDay, 1), -1);
  const weeks: DayKey[][] = [];
  let cursor = startOfWeek(firstDay);
  while (cursor <= lastDay) {
    weeks.push(weekDays(cursor));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function isSameMonth(a: DayKey, b: DayKey): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

function formatKey(dayKey: DayKey, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: "UTC" }).format(
    keyToUtcDate(dayKey),
  );
}

export const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** « Octobre 2026 » */
export function formatMonthTitle(dayKey: DayKey): string {
  return capitalize(formatKey(dayKey, { month: "long", year: "numeric" }));
}

/** « jeudi 8 octobre » */
export function formatDayLong(dayKey: DayKey): string {
  return formatKey(dayKey, { weekday: "long", day: "numeric", month: "long" });
}

/** « jeu. 8 oct. » */
export function formatDayShort(dayKey: DayKey): string {
  return formatKey(dayKey, { weekday: "short", day: "numeric", month: "short" });
}

/** « 5 – 11 octobre 2026 » */
export function formatWeekTitle(dayKey: DayKey): string {
  const days = weekDays(dayKey);
  const first = days[0];
  const last = days[6];
  const end = formatKey(last, { day: "numeric", month: "long", year: "numeric" });
  const start = isSameMonth(first, last)
    ? formatKey(first, { day: "numeric" })
    : formatKey(first, { day: "numeric", month: "long" });
  return `${start} – ${end}`;
}

export function weekdayLabel(dayKey: DayKey, width: "short" | "long" = "short"): string {
  return formatKey(dayKey, { weekday: width });
}

export function dayNumber(dayKey: DayKey): number {
  return Number(dayKey.slice(8, 10));
}

/** « jeu. 8 oct. · 09:30 » */
export function formatDateTime(iso: string, timeZone: string): string {
  return `${formatDayShort(dayKeyOf(iso, timeZone))} · ${timeOf(iso, timeZone)}`;
}

/** Écart lisible entre un instant et « maintenant » : « il y a 2 h », « dans 3 j ». */
export function formatRelative(iso: string, nowIso: string): string {
  const diffMinutes = Math.round((Date.parse(iso) - Date.parse(nowIso)) / 60000);
  const absolute = Math.abs(diffMinutes);
  if (absolute < 1) return "à l'instant";
  let label: string;
  if (absolute < 60) label = `${absolute} min`;
  else if (absolute < 60 * 24) label = `${Math.round(absolute / 60)} h`;
  else label = `${Math.round(absolute / (60 * 24))} j`;
  return diffMinutes < 0 ? `il y a ${label}` : `dans ${label}`;
}
