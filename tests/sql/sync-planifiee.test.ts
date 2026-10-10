import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalDb } from "../support/local-db";

/*
 * Migration 0006 : verrou de synchronisation, état et pause. Base PostgreSQL locale en mémoire.
 */

let db: LocalDb;
afterEach(() => db?.close());

type Lock = { acquired: boolean; token?: string; reason?: string; detail?: string };
const begin = async (mode = "real", scheduled = false, ttl = 300) =>
  (await db.automation<{ begin_sync_run: Lock }>("begin_sync_run", { p_mode: mode, p_triggered_by: "test", p_scheduled: scheduled, p_ttl_seconds: ttl }))[0].begin_sync_run;
const finish = async (token: string, ok: boolean, extra: Record<string, unknown> = {}) =>
  (await db.automation<{ finish_sync_run: boolean }>("finish_sync_run", { p_mode: "real", p_token: token, p_ok: ok, ...extra }))[0].finish_sync_run;
const state = async (mode = "real") => (await db.sql<Record<string, unknown>>("select * from public.sync_state where mode = $1", [mode]))[0];

describe("verrou de synchronisation", () => {
  it("une seule exécution à la fois par mode ; le verrou rendu, la suivante passe", async () => {
    db = await LocalDb.create();
    await db.seed();
    const first = await begin();
    expect(first.acquired).toBe(true);
    expect(await begin()).toMatchObject({ acquired: false, reason: "running" });
    // Les données simulées ont leur propre verrou.
    expect((await begin("mock")).acquired).toBe(true);
    expect(await finish(first.token!, true)).toBe(true);
    expect((await begin()).acquired).toBe(true);
  });

  it("un verrou jamais rendu expire tout seul, et l'ancien jeton ne peut plus rien écrire", async () => {
    db = await LocalDb.create();
    await db.seed();
    const stuck = await begin();
    await db.sql("update public.sync_state set locked_until = now() - interval '1 second'");
    const next = await begin();
    expect(next.acquired).toBe(true);
    expect(await finish(stuck.token!, false, { p_error: "Trop tard" })).toBe(false);
    expect(await state()).toMatchObject({ last_failure_at: null, lock_token: next.token });
  });

  it("refuse un mode inconnu, un mauvais secret et un utilisateur sans le secret", async () => {
    db = await LocalDb.create();
    const { admin } = await db.seed();
    await expect(begin("autre")).rejects.toThrow("invalid_mode");
    await expect(db.automation("begin_sync_run", { p_mode: "real" }, "mauvais")).rejects.toThrow("invalid_secret");
    await expect(db.as(admin, "select public.begin_sync_run('mauvais', 'real')")).rejects.toThrow("invalid_secret");
  });
});

describe("état de la synchronisation", () => {
  it("enregistre le dernier succès, le dernier échec, les échecs consécutifs et les anomalies", async () => {
    db = await LocalDb.create();
    await db.seed();
    await finish((await begin()).token!, false, { p_error: "Buffer injoignable." });
    await finish((await begin()).token!, false, { p_error: "Buffer injoignable.", p_anomalies: ["1 échec"] });
    expect(await state()).toMatchObject({ last_success_at: null, last_error: "Buffer injoignable.", consecutive_failures: 2, anomalies: ["1 échec"], locked_until: null });

    await finish((await begin()).token!, true);
    const after = await state();
    expect(after).toMatchObject({ consecutive_failures: 0, anomalies: [] });
    expect(after.last_success_at).not.toBeNull();
    // Le dernier échec reste consultable après un succès.
    expect(after.last_failure_at).not.toBeNull();
    expect(after.last_error).toBe("Buffer injoignable.");
  });

  it("une pause suspend les exécutions planifiées, pas le bouton manuel, et prend fin seule", async () => {
    db = await LocalDb.create();
    await db.seed();
    await finish((await begin(undefined, true)).token!, false, { p_error: "Quota", p_backoff_seconds: 900, p_backoff_reason: "Quota de requêtes Buffer atteint." });
    expect(await begin("real", true)).toMatchObject({ acquired: false, reason: "backoff", detail: "Quota de requêtes Buffer atteint." });

    const manual = await begin("real", false);
    expect(manual.acquired).toBe(true);
    // Une exécution manuelle réussie, sans nouvelle alerte de quota, lève la pause.
    await finish(manual.token!, true);
    expect((await begin("real", true)).acquired).toBe(true);
  });

  it("seul le planificateur met à jour son dernier passage", async () => {
    db = await LocalDb.create();
    await db.seed();
    await finish((await begin("real", false)).token!, true);
    expect((await state()).last_scheduled_at).toBeNull();
    await finish((await begin("real", true)).token!, true);
    expect((await state()).last_scheduled_at).not.toBeNull();
  });

  it("lisible par l'administrateur seulement, jamais modifiable par l'API", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    await finish((await begin()).token!, true);
    expect(await db.as(admin, "select mode from public.sync_state")).toEqual([{ mode: "real" }]);
    expect(await db.as(ines, "select mode from public.sync_state")).toEqual([]);
    await expect(db.as("anon", "select mode from public.sync_state")).rejects.toThrow(/permission denied/);
    await expect(db.as(admin, "update public.sync_state set last_error = 'x'")).rejects.toThrow(/permission denied/);
  });
});

describe("montée de version et retour arrière de 0006", () => {
  it("s'applique sur une base utilisée, se rejoue, et se retire sans toucher aux données", async () => {
    db = await LocalDb.create("0005");
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const before = await db.post("p");

    await db.migrate("0006_sync_planifiee.sql");
    await db.migrate("0006_sync_planifiee.sql");
    expect(await db.post("p")).toEqual(before);
    await finish((await begin()).token!, true);

    await db.exec(readFileSync(resolve(process.cwd(), "supabase/outils/0006_retour_arriere.sql"), "utf8"));
    await expect(begin()).rejects.toThrow(/does not exist/);
    expect(await db.post("p")).toEqual(before);
    expect(await state()).toBeDefined();
    await db.migrate("0006_sync_planifiee.sql");
    expect((await begin()).acquired).toBe(true);
  });
});
