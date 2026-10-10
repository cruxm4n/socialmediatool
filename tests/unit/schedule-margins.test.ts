import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { APPROVAL_MIN_LEAD_MS, SCHEDULING_MIN_LEAD_MS, STUDIO_MIN_LEAD_MS } from "@/lib/domain/schedule-margins";

const sql = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8");
const minutes = (ms: number) => ms / 60_000;

describe("marges temporelles de la chaîne envoi → approbation → programmation", () => {
  it("sont étagées : envoi > approbation > réservation", () => {
    expect(STUDIO_MIN_LEAD_MS).toBeGreaterThan(APPROVAL_MIN_LEAD_MS);
    expect(APPROVAL_MIN_LEAD_MS).toBeGreaterThan(SCHEDULING_MIN_LEAD_MS);
  });

  it("sont les mêmes en SQL qu'en TypeScript", () => {
    // La dernière définition de chaque fonction fait foi : 0010 pour la réservation et l'envoi, 0009 pour l'approbation.
    expect(sql("0010_contre_audit.sql")).toContain(`c.due_at > now() + interval '${minutes(SCHEDULING_MIN_LEAD_MS)} minutes'`);
    expect(sql("0010_contre_audit.sql")).toContain(`v_draft.due_at <= now() + interval '${minutes(STUDIO_MIN_LEAD_MS)} minutes'`);
    expect(sql("0009_stabilisation.sql")).toContain(`v_post.due_at <= now() + interval '${minutes(APPROVAL_MIN_LEAD_MS)} minutes'`);
  });
});
