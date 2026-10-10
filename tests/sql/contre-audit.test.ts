import { afterEach, describe, expect, it } from "vitest";

import { FUTURE, LocalDb, SECRET, type Actor } from "../support/local-db";

/*
 * Migration 0010 : non-régressions de la deuxième stabilisation (contre-audit indépendant du 10 octobre 2026).
 * Chaque test énonce l'invariant attendu, avec les rôles PostgreSQL réels (anon / authenticated) et la RLS.
 * Base PostgreSQL locale en mémoire : rien ne touche Supabase ni Buffer.
 */

/** Preuve consignée avec une absence confirmée par une personne (migration 0011). */
const EVIDENCE = "Vérifié dans Buffer : aucun brouillon à ce texte ni à cette date.";

let db: LocalDb;
afterEach(() => db?.close());

const channelId = async (bufferId: string) => (await db.sql<{ id: string }>("select id from public.channels where buffer_channel_id = $1", [bufferId]))[0].id;
const assign = async (actor: Actor, bufferId: string, organizationId: string | null, confirm = false) =>
  (await db.as<{ r: Record<string, number | boolean> }>(actor, "select public.admin_assign_channel($1, $2, $3) as r", [await channelId(bufferId), organizationId, confirm]))[0].r;
const visible = async (actor: Actor) => (await db.as<{ buffer_post_id: string }>(actor, "select buffer_post_id from public.posts order by 1")).map((r) => r.buffer_post_id);
const history = async (bufferId: string) =>
  db.sql<{ kind: string }>("select kind from public.channel_owner_history h join public.channels c on c.id = h.channel_id where c.buffer_channel_id = $1 order by h.id", [bufferId]);
const row = async (bufferId: string) => (await db.sql<Record<string, unknown>>("select * from public.posts where buffer_post_id = $1", [bufferId]))[0];
const claim = () => db.automation<{ id: string; token: string }>("claim_posts_for_scheduling_in_mode", { p_mode: "real" });
const complete = async (postId: string, ok: boolean, token: string | null) =>
  (await db.automation<{ complete_scheduling: string }>("complete_scheduling", { p_post_id: postId, p_ok: ok, p_token: token }))[0].complete_scheduling;
const events = async (bufferId: string) =>
  (await db.sql<{ type: string }>("select e.type from public.post_events e join public.posts p on p.id = e.post_id where p.buffer_post_id = $1 order by e.id", [bufferId])).map((r) => r.type);

describe("B2 — chaque transition de propriétaire laisse une trace durable", () => {
  it("un transfert sans aucune publication importée est enregistré et protège les imports tardifs", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, nordwind } = await db.seed();
    await db.sync([]);
    expect(await assign(admin, "canal-colibri", nordwind)).toMatchObject({ transferred: true });
    expect(await history("canal-colibri")).toEqual([{ kind: "transfer" }]);
    expect(await db.sql("select visible_from is not null as marked from public.channels where buffer_channel_id = 'canal-colibri'")).toEqual([{ marked: true }]);

    await db.sync([{ id: "ancien-contenu-de-colibri", text: "CONFIDENTIEL COLIBRI" }]);
    expect(await row("ancien-contenu-de-colibri")).toMatchObject({ ownership: "ambiguous", owner_organization_id: null });
    expect(await visible(sofia)).toEqual([]);
    expect(await visible(ines)).toEqual([]);
    expect(await visible(admin)).toEqual(["ancien-contenu-de-colibri"]);
  });

  it("détacher puis rattacher à un autre client ne réinitialise pas la protection, et la trace dit les deux étapes", async () => {
    db = await LocalDb.create();
    const { admin, sofia, nordwind } = await db.seed();
    await db.sync([]);
    await assign(admin, "canal-colibri", null);
    await assign(admin, "canal-colibri", nordwind);
    expect((await history("canal-colibri")).map((item) => item.kind)).toEqual(["detach", "transfer"]);
    await db.sync([{ id: "tardif" }]);
    expect(await visible(sofia)).toEqual([]);
    // Un autre détachement/rattachement ne rend pas l'historique visible.
    await assign(admin, "canal-colibri", null);
    await assign(admin, "canal-colibri", nordwind);
    await db.sync([{ id: "tardif" }, { id: "encore-plus-tard" }]);
    expect(await visible(sofia)).toEqual([]);
  });

  it("le même client rattaché de nouveau n'est pas un transfert, mais ce qui a été importé détaché reste ambigu", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([]);
    await assign(admin, "canal-colibri", null);
    await db.sync([{ id: "pendant-detachement" }]);
    await assign(admin, "canal-colibri", colibri);
    expect((await history("canal-colibri")).map((item) => item.kind)).toEqual(["detach", "reattach"]);
    expect(await db.sql("select visible_from from public.channels where buffer_channel_id = 'canal-colibri'")).toEqual([{ visible_from: null }]);
    expect(await row("pendant-detachement")).toMatchObject({ ownership: "ambiguous" });
    expect(await visible(ines)).toEqual([]);
    // Un contenu découvert ensuite sur un canal revenu au même client est le sien.
    await db.sync([{ id: "nouveau" }]);
    expect(await visible(ines)).toEqual(["nouveau"]);
  });

  it("une écriture SQL directe sur le canal laisse la même trace (aucune voie ne contourne la protection)", async () => {
    db = await LocalDb.create();
    const { sofia, nordwind } = await db.seed();
    await db.sync([]);
    await db.sql("update public.channels set organization_id = $1 where buffer_channel_id = 'canal-colibri'", [nordwind]);
    expect(await history("canal-colibri")).toEqual([{ kind: "transfer" }]);
    await db.sync([{ id: "decouvert" }]);
    expect(await visible(sofia)).toEqual([]);
  });

  it("un client ne lit pas l'historique des propriétaires de canaux", async () => {
    db = await LocalDb.create();
    const { admin, ines, nordwind } = await db.seed();
    await assign(admin, "canal-colibri", nordwind).catch(() => undefined);
    await db.sync([]);
    await assign(admin, "canal-colibri", nordwind);
    expect(await db.as(ines, "select * from public.channel_owner_history")).toEqual([]);
    await expect(db.as(ines, "insert into public.channel_owner_history (channel_id, kind) values (gen_random_uuid(), 'transfer')")).rejects.toThrow(/permission denied/);
    expect((await db.as(admin, "select * from public.channel_owner_history")).length).toBeGreaterThan(0);
  });

  it("l'administrateur peut attribuer une publication ambiguë ; le client concerné la voit alors, pas l'autre", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, colibri, nordwind } = await db.seed();
    await db.sync([]);
    await assign(admin, "canal-colibri", nordwind);
    await assign(admin, "canal-colibri", colibri, true);
    await db.sync([{ id: "ambigu" }]);
    expect(await visible(ines)).toEqual([]);
    const post = await row("ambigu");
    await db.as(admin, "select public.admin_set_post_owner($1::uuid[], $2)", [[post.id], colibri]);
    expect(await visible(ines)).toEqual(["ambigu"]);
    expect(await visible(sofia)).toEqual([]);
  });
});

describe("B3 — l'approbation d'un membre retiré n'est plus utilisable", () => {
  it("retirer l'approbateur retire l'approbation, avec une trace, et rien n'est réservable", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    await db.as(admin, "select public.admin_set_member($1, $2, false)", [colibri, ines.userId]);
    expect(await row("p")).toMatchObject({ approval_status: "pending", approved_by: null, approved_hash: null, schedule_state: "idle" });
    expect(await events("p")).toContain("approval_revoked");
    expect(await claim()).toEqual([]);
    // Rétablir le membre ne ressuscite pas l'ancien accord.
    await db.as(admin, "select public.admin_set_member($1, $2, true)", [colibri, ines.userId]);
    expect(await claim()).toEqual([]);
  });

  it("un autre membre du client garde ses propres approbations", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    const [{ id: marc }] = await db.sql<{ id: string }>("insert into auth.users (email) values ('marc@test.example') returning id");
    await db.sql("insert into public.profiles (id, full_name, role) values ($1, 'marc', 'client')", [marc]);
    await db.sql("insert into public.organization_members (organization_id, user_id) values ($1, $2)", [colibri, marc]);
    await db.sync([{ id: "par-ines" }, { id: "par-marc" }]);
    await db.decide(ines, "par-ines", "approved");
    await db.decide({ userId: marc }, "par-marc", "approved");
    await db.as(admin, "select public.admin_set_member($1, $2, false)", [colibri, ines.userId]);
    expect(await row("par-ines")).toMatchObject({ approval_status: "pending" });
    expect(await row("par-marc")).toMatchObject({ approval_status: "approved" });
    expect((await claim()).length).toBe(1);
  });

  it("course : retrait entre la réservation et la confirmation → compensation à confirmer, jamais « programmé »", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const [reserved] = await claim();
    await db.as(admin, "select public.admin_set_member($1, $2, false)", [colibri, ines.userId]);
    expect(await row("p")).toMatchObject({ approval_status: "pending", schedule_state: "unschedule_pending" });
    // Buffer a déjà accepté : la confirmation arrive, elle est périmée.
    expect(await complete(reserved.id, true, reserved.token)).toBe("stale");
    expect(await row("p")).toMatchObject({ schedule_state: "unschedule_pending", approval_status: "pending", buffer_status: "scheduled" });
  });

  it("un post déjà programmé dont l'approbateur est retiré passe en « annulation à confirmer »", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const [reserved] = await claim();
    expect(await complete(reserved.id, true, reserved.token)).toBe("scheduled");
    await db.as(admin, "select public.admin_set_member($1, $2, false)", [colibri, ines.userId]);
    expect(await row("p")).toMatchObject({ approval_status: "pending", schedule_state: "unschedule_pending", buffer_status: "scheduled" });
    expect(String((await row("p")).schedule_error)).toContain("reste à confirmer");
    expect((await db.automation<{ buffer_post_id: string }>("list_posts_to_unschedule_in_mode", { p_mode: "real" })).map((item) => item.buffer_post_id)).toEqual(["p"]);
  });

  it("un approbateur dont le rôle n'est plus « client » n'autorise plus aucune réservation", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    await db.sql("update public.profiles set role = 'admin' where id = $1", [ines.userId]);
    expect(await claim()).toEqual([]);
  });
});

describe("B4 — confirmation de programmation : identité de réservation", () => {
  it("une confirmation sans jeton n'a aucun effet, même sur une réservation courante", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const [reserved] = await claim();
    expect(await complete(reserved.id, true, null)).toBe("superseded");
    expect(await complete(reserved.id, false, null)).toBe("ignored");
    expect(await row("p")).toMatchObject({ schedule_state: "claimed" });
    expect(await complete(reserved.id, true, reserved.token)).toBe("scheduled");
  });

  it("un ancien jeton, après expiration et nouvelle réservation, ne confirme ni n'échoue la nouvelle", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const [first] = await claim();
    await db.sql("update public.posts set schedule_claimed_at = now() - interval '11 minutes'");
    const [second] = await claim();
    expect(await complete(first.id, false, first.token)).toBe("ignored");
    expect(await row("p")).toMatchObject({ schedule_state: "claimed" });
    expect(await complete(second.id, true, second.token)).toBe("scheduled");
  });

  it("une confirmation tardive d'une opération périmée, hors réservation courante, place le post en annulation à confirmer", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p", text: "V1" }]);
    await db.decide(ines, "p", "approved");
    const [old] = await claim();
    await db.sync([{ id: "p", text: "V2" }]);
    // Compensation constatée terminée (« brouillon ») : l'état redevient « idle ».
    await db.automation("complete_unscheduling", { p_post_id: old.id, p_ok: true, p_observed_status: "draft" });
    expect(await row("p")).toMatchObject({ schedule_state: "idle", buffer_status: "draft" });
    // Puis la confirmation de l'ancienne opération arrive (réponse Buffer très tardive).
    expect(await complete(old.id, true, old.token)).toBe("stale");
    expect(await row("p")).toMatchObject({ schedule_state: "unschedule_pending", approval_status: "pending" });
    expect((await db.automation("list_posts_to_unschedule_in_mode", { p_mode: "real" })).length).toBe(1);
  });

  it("un post déjà publié par Buffer n'est jamais présenté comme annulé", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p", text: "V1" }]);
    await db.decide(ines, "p", "approved");
    const [old] = await claim();
    await db.sync([{ id: "p", text: "V2" }]);
    await db.automation("complete_unscheduling", { p_post_id: old.id, p_ok: true, p_observed_status: "sent" });
    expect(await row("p")).toMatchObject({ buffer_status: "sent", schedule_state: "idle" });
    expect(await events("p")).toContain("unschedule_too_late");
    expect(await events("p")).not.toContain("unscheduled");
  });

  it("la liste des annulations à confirmer est servie par échéance croissante", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([
      { id: "loin", dueAt: "2030-03-01T09:00:00.000Z" },
      { id: "proche", dueAt: "2030-01-20T09:00:00.000Z" },
    ]);
    await db.decide(ines, "loin", "approved");
    await db.decide(ines, "proche", "approved");
    for (const reserved of await claim()) await complete(reserved.id, true, reserved.token);
    await db.sync([{ id: "loin", dueAt: "2030-03-01T09:00:00.000Z", text: "modifié" }, { id: "proche", dueAt: "2030-01-20T09:00:00.000Z", text: "modifié" }]);
    const listed = await db.automation<{ buffer_post_id: string }>("list_posts_to_unschedule_in_mode", { p_mode: "real" });
    expect(listed.map((item) => item.buffer_post_id)).toEqual(["proche", "loin"]);
  });

  it("la marge de réservation est de cinq minutes", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p", dueAt: new Date(Date.now() + 30 * 60_000).toISOString() }]);
    await db.decide(ines, "p", "approved");
    await db.sql("update public.posts set due_at = now() + interval '4 minutes'");
    expect(await claim()).toEqual([]);
    await db.sql("update public.posts set due_at = now() + interval '6 minutes'");
    expect((await claim()).length).toBe(1);
  });
});

describe("Quota — pauses longues et pause concurrente", () => {
  const state = async () => (await db.sql<{ seconds: number | null; reason: string | null }>(
    "select extract(epoch from backoff_until - now())::int as seconds, backoff_reason as reason from public.sync_state where mode = 'real'"))[0];
  const begin = async (scheduled = false) =>
    (await db.automation<{ begin_sync_run: { acquired: boolean; token?: string } }>("begin_sync_run", { p_mode: "real", p_scheduled: scheduled }))[0].begin_sync_run;
  const finish = (token: string, ok = true, seconds = 0, reason: string | null = null) =>
    db.automation("finish_sync_run", { p_mode: "real", p_token: token, p_ok: ok, p_backoff_seconds: seconds, p_backoff_reason: reason });

  it("un Retry-After de trois jours est conservé, puis plafonné à trente jours", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 3 * 86400 });
    expect((await state()).seconds).toBeGreaterThan(3 * 86400 - 20);
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 90 * 86400 });
    expect((await state()).seconds).toBeLessThanOrEqual(30 * 86400);
    expect((await state()).seconds).toBeGreaterThan(30 * 86400 - 20);
  });

  it("une pause posée pendant une exécution n'est pas effacée par la fin de cette exécution", async () => {
    db = await LocalDb.create();
    await db.seed();
    const run = await begin();
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 7200, p_reason: "Quota atteint pendant l'envoi" });
    await finish(run.token!, true, 0);
    expect((await state()).seconds).toBeGreaterThan(7100);
    expect((await state()).reason).toBe("Quota atteint pendant l'envoi");
  });

  it("une pause plus longue déjà posée n'est jamais raccourcie par la fin d'exécution", async () => {
    db = await LocalDb.create();
    await db.seed();
    const run = await begin();
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 5 * 86400 });
    await finish(run.token!, false, 900, "Quota de requêtes Buffer atteint.");
    expect((await state()).seconds).toBeGreaterThan(5 * 86400 - 60);
  });

  it("get_sync_pause renvoie la pause en cours, et rien une fois échue", async () => {
    db = await LocalDb.create();
    await db.seed();
    const one = async () => (await db.automation<{ get_sync_pause: { until: string } | null }>("get_sync_pause", { p_mode: "real" }))[0].get_sync_pause;
    expect(await one()).toBeNull();
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 600, p_reason: "Quota" });
    expect(await one()).toMatchObject({ reason: "Quota" });
    await db.sql("update public.sync_state set backoff_until = now() - interval '1 minute'");
    expect(await one()).toBeNull();
  });
});

describe("B6 — envoi Studio : abandon, variante retirée, absence jamais déduite", () => {
  const save = async (actor: Actor, payload: Record<string, unknown>, id: string | null = null, revision: number | null = null) =>
    (await db.as<{ r: { id: string; revision: number } }>(actor, "select public.studio_save_draft($1, $2, $3::jsonb) as r", [id, revision, JSON.stringify(payload)]))[0].r;
  const claimPush = (actor: Actor, draftId: string, force = false) =>
    db.as<{ variant_id: string; buffer_post_id: string | null }>(actor, "select * from public.studio_claim_push($1, $2)", [draftId, force]);
  const completePush = (actor: Actor, variantId: string, ok: boolean, bufferPostId: string | null, uncertain = false) =>
    db.as(actor, "select public.studio_complete_push($1, $2, $3, $4, $5, $6)", [variantId, ok, bufferPostId, ok ? null : "erreur", ok ? 1 : null, uncertain]);
  const resolve = async (actor: Actor, variantId: string, postId: string | null, absent: boolean, operator: boolean) =>
    (await db.as<{ r: string }>(actor, "select public.studio_resolve_unknown($1, $2, $3, $4, $5) as r", [variantId, postId, absent, operator, EVIDENCE]))[0].r;
  const prepare = async () => {
    db = await LocalDb.create();
    const seed = await db.seed();
    await db.sync([]);
    const draft = await save(seed.admin, {
      organizationId: seed.colibri, title: "T", dueAt: FUTURE, hashtags: ["a"],
      variants: [{ channelId: await channelId("canal-colibri"), text: "Bonjour" }],
    });
    return { ...seed, draft };
  };

  it("une recréation (ancien identifiant connu) dont la réponse est perdue est inconnue, et garde l'identifiant ancien", async () => {
    const { admin, draft } = await prepare();
    const [first] = await claimPush(admin, draft.id);
    await completePush(admin, first.variant_id, true, "ancien-supprime");
    await db.sql("update public.studio_drafts set revision = revision + 1, status = 'draft'");
    const [again] = await claimPush(admin, draft.id);
    expect(again.buffer_post_id).toBe("ancien-supprime");
    // Création sans identifiant obtenu, réponse perdue.
    await completePush(admin, again.variant_id, false, null, true);
    expect(await db.sql("select push_state, buffer_post_id from public.studio_variants")).toEqual([{ push_state: "unknown", buffer_post_id: "ancien-supprime" }]);
    await expect(claimPush(admin, draft.id)).rejects.toThrow("push_unknown");
    await expect(claimPush(admin, draft.id, true)).rejects.toThrow("push_unknown");
  });

  it("la tentative conserve de quoi retrouver le brouillon : canal Buffer, ancien identifiant, médias, texte, date", async () => {
    const { admin, draft } = await prepare();
    await claimPush(admin, draft.id);
    const [variant] = await db.sql<{ push_attempt: Record<string, unknown> }>("select push_attempt from public.studio_variants");
    expect(variant.push_attempt).toMatchObject({
      text: "Bonjour", hashtags: ["a"], bufferChannelId: "canal-colibri", service: "linkedin", assetKinds: [], priorBufferPostId: null,
    });
    expect(variant.push_attempt.dueAt).toBeTruthy();
  });

  it("un envoi abandonné bloque tout envoi, y compris forcé, même si la variante a été retirée ensuite", async () => {
    const { admin, colibri, draft } = await prepare();
    await claimPush(admin, draft.id);
    await db.sql("update public.studio_variants set push_claimed_at = now() - interval '20 minutes'");
    // La variante est retirée de la liste visible (autre canal choisi) : la tentative reste à résoudre.
    await save(admin, {
      organizationId: colibri, title: "T", dueAt: FUTURE, hashtags: ["a"],
      variants: [{ channelId: await channelId("canal-colibri-2"), text: "Autre canal" }],
    }, draft.id, draft.revision);
    await expect(claimPush(admin, draft.id)).rejects.toThrow("push_unknown");
    await expect(claimPush(admin, draft.id, true)).rejects.toThrow("push_unknown");
    // L'expiration le déclare inconnu, y compris pour la variante retirée.
    const expired = await db.as<{ n: number }>(admin, "select public.studio_expire_abandoned($1) as n", [draft.id]);
    expect(expired[0].n).toBe(1);
    expect(await db.sql("select push_state, removed_at is not null as removed from public.studio_variants order by removed_at is not null desc"))
      .toEqual([{ push_state: "unknown", removed: true }, { push_state: "idle", removed: false }]);
  });

  it("l'absence ne se confirme que par une personne, après le délai ; l'adoption n'exige rien d'autre", async () => {
    const { admin, ines, draft } = await prepare();
    const [claimed] = await claimPush(admin, draft.id);
    await completePush(admin, claimed.variant_id, false, null, true);
    await db.sql("update public.studio_variants set push_unknown_at = now() - interval '11 minutes'");
    await expect(resolve(admin, claimed.variant_id, null, true, false)).rejects.toThrow("absence_requires_operator");
    // Un client n'a aucun accès à la résolution.
    await expect(db.as(ines, "select public.studio_resolve_unknown($1, null, true, true)", [claimed.variant_id])).rejects.toThrow("forbidden");
    expect(await resolve(admin, claimed.variant_id, null, true, true)).toBe("retry_allowed");
    const [attempt] = await db.sql<{ push_attempt: Record<string, unknown> }>("select push_attempt from public.studio_variants");
    expect(attempt.push_attempt).toHaveProperty("absenceConfirmedBy");
    expect((await claimPush(admin, draft.id)).length).toBe(1);
  });
});

describe("B5 — notifications : revalidation à chaque réservation, restitution d'un message non remis", () => {
  const claimNotifications = () => db.automation<{ id: string; recipient_id: string; post_text: string }>("claim_notifications", { p_mode: "real" });
  const completeNotifications = (ids: string[], status: string) =>
    db.as("anon", "select public.complete_notifications($1, $2::uuid[], $3, null)", [SECRET, ids, status]);

  it("une notification restituée repart en attente, sans consommer de tentative, et est revalidée à la réservation suivante", async () => {
    db = await LocalDb.create();
    const { admin, colibri, ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    const first = await claimNotifications();
    expect(first).toHaveLength(1);
    await completeNotifications(first.map((item) => item.id), "released");
    expect(await db.sql("select status, attempts from public.notifications")).toEqual([{ status: "pending", attempts: 0 }]);
    // Révocation entre la restitution et la réservation suivante : annulée, jamais remise.
    await db.as(admin, "select public.admin_set_member($1, $2, false)", [colibri, ines.userId]);
    expect(await claimNotifications()).toEqual([]);
    expect(await db.sql("select status from public.notifications")).toEqual([{ status: "cancelled" }]);
  });

  it("une notification dont la version n'est plus courante est annulée à la réservation", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.sync([{ id: "p", text: "V1" }]);
    // Le post change de version sans que la file suive (cas limite) : la revalidation tranche.
    await db.sql("update public.posts set version = version + 1");
    expect(await claimNotifications()).toEqual([]);
  });
});
