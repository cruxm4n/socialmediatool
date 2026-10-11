import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FUTURE, LocalDb, migrationFiles, type PostRow } from "../support/local-db";

/*
 * Les migrations et les fonctions SQL, exécutées pour de vrai sur une base PostgreSQL locale
 * en mémoire. Rien ici ne touche à Supabase ni à Buffer.
 */

const PAST = "2020-01-15T09:00:00.000Z";
let db: LocalDb;
afterEach(() => db?.close());

const claim = (mode: "real" | "mock", postId: string | null = null) =>
  db.automation<PostRow>("claim_posts_for_scheduling_in_mode", { p_mode: mode, p_post_id: postId });
const events = async (bufferId: string) =>
  (await db.sql<{ type: string }>("select e.type from public.post_events e join public.posts p on p.id = e.post_id where p.buffer_post_id = $1 order by e.id", [bufferId])).map((row) => row.type);

describe("migrations", () => {
  it("s'appliquent toutes, dans l'ordre, sur une base vide", async () => {
    expect(migrationFiles()).toEqual(["0001_schema.sql", "0002_fiabilite.sql", "0003_isolation_modes.sql", "0004_fiabilite_statuts.sql", "0005_gestion_clients.sql", "0006_sync_planifiee.sql", "0007_notifications.sql", "0008_studio.sql", "0009_stabilisation.sql", "0010_contre_audit.sql", "0011_correction_v3.sql", "0012_connexions_fournisseur.sql", "0013_connexions_cycle_de_vie.sql"]);
    db = await LocalDb.create();
    const functions = await db.sql<{ proname: string }>("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'");
    expect(functions.map((row) => row.proname)).toEqual(expect.arrayContaining(["claim_posts_for_scheduling_in_mode", "list_posts_to_unschedule_in_mode", "sync_buffer_posts"]));
  });

  it("0003 et 0004 conservent les validations d'une base déjà utilisée (état actuel de Supabase)", async () => {
    db = await LocalDb.create("0002");
    const { ines } = await db.seed();
    await db.sync([{ id: "approuve" }, { id: "en-attente" }, { id: "programme" }]);
    await db.decide(ines, "approuve", "approved");
    await db.decide(ines, "programme", "approved");
    const programme = await db.post("programme");
    await db.automation("claim_posts_for_scheduling", { p_post_id: programme.id });
    await db.automation("complete_scheduling", { p_post_id: programme.id, p_ok: true });
    const before = await db.post("approuve");
    const decisions = await db.sql("select * from public.approval_decisions order by id");

    await db.migrate("0003_isolation_modes.sql");
    await db.migrate("0004_fiabilite_statuts.sql");

    const after = await db.post("approuve");
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after).toMatchObject({ approval_status: "approved", approved_hash: after.content_hash, version: 1 });
    expect(await db.post("en-attente")).toMatchObject({ approval_status: "pending", approved_hash: null });
    expect(await db.post("programme")).toMatchObject({ approval_status: "approved", schedule_state: "scheduled", buffer_status: "scheduled" });
    expect(await db.sql("select * from public.approval_decisions order by id")).toEqual(decisions);

    // La synchronisation suivante, à contenu identique, ne doit annuler aucune validation.
    const result = await db.sync([{ id: "approuve" }, { id: "en-attente" }, { id: "programme", status: "scheduled" }], { complete: true });
    expect(result).toMatchObject({ invalidated: 0, removed: 0, unresolved: [] });
    expect(await claim("real")).toHaveLength(1);
  });

  it("0004 et 0005 sont indépendantes : appliquées dans l'ordre inverse, la base se comporte de la même façon", async () => {
    db = await LocalDb.create("0003");
    const { admin, ines, sofia } = await db.seed();
    await db.sync([{ id: "approuve" }, { id: "en-attente" }]);
    await db.decide(ines, "approuve", "approved");

    await db.migrate("0005_gestion_clients.sql");
    await db.migrate("0004_fiabilite_statuts.sql");

    // 0004 : le tag retiré d'un brouillon approuvé retire la validation.
    const result = await db.sync([{ id: "approuve", hasReviewTag: false }, { id: "en-attente" }], { complete: true });
    expect(result).toMatchObject({ invalidated: 1, unresolved: [] });
    expect(await db.post("approuve")).toMatchObject({ approval_status: "none", schedule_state: "idle" });
    // 0005 : la visibilité passe par can_review_post, et les fonctions d'administration existent.
    expect(await db.as(ines, "select buffer_post_id from public.posts")).toEqual([{ buffer_post_id: "en-attente" }]);
    expect(await db.as(sofia, "select buffer_post_id from public.posts")).toEqual([]);
    await db.decide(ines, "en-attente", "approved");
    expect(await db.as(admin, "select count(*)::int as n from public.admin_list_user_emails()")).toEqual([{ n: 3 }]);
    // Les deux fichiers peuvent être rejoués sans erreur (copier-coller exécuté deux fois).
    await db.migrate("0004_fiabilite_statuts.sql");
    await db.migrate("0005_gestion_clients.sql");
    expect(await db.post("en-attente")).toMatchObject({ approval_status: "approved" });
  });
});

describe("outils d'exploitation (supabase/outils)", () => {
  const tool = (name: string) => readFileSync(resolve(process.cwd(), "supabase/outils", name), "utf8");

  it("le retour arrière de 0004 remet l'ancienne synchronisation sans toucher aux données ni aux droits", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const before = await db.post("p");
    await db.exec(tool("0004_retour_arriere.sql"));
    expect(await db.post("p")).toEqual(before);
    const result = await db.sync([{ id: "p" }], { complete: true });
    expect(result).not.toHaveProperty("unresolved");
    expect(result).toMatchObject({ fetched: 1, invalidated: 0, removed: 0 });
    // Et 0004 peut être rejouée ensuite.
    await db.migrate("0004_fiabilite_statuts.sql");
    expect(await db.sync([{ id: "p" }], { complete: true })).toMatchObject({ unresolved: [] });
  });

  it("les requêtes de vérification reconnaissent chaque migration et ne modifient rien", async () => {
    const [check, snapshot, rights] = tool("verification.sql").split(/\n-- \d\. /).slice(1, 4).map((part) => part.slice(part.indexOf("\n") + 1));
    const flags = async () => Object.values((await db.sql(check))[0]);
    db = await LocalDb.create("0001");
    expect(await flags()).toEqual([false, false, false, false, false]);
    await db.close();
    db = await LocalDb.create("0003");
    expect(await flags()).toEqual([true, true, true, false, false]);
    await db.seed();
    await db.sync([{ id: "p" }]);
    const counts = await db.sql(snapshot);
    await db.migrate("0004_fiabilite_statuts.sql");
    expect(await flags()).toEqual([true, true, true, true, false]);
    expect(await db.sql(snapshot)).toEqual(counts);
    await db.migrate("0005_gestion_clients.sql");
    expect(await flags()).toEqual([true, true, true, true, true]);
    expect(await db.sql(snapshot)).toEqual(counts);
    expect(await db.sql(rights)).toEqual([{ anon: true, authenticated: true }]);
  });
});

describe("séparation des données réelles et simulées (0003)", () => {
  it("un post simulé n'est jamais réservé en mode réel, ni par l'ancienne fonction", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "mock-a" }], { mode: "mock", channelPrefix: "mock-" });
    await db.sync([{ id: "reel-a" }]);
    await db.decide(ines, "mock-a", "approved");
    await db.decide(ines, "reel-a", "approved");

    expect((await db.automation<PostRow>("claim_posts_for_scheduling", {})).map((row) => row.buffer_post_id)).toEqual(["reel-a"]);
    expect(await claim("real")).toEqual([]);
    expect((await claim("mock")).map((row) => row.buffer_post_id)).toEqual(["mock-a"]);
  });

  it("refuse un mode inconnu et un mauvais secret", async () => {
    db = await LocalDb.create();
    await db.seed();
    for (const name of ["claim_posts_for_scheduling_in_mode", "list_posts_to_unschedule_in_mode"]) {
      await expect(db.automation(name, { p_mode: "autre" })).rejects.toThrow("invalid_mode");
      await expect(db.automation(name, { p_mode: "real" }, "mauvais")).rejects.toThrow("invalid_secret");
    }
  });

  it("un post programmé puis modifié n'est à déprogrammer que dans son mode", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "reel-b" }]);
    await db.decide(ines, "reel-b", "approved");
    const [claimed] = await claim("real");
    await db.automation("complete_scheduling", { p_post_id: claimed.id, p_ok: true, p_token: claimed.token });
    const result = await db.sync([{ id: "reel-b", status: "scheduled", text: "Texte changé" }]);
    expect(result.invalidated).toBe(1);
    expect(await db.post("reel-b")).toMatchObject({ approval_status: "pending", schedule_state: "unschedule_pending", version: 2 });
    expect(await db.automation("list_posts_to_unschedule_in_mode", { p_mode: "mock" })).toEqual([]);
    expect(await db.automation("list_posts_to_unschedule_in_mode", { p_mode: "real" })).toHaveLength(1);
  });
});

describe("validation", () => {
  it.each([
    ["les secondes de la date", { dueAt: "2030-01-15T09:00:30.000Z" }],
    ["le texte", { text: "Autre texte" }],
    ["l'ordre des médias", { assets: [{ type: "image", source: "b" }, { type: "image", source: "a" }] }],
  ])("est annulée si %s changent dans Buffer", async (_label, change) => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    const assets = [{ type: "image", source: "a" }, { type: "image", source: "b" }];
    await db.sync([{ id: "p", assets }]);
    await db.decide(ines, "p", "approved");
    const result = await db.sync([{ id: "p", assets, ...change }]);
    expect(result.invalidated).toBe(1);
    expect(await db.post("p")).toMatchObject({ approval_status: "pending", approved_hash: null, version: 2 });
    expect(await claim("real")).toEqual([]);
  });

  it("est refusée sur une version périmée, une date passée ou une décision déjà prise", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }, { id: "passe", dueAt: PAST }, { id: "sans-date", dueAt: null }]);
    const post = await db.post("p");
    await expect(db.as(ines, "select public.decide_post($1, 'approved', 'ancienne-empreinte')", [post.id])).rejects.toThrow("stale_version");
    await expect(db.decide(ines, "passe", "approved")).rejects.toThrow("date_invalid");
    await expect(db.decide(ines, "sans-date", "approved")).rejects.toThrow("date_invalid");
    await db.decide(ines, "p", "approved");
    await expect(db.decide(ines, "p", "approved")).rejects.toThrow("not_pending");
    await expect(db.as("anon", "select public.decide_post($1, 'approved', $2)", [post.id, post.content_hash])).rejects.toThrow(/permission denied/);
  });

  it("est retirée si le tag est enlevé d'un brouillon approuvé, sans boucle d'échecs (0004)", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const result = await db.sync([{ id: "p", hasReviewTag: false }]);
    expect(result.invalidated).toBe(1);
    expect(await db.post("p")).toMatchObject({ approval_status: "none", approved_hash: null, schedule_state: "idle" });
    expect(await claim("real")).toEqual([]);
    expect(await events("p")).toEqual(["submitted", "approved", "withdrawn"]);
    // Le tag revient : le post repasse en validation, il n'est pas approuvé d'office.
    await db.sync([{ id: "p" }]);
    expect(await db.post("p")).toMatchObject({ approval_status: "pending" });
  });

  it("reste acquise si le tag est enlevé d'un post déjà programmé", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const [claimed] = await claim("real");
    await db.automation("complete_scheduling", { p_post_id: claimed.id, p_ok: true, p_token: claimed.token });
    await db.sync([{ id: "p", status: "scheduled", hasReviewTag: false }]);
    expect(await db.post("p")).toMatchObject({ approval_status: "approved", schedule_state: "scheduled" });
  });
});

describe("posts absents de Buffer (0004)", () => {
  it("un post programmé dont la date est passée n'est pas déclaré supprimé sans vérification", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.sync([
      { id: "brouillon" },
      { id: "programme-futur", status: "scheduled" },
      { id: "sans-doute-publie", status: "scheduled", dueAt: PAST },
      { id: "vraiment-supprime", status: "scheduled", dueAt: PAST },
      { id: "simule", status: "scheduled", dueAt: PAST },
    ]);
    await db.sql("update public.posts set buffer_post_id = 'mock-simule' where buffer_post_id = 'simule'");

    const first = await db.sync([], { complete: true });
    expect(first.removed).toBe(2);
    expect(first.unresolved).toEqual(expect.arrayContaining(["sans-doute-publie", "vraiment-supprime"]));
    expect(first.unresolved).toHaveLength(2);
    expect((await db.post("brouillon")).removed_at).not.toBeNull();
    expect((await db.post("programme-futur")).removed_at).not.toBeNull();
    expect((await db.post("sans-doute-publie")).removed_at).toBeNull();

    // L'appelant a relu Buffer : l'un est publié, l'autre n'existe plus.
    const second = await db.sync([{ id: "sans-doute-publie", status: "sent", dueAt: PAST }], { confirmedGone: ["vraiment-supprime", "mock-simule"] });
    expect(second).toMatchObject({ updated: 1, removed: 1, unresolved: [] });
    expect(await db.post("sans-doute-publie")).toMatchObject({ buffer_status: "sent", removed_at: null });
    expect((await db.post("vraiment-supprime")).removed_at).not.toBeNull();
    expect((await db.post("mock-simule")).removed_at).toBeNull();
    expect(await events("sans-doute-publie")).toContain("published");
    expect((await db.sync([], { complete: true })).unresolved).toEqual([]);
  });

  it("une lecture incomplète de Buffer ne supprime rien", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.sync([{ id: "brouillon" }]);
    expect(await db.sync([], { complete: false })).toMatchObject({ removed: 0, unresolved: [] });
    expect((await db.post("brouillon")).removed_at).toBeNull();
  });
});

describe("isolation entre clients (règles RLS)", () => {
  it("un client ne lit ni ne décide les posts d'un autre client, et ne voit pas les incidents techniques", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia } = await db.seed();
    await db.sync([{ id: "colibri-1" }, { id: "colibri-brouillon", hasReviewTag: false }, { id: "nordwind-1", channelId: "canal-nordwind" }]);
    const ids = async (actor: Parameters<LocalDb["as"]>[0]) =>
      (await db.as<{ buffer_post_id: string }>(actor, "select buffer_post_id from public.posts order by 1")).map((row) => row.buffer_post_id);

    expect(await ids(ines)).toEqual(["colibri-1"]);
    expect(await ids(sofia)).toEqual(["nordwind-1"]);
    expect(await ids(admin)).toHaveLength(3);
    await expect(ids("anon")).rejects.toThrow(/permission denied/);

    await expect(db.decide(sofia, "colibri-1", "approved")).rejects.toThrow("not_found");
    await expect(db.decide(admin, "colibri-1", "approved")).rejects.toThrow("forbidden");
    await expect(db.as(ines, "update public.posts set approval_status = 'approved'")).rejects.toThrow(/permission denied/);
    await expect(db.as(ines, "select * from private.app_secrets")).rejects.toThrow(/permission denied/);

    await db.decide(ines, "colibri-1", "approved");
    const [claimed] = await claim("real");
    await db.automation("complete_scheduling", { p_post_id: claimed.id, p_ok: false, p_error: "détail technique", p_token: claimed.token });
    const seen = (actor: typeof ines) => db.as<{ type: string }>(actor, "select type from public.post_events where type = 'schedule_failed'");
    expect(await seen(ines)).toEqual([]);
    expect(await seen(admin)).toHaveLength(1);
  });

  it("un utilisateur connecté ne peut pas appeler une fonction d'automatisation sans le secret", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await expect(db.as(ines, "select * from public.claim_posts_for_scheduling_in_mode('devine', 'real')")).rejects.toThrow("invalid_secret");
    await expect(db.as(ines, "select public.sync_buffer_posts('devine', '{}'::jsonb)")).rejects.toThrow("invalid_secret");
    await expect(db.as(ines, "select private.check_secret('devine')")).rejects.toThrow(/permission denied/);
  });
});

describe("programmation", () => {
  it("deux réservations du même post : une seule aboutit", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p", dueAt: FUTURE }]);
    await db.decide(ines, "p", "approved");
    expect(await claim("real")).toHaveLength(1);
    expect(await claim("real")).toEqual([]);
  });
});
