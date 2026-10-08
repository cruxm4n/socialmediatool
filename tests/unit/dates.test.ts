import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  dayKeyOf,
  formatRelative,
  formatWeekTitle,
  monthGrid,
  startOfWeek,
  timeOf,
  zonedToUtcIso,
} from "@/lib/dates";

describe("conversion entre UTC et fuseau de l'organisation", () => {
  it("convertit une heure de Paris en UTC, en heure d'été comme en heure d'hiver", () => {
    expect(zonedToUtcIso("2026-10-08", "10:00", "Europe/Paris")).toBe("2026-10-08T08:00:00.000Z");
    expect(zonedToUtcIso("2026-11-02", "10:00", "Europe/Paris")).toBe("2026-11-02T09:00:00.000Z");
  });

  it("gère un autre fuseau", () => {
    expect(zonedToUtcIso("2026-10-08", "09:00", "America/Toronto")).toBe("2026-10-08T13:00:00.000Z");
  });

  it("retrouve le jour et l'heure locaux à partir de l'UTC", () => {
    const iso = "2026-10-08T22:30:00.000Z";
    expect(dayKeyOf(iso, "Europe/Paris")).toBe("2026-10-09");
    expect(timeOf(iso, "Europe/Paris")).toBe("00:30");
    expect(dayKeyOf(iso, "America/Toronto")).toBe("2026-10-08");
  });

  it("conserve l'heure locale quand on déplace une date au-delà du changement d'heure", () => {
    const moved = zonedToUtcIso("2026-10-26", "09:00", "Europe/Paris");
    expect(timeOf(moved, "Europe/Paris")).toBe("09:00");
    expect(moved).toBe("2026-10-26T08:00:00.000Z");
  });
});

describe("calcul des jours du calendrier", () => {
  it("commence la semaine le lundi", () => {
    expect(startOfWeek("2026-10-08")).toBe("2026-10-05");
    expect(startOfWeek("2026-10-11")).toBe("2026-10-05");
    expect(startOfWeek("2026-10-05")).toBe("2026-10-05");
  });

  it("additionne des jours et des mois en passant les fins de mois et d'année", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
  });

  it("construit la grille d'octobre 2026 : cinq semaines du 28 septembre au 1er novembre", () => {
    const grid = monthGrid("2026-10-08");
    expect(grid).toHaveLength(5);
    expect(grid[0][0]).toBe("2026-09-28");
    expect(grid[4][6]).toBe("2026-11-01");
    expect(grid.every((week) => week.length === 7)).toBe(true);
  });
});

describe("affichage", () => {
  it("formate le titre d'une semaine", () => {
    expect(formatWeekTitle("2026-10-08")).toBe("5 – 11 octobre 2026");
    expect(formatWeekTitle("2026-10-01")).toBe("28 septembre – 4 octobre 2026");
  });

  it("exprime un écart de temps lisible", () => {
    const now = "2026-10-08T08:00:00.000Z";
    expect(formatRelative("2026-10-08T07:30:00.000Z", now)).toBe("il y a 30 min");
    expect(formatRelative("2026-10-08T05:00:00.000Z", now)).toBe("il y a 3 h");
    expect(formatRelative("2026-10-10T08:00:00.000Z", now)).toBe("dans 2 j");
  });
});
