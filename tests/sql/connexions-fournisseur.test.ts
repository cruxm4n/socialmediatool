import { afterEach, describe, expect, it } from "vitest";

import { SECRET, FUTURE, LocalDb, type Actor } from "../support/local-db";

/*
 * Migration 0012 — connexions fournisseur par client. Chaque test énonce un invariant et le vérifie avec les rôles
 * PostgreSQL réels (anon / authenticated) et la RLS, sur une base locale en mémoire. Aucun secret réel, aucun appel
 * externe : les « secrets » sont des textes chiffrés factices (préfixe v1.).
 */

let db: LocalDb;
afterEach(() => db?.close());

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

type Seed = Awaited<ReturnType<LocalDb["seed"]>>;

const create = (actor: Actor, id: string, args: { mode?: string; label?: string; org?: string | null; source?: string; ciphertext?: string | null; accountKey?: string | null }) =>
  db.as(actor, "select public.admin_create_provider_connection($1, $2, $3, $4, $5, $6, 1, $7, $8)", [
    id, args.mode ?? "real", args.label ?? "Compte", args.org ?? null, args.source ?? "stored",
    args.ciphertext === undefined ? "v1.aaa.bbb.ccc" : args.ciphertext, args.ciphertext === null ? null : "1234", args.accountKey ?? null,
  ]);

/** Deux clients, chacun avec SA connexion réelle, et un canal lu depuis chaque compte. */
async function twoAccounts(): Promise<Seed> {
  db = await LocalDb.create();
  const seed = await db.seed();
  await create(seed.admin, A, { label: "Buffer Colibri", org: seed.colibri, ciphertext: "v1.secretA.t.c" });
  await create(seed.admin, B, { label: "Buffer Nordwind", org: seed.nordwind, ciphertext: "v1.secretB.t.c" });
  return seed;
}

const snapshot = (connectionId: string, channels: { id: string }[], posts: { id: string; channelId: string; status?: string }[], extra: Record<string, unknown> = {}) => ({
  mode: "real", complete: true, scopeConnectionIds: [connectionId],
  channels: channels.map((c) => ({ id: c.id, service: "linkedin", name: c.id, connectionId })),
  posts: posts.map((p) => ({ id: p.id, channelId: p.channelId, service: "linkedin", status: p.status ?? "draft", text: `Texte ${p.id}`, dueAt: FUTURE, hasReviewTag: true, assets: [], connectionId })),
  ...extra,
});
const sync = async (payload: Record<string, unknown>) =>
  (await db.automation<{ sync_buffer_posts: Record<string, number> }>("sync_buffer_posts", { p_payload: payload }))[0].sync_buffer_posts;
const channel = async (id: string) => (await db.sql<Record<string, unknown>>("select * from public.channels where buffer_channel_id = $1", [id]))[0];
const routes = async (posts: string[], channels: string[], mode = "real") =>
  (await db.as<{ r: { posts: Record<string, string>; channels: Record<string, string> } }>(
    "anon", "select public.provider_routes($1, $2, $3::text[], $4::text[]) as r", [SECRET, mode, posts, channels]))[0].r;

describe("reprise de l'existant", () => {
  it("le compte simulé de démonstration existe toujours ; aucun compte réel n'est inventé sans canal réel", async () => {
    db = await LocalDb.create();
    const rows = await db.sql<{ mode: string; credential_source: string; is_default: boolean }>("select mode, credential_source, is_default from public.provider_connections");
    expect(rows).toEqual([{ mode: "mock", credential_source: "none", is_default: true }]);
  });

  it("une base de la version précédente garde ses canaux : chacun reçoit la connexion par défaut de SON mode", async () => {
    db = await LocalDb.create("0011");
    await db.seed();
    await db.sync([{ id: "p1" }]);
    await db.sync([{ id: "mock-x-1", channelId: "mock-ch-a" }], { mode: "mock" });
    await db.sql("insert into public.channels (buffer_channel_id, service, name) values ('mock-ch-a', 'linkedin', 'Simulé')");
    await db.migrate("0012_connexions_fournisseur.sql");
    const rows = await db.sql<{ buffer_channel_id: string; mode: string; credential_source: string }>(
      "select c.buffer_channel_id, pc.mode, pc.credential_source from public.channels c join public.provider_connections pc on pc.id = c.provider_connection_id order by 1");
    expect(rows.filter((r) => r.buffer_channel_id.startsWith("mock-")).every((r) => r.mode === "mock" && r.credential_source === "none")).toBe(true);
    expect(rows.filter((r) => !r.buffer_channel_id.startsWith("mock-")).every((r) => r.mode === "real" && r.credential_source === "environment")).toBe(true);
    expect(rows.length).toBe(5);
    // Rejouer la migration ne change rien.
    await db.migrate("0012_connexions_fournisseur.sql");
    expect((await db.sql("select 1 from public.provider_connections")).length).toBe(2);
    // Les publications et leur historique sont intacts.
    expect((await db.post("p1")).approval_status).toBe("pending");
  });

  it("un ancien appelant (sans connexion dans le relevé) fonctionne comme avant", async () => {
    db = await LocalDb.create();
    await db.seed();
    expect(await db.sync([{ id: "p1" }, { id: "p2" }])).toMatchObject({ created: 2 });
    expect(await db.sync([{ id: "p1" }], { complete: true })).toMatchObject({ removed: 1 });
    expect((await channel("canal-colibri")).provider_connection_id).toBeNull();
  });
});

describe("isolation des connexions (RLS et rôles réels)", () => {
  it("un client ne lit ni les connexions, ni leur journal, ni les secrets — pas même ceux de son propre client", async () => {
    const seed = await twoAccounts();
    for (const actor of [seed.ines, seed.sofia, "anon"] as Actor[]) {
      if (actor === "anon") {
        await expect(db.as(actor, "select * from public.provider_connections")).rejects.toThrow(/permission denied/);
      } else {
        expect(await db.as(actor, "select * from public.provider_connections")).toEqual([]);
        expect(await db.as(actor, "select * from public.provider_connection_events")).toEqual([]);
      }
      await expect(db.as(actor, "select * from private.provider_credentials")).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "select * from public.admin_provider_connections()")).rejects.toThrow();
    }
    expect((await db.as(seed.admin, "select label from public.provider_connections where mode = 'real' order by label")).map((r) => r.label)).toEqual(["Buffer Colibri", "Buffer Nordwind"]);
  });

  it("un client ne crée, ne remplace ni ne révoque une connexion ; écrire directement dans les tables est refusé", async () => {
    const seed = await twoAccounts();
    await expect(create(seed.ines, "33333333-3333-4333-8333-333333333333", { org: seed.colibri })).rejects.toThrow(/forbidden/);
    await expect(db.as(seed.ines, "select public.admin_set_provider_credential($1, 'v1.x.y.z')", [A])).rejects.toThrow(/forbidden/);
    await expect(db.as(seed.sofia, "select public.admin_revoke_provider_connection($1, true)", [A])).rejects.toThrow(/forbidden/);
    for (const actor of [seed.ines, seed.admin]) {
      await expect(db.as(actor, "update public.provider_connections set label = 'x'")).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "insert into public.provider_connections (mode, label, credential_source) values ('mock', 'x', 'none')")).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "delete from public.provider_connection_events")).rejects.toThrow(/permission denied/);
    }
  });

  it("le secret chiffré n'est remis qu'au serveur (secret d'automatisation) ; la vue d'administration ne montre qu'un indice", async () => {
    const seed = await twoAccounts();
    await expect(db.automation("provider_connections_for_run", { p_mode: "real" }, "mauvais-secret")).rejects.toThrow();
    const [{ provider_connections_for_run: run }] = await db.automation<{ provider_connections_for_run: { id: string; ciphertext: string }[] }>("provider_connections_for_run", { p_mode: "real" });
    expect(run.map((c) => [c.id, c.ciphertext])).toEqual([[A, "v1.secretA.t.c"], [B, "v1.secretB.t.c"]]);
    const overview = await db.as<Record<string, unknown>>(seed.admin, "select * from public.admin_provider_connections()");
    expect(JSON.stringify(overview)).not.toContain("secretA");
    expect(overview.find((r) => r.id === A)).toMatchObject({ hint: "1234", credential_source: "stored", channels: 0 });
    // Le journal ne contient aucune valeur secrète.
    expect(JSON.stringify(await db.sql("select * from public.provider_connection_events"))).not.toMatch(/secret[AB]/);
  });
});

describe("un canal appartient à une connexion, pour toujours", () => {
  it("la lecture pose la connexion d'origine ; le routage renvoie le bon compte pour chaque canal et chaque publication", async () => {
    await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "post-a", channelId: "ch-a" }]));
    await sync(snapshot(B, [{ id: "ch-b" }], [{ id: "post-b", channelId: "ch-b" }]));
    expect(await routes(["post-a", "post-b", "inconnu"], ["ch-a", "ch-b", "nulle-part"])).toEqual({ posts: { "post-a": A, "post-b": B }, channels: { "ch-a": A, "ch-b": B } });
    // Aucun routage par défaut : une publication dont le canal n'a pas de connexion n'a pas de route.
    await db.sync([{ id: "sans-connexion" }]);
    expect((await routes(["sans-connexion"], ["canal-colibri"])).posts).toEqual({});
  });

  it("un canal déjà connu sous le compte A est refusé quand le compte B l'annonce (aucune fusion, aucun vol)", async () => {
    await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "post-a", channelId: "ch-a" }]));
    const result = await sync(snapshot(B, [{ id: "ch-a" }], [{ id: "post-pirate", channelId: "ch-a" }, { id: "post-a", channelId: "ch-a" }]));
    expect(result.conflicts).toBe(3);
    expect((await channel("ch-a")).provider_connection_id).toBe(A);
    expect(await db.post("post-pirate")).toBeUndefined();
    expect(((await db.post("post-a")) as unknown as { text: string }).text).toBe("Texte post-a");
  });

  it("la connexion d'un canal ne se modifie pas, même par le propriétaire de la base", async () => {
    await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], []));
    await expect(db.sql("update public.channels set provider_connection_id = $1 where buffer_channel_id = 'ch-a'", [B])).rejects.toThrow(/channel_connection_immutable/);
    await expect(db.sql("update public.provider_connections set organization_id = null where id = $1", [A])).rejects.toThrow(/identity_immutable/);
  });

  it("un canal du compte d'un client ne peut être attribué qu'à CE client", async () => {
    const seed = await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], []));
    const { id } = await channel("ch-a");
    await expect(db.as(seed.admin, "select public.admin_assign_channel($1, $2, true)", [id, seed.nordwind])).rejects.toThrow(/channel_connection_org_mismatch/);
    await db.as(seed.admin, "select public.admin_assign_channel($1, $2, true)", [id, seed.colibri]);
    expect((await channel("ch-a")).organization_id).toBe(seed.colibri);
  });

  it("un compte simulé et un compte réel ne se mélangent pas", async () => {
    await twoAccounts();
    await expect(db.sql("insert into public.channels (buffer_channel_id, service, name, provider_connection_id) values ('mock-ch-z', 'linkedin', 'z', $1)", [A])).rejects.toThrow(/mode_mismatch/);
  });
});

describe("la lecture d'un compte ne touche que ses publications", () => {
  it("lecture complète du compte A : les publications du compte B, absentes du relevé, ne sont PAS retirées", async () => {
    await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "a1", channelId: "ch-a" }, { id: "a2", channelId: "ch-a" }]));
    await sync(snapshot(B, [{ id: "ch-b" }], [{ id: "b1", channelId: "ch-b" }]));
    const result = await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "a1", channelId: "ch-a" }]));
    expect(result.removed).toBe(1);
    expect((await db.post("a2")).removed_at).not.toBeNull();
    expect((await db.post("b1")).removed_at).toBeNull();
  });

  it("compte en panne (aucune connexion lue en entier) : rien n'est retiré nulle part", async () => {
    await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "a1", channelId: "ch-a" }]));
    const result = await sync({ mode: "real", complete: true, scopeConnectionIds: [], channels: [], posts: [] });
    expect(result.removed).toBe(0);
    expect((await db.post("a1")).removed_at).toBeNull();
  });
});

describe("remplacement et révocation", () => {
  it("remplacer la clé garde la connexion ; une clé d'un AUTRE compte est refusée", async () => {
    const seed = await twoAccounts();
    await db.as(seed.admin, "select public.admin_set_provider_credential($1, 'v1.nouvelle.t.c', 1, '9999', 'compte-colibri')", [A]);
    await expect(db.as(seed.admin, "select public.admin_set_provider_credential($1, 'v1.autre.t.c', 1, '0000', 'compte-etranger')", [A])).rejects.toThrow(/provider_account_mismatch/);
    const [{ provider_connections_for_run: run }] = await db.automation<{ provider_connections_for_run: { id: string; ciphertext: string }[] }>("provider_connections_for_run", { p_mode: "real" });
    expect(run.find((c) => c.id === A)?.ciphertext).toBe("v1.nouvelle.t.c");
    expect(run.find((c) => c.id === B)?.ciphertext).toBe("v1.secretB.t.c");
    await expect(db.as(seed.admin, "select public.admin_set_provider_credential($1, 'pas-chiffre')", [A])).rejects.toThrow(/credential_required/);
  });

  it("révocation refusée tant qu'une programmation n'est pas rapprochée ; la décision forcée est tracée ; B n'est pas touché", async () => {
    const seed = await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "a1", channelId: "ch-a", status: "scheduled" }]));
    await sync(snapshot(B, [{ id: "ch-b" }], [{ id: "b1", channelId: "ch-b" }]));
    const refuse = (await db.as<{ r: { revoked: boolean; unresolved: Record<string, number> } }>(seed.admin, "select public.admin_revoke_provider_connection($1) as r", [A]))[0].r;
    expect(refuse).toMatchObject({ revoked: false, unresolved: { scheduled: 1 } });
    expect((await db.sql("select status from public.provider_connections where id = $1", [A]))[0].status).toBe("active");

    const forced = (await db.as<{ r: { revoked: boolean } }>(seed.admin, "select public.admin_revoke_provider_connection($1, true) as r", [A]))[0].r;
    expect(forced.revoked).toBe(true);
    // Le secret a disparu, la connexion et ses publications restent en base (la trace n'est jamais perdue).
    expect(await db.sql("select 1 from private.provider_credentials where connection_id = $1", [A])).toEqual([]);
    expect((await db.post("a1")).removed_at).toBeNull();
    expect((await routes(["a1"], [])).posts).toEqual({ a1: A });
    expect((await db.sql<{ type: string; detail: string }>("select type, detail from public.provider_connection_events where connection_id = $1 order by id", [A])).map((e) => e.type)).toEqual(["created", "revoke_refused", "revoked"]);
    // Le serveur ne reçoit plus la connexion révoquée ; celle de l'autre client est intacte.
    const [{ provider_connections_for_run: run }] = await db.automation<{ provider_connections_for_run: { id: string }[] }>("provider_connections_for_run", { p_mode: "real" });
    expect(run.map((c) => c.id)).toEqual([B]);
    // Une connexion révoquée ne se réactive pas et ne reçoit plus de clé.
    await expect(db.sql("update public.provider_connections set status = 'active', revoked_at = null where id = $1", [A])).rejects.toThrow(/provider_connection_revoked/);
    await expect(db.as(seed.admin, "select public.admin_set_provider_credential($1, 'v1.x.y.z')", [A])).rejects.toThrow(/provider_connection_revoked/);
  });

  it("le compte simulé de démonstration ne se révoque pas", async () => {
    db = await LocalDb.create();
    const seed = await db.seed();
    const [{ id }] = await db.sql<{ id: string }>("select id from public.provider_connections where is_default");
    await expect(db.as(seed.admin, "select public.admin_revoke_provider_connection($1, true)", [id])).rejects.toThrow(/default_connection/);
  });
});

describe("quota par compte", () => {
  it("la pause d'un compte ne concerne que lui, et ne se raccourcit jamais", async () => {
    await twoAccounts();
    await db.automation("record_provider_connection_state", { p_connection_id: A, p_ok: false, p_error: "429", p_pause_seconds: 3600, p_pause_reason: "Quota atteint" });
    await db.automation("record_provider_connection_state", { p_connection_id: A, p_ok: true, p_pause_seconds: 60, p_pause_reason: "plus court" });
    const [{ provider_connections_for_run: run }] = await db.automation<{ provider_connections_for_run: { id: string; pausedUntil: string | null }[] }>("provider_connections_for_run", { p_mode: "real" });
    const a = run.find((c) => c.id === A)!;
    expect(Date.parse(a.pausedUntil!) - Date.now()).toBeGreaterThan(3000_000);
    expect(run.find((c) => c.id === B)!.pausedUntil).toBeNull();
    // La pause globale du mode (planificateur) n'est pas posée par un refus propre à un compte.
    const [{ get_sync_pause: pause }] = await db.automation<{ get_sync_pause: unknown }>("get_sync_pause", { p_mode: "real" });
    expect(pause).toBeNull();
  });
});

describe("état du schéma", () => {
  it("la préparation au service exige 0012", async () => {
    db = await LocalDb.create();
    await db.seed();
    const [{ schema_status: status }] = await db.automation<{ schema_status: { ready: boolean; checks: Record<string, boolean> } }>("schema_status", {});
    expect(status.checks["0012"]).toBe(true);
    expect(status.ready).toBe(true);
  });
});
