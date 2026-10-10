import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FUTURE, LocalDb, SECRET, type Actor } from "../support/local-db";

/*
 * Migration 0009 : tests de non-régression des défauts de l'audit du 9 octobre 2026.
 * Chaque test reproduit un scénario qui échouait avant la migration, puis exige le comportement sûr.
 * Base PostgreSQL locale en mémoire : rien ne touche Supabase ni Buffer.
 */

/** Preuve consignée avec une absence confirmée par une personne (migration 0011). */
const EVIDENCE = "Vérifié dans Buffer : aucun brouillon à ce texte ni à cette date.";

let db: LocalDb;
afterEach(() => db?.close());

const channelId = async (bufferId: string) => (await db.sql<{ id: string }>("select id from public.channels where buffer_channel_id = $1", [bufferId]))[0].id;
const assign = async (actor: Actor, bufferId: string, organizationId: string | null, confirm = true) =>
  (await db.as<{ r: Record<string, number | boolean> }>(actor, "select public.admin_assign_channel($1, $2, $3) as r", [await channelId(bufferId), organizationId, confirm]))[0].r;
const visible = async (actor: Actor) =>
  (await db.as<{ buffer_post_id: string }>(actor, "select buffer_post_id from public.posts order by buffer_post_id")).map((row) => row.buffer_post_id);
const claim = (postId: string | null = null, mode: "real" | "mock" = "real") =>
  db.automation<{ id: string; token: string; content_hash: string; version: number }>("claim_posts_for_scheduling_in_mode", { p_mode: mode, p_post_id: postId });
const completeScheduling = async (postId: string, ok: boolean, token: string | null, error: string | null = null) =>
  (await db.automation<{ complete_scheduling: string }>("complete_scheduling", { p_post_id: postId, p_ok: ok, p_error: error, p_token: token }))[0].complete_scheduling;
const toUnschedule = () => db.automation<{ id: string; buffer_post_id: string }>("list_posts_to_unschedule_in_mode", { p_mode: "real" });
const events = async (bufferId: string) =>
  (await db.sql<{ type: string }>("select e.type from public.post_events e join public.posts p on p.id = e.post_id where p.buffer_post_id = $1 order by e.id", [bufferId])).map((row) => row.type);
const row = async (bufferId: string) =>
  (await db.sql<Record<string, unknown>>("select * from public.posts where buffer_post_id = $1", [bufferId]))[0];

describe("B2 — appartenance historique explicite", () => {
  it("un contenu importé après un transfert reste réservé à l'administrateur, même avec une date d'import récente", async () => {
    db = await LocalDb.create();
    const { admin, sofia, nordwind } = await db.seed();
    await db.sync([{ id: "ancien" }]);
    await assign(admin, "canal-colibri", nordwind);
    // L'ancien contenu n'avait jamais été vu par Cadence : il est découvert maintenant, avec created_at récent.
    await db.sync([{ id: "ancien" }, { id: "decouvert-tard", text: "Contenu confidentiel de Colibri" }]);
    expect(await visible(sofia)).toEqual([]);
    expect(await row("decouvert-tard")).toMatchObject({ ownership: "ambiguous", owner_organization_id: null });
    expect(await visible(admin)).toEqual(["ancien", "decouvert-tard"]);
    // Aucune lecture indirecte non plus.
    for (const table of ["post_versions", "post_events", "comments", "approval_decisions"]) {
      expect(await db.as(sofia, `select 1 from public.${table}`), table).toEqual([]);
    }
    await expect(db.as(sofia, "select public.decide_post($1, 'approved', $2)", [(await row("decouvert-tard")).id, (await row("decouvert-tard")).content_hash])).rejects.toThrow("not_found");
  });

  it("le client d'origine garde l'accès en lecture à ses publications après le transfert", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, nordwind } = await db.seed();
    await db.sync([{ id: "publie" }]);
    await db.decide(ines, "publie", "approved");
    await db.sync([{ id: "publie", status: "sent", hasReviewTag: false }]);
    expect(await visible(ines)).toEqual(["publie"]);

    await assign(admin, "canal-colibri", nordwind);
    expect(await visible(ines)).toEqual(["publie"]);
    expect(await visible(sofia)).toEqual([]);
    // Lecture seule : le canal n'est plus à ce client.
    await expect(db.as(ines, "select public.add_comment($1, 'Bonjour')", [(await row("publie")).id])).rejects.toThrow("not_found");
  });

  it("un contenu issu du Studio est attribué explicitement au client du contenu, canal transféré ou non", async () => {
    db = await LocalDb.create();
    const { admin, sofia, nordwind } = await db.seed();
    await db.sync([]);
    await assign(admin, "canal-colibri", nordwind);
    const channel = await channelId("canal-colibri");
    const [{ id: draft }] = await db.sql<{ id: string }>("insert into public.studio_drafts (organization_id, due_at) values ($1, $2) returning id", [nordwind, FUTURE]);
    await db.sql("insert into public.studio_variants (draft_id, channel_id, text, buffer_post_id, push_state) values ($1, $2, 'Studio', 'studio-1', 'pushed')", [draft, channel]);
    await db.sync([{ id: "studio-1" }]);
    expect(await row("studio-1")).toMatchObject({ ownership: "assigned" });
    expect(await visible(sofia)).toEqual(["studio-1"]);
  });

  it("l'admin attribue un import ambigu : visible du client choisi, événement d'audit enregistré", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, nordwind, colibri } = await db.seed();
    await db.sync([{ id: "a" }]);
    await assign(admin, "canal-colibri", nordwind);
    await db.sync([{ id: "tard" }]);
    const post = await row("tard");
    // Contenu ancien de Colibri : l'administrateur l'attribue à Colibri, pas au propriétaire actuel du canal.
    await db.as(admin, "select public.admin_set_post_owner($1, $2)", [[post.id], colibri]);
    expect(await events("tard")).toContain("owner_assigned");
    expect(await visible(sofia)).toEqual([]);
    // Le propriétaire n'est plus celui du canal : rien à décider, rien de programmable.
    expect(await db.post("tard")).toMatchObject({ approval_status: "none" });
    expect(await visible(ines)).toEqual([]);
    await expect(db.as(admin, "select public.admin_set_post_owner($1, $2)", [[post.id], "00000000-0000-0000-0000-000000000000"])).rejects.toThrow("organization_unavailable");
  });

  it("mise à niveau : l'historique existant d'un canal déjà transféré devient ambigu, les autres sont attribués", async () => {
    db = await LocalDb.create("0008");
    const { admin, ines, sofia, nordwind } = await db.seed();
    await db.sync([{ id: "stable" }, { id: "avant-transfert", channelId: "canal-nordwind" }]);
    await db.decide(ines, "stable", "approved");
    await db.as(admin, "select public.admin_assign_channel($1, $2, true)", [await channelId("canal-nordwind"), (await db.sql<{ id: string }>("select id from public.organizations where slug = 'colibri'"))[0].id]);
    await db.sync([{ id: "stable" }, { id: "avant-transfert", channelId: "canal-nordwind" }, { id: "apres", channelId: "canal-nordwind" }]);
    expect(await db.sql("select count(*)::int as n from public.channels where visible_from is not null")).toEqual([{ n: 1 }]);

    await db.migrate("0009_stabilisation.sql");
    expect(await row("stable")).toMatchObject({ ownership: "assigned" });
    expect(await row("stable")).toMatchObject({ approved_organization_id: (await row("stable")).owner_organization_id });
    expect(await row("avant-transfert")).toMatchObject({ ownership: "ambiguous", owner_organization_id: null });
    expect(await row("apres")).toMatchObject({ ownership: "ambiguous" });
    expect(await visible(sofia)).toEqual([]);
    expect(await visible(ines)).toEqual(["stable"]);
    expect(nordwind).toBeTruthy();
  });
});

describe("B3 — approbations liées au propriétaire, au contenu et à la version", () => {
  it("après un transfert, l'approbation de l'ancien client n'est plus programmable", async () => {
    db = await LocalDb.create();
    const { admin, ines, nordwind } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    expect(await events("p")).toEqual(["submitted", "approved"]);
    await assign(admin, "canal-colibri", nordwind);
    expect(await claim()).toEqual([]);
    expect(await row("p")).toMatchObject({ approval_status: "none", approved_hash: null, approved_organization_id: null });
    expect(await events("p")).toContain("suspended");
    // Le nouveau client ne peut pas non plus reprendre l'ancien accord : le post ne lui est pas attribué.
    await db.sync([{ id: "p" }]);
    expect(await claim()).toEqual([]);
  });

  it("l'archivage du client suspend la programmation, y compris celle déjà acceptée par Buffer (à confirmer)", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "approuve" }, { id: "programme" }]);
    await db.decide(ines, "approuve", "approved");
    await db.decide(ines, "programme", "approved");
    const [reserved] = await claim((await row("programme")).id as string);
    expect(await completeScheduling(reserved.id, true, reserved.token)).toBe("scheduled");
    await db.sync([{ id: "approuve" }, { id: "programme", status: "scheduled" }]);

    await db.as(admin, "select public.admin_set_organization_archived($1, true)", [colibri]);
    expect(await claim()).toEqual([]);
    // Buffer garde « programmé » : Cadence ne prétend pas l'avoir annulé tant que ce n'est pas constaté.
    expect(await row("programme")).toMatchObject({ approval_status: "none", buffer_status: "scheduled", schedule_state: "unschedule_pending" });
    expect(await row("approuve")).toMatchObject({ approval_status: "none", schedule_state: "idle" });
    expect((await toUnschedule()).map((item) => item.buffer_post_id)).toEqual(["programme"]);

    // Annulation confirmée dans Buffer : seulement alors le post redevient un brouillon.
    await db.automation("complete_unscheduling", { p_post_id: reserved.id, p_ok: true, p_observed_status: "draft" });
    expect(await row("programme")).toMatchObject({ buffer_status: "draft", schedule_state: "idle" });
  });

  it("une annulation échouée garde l'état « à confirmer » et l'erreur, sans annoncer de succès", async () => {
    db = await LocalDb.create();
    const { admin, ines, nordwind } = await db.seed();
    await db.sync([{ id: "programme" }]);
    await db.decide(ines, "programme", "approved");
    const [reserved] = await claim();
    await completeScheduling(reserved.id, true, reserved.token);
    await db.sync([{ id: "programme", status: "scheduled" }]);
    await assign(admin, "canal-colibri", nordwind);
    await db.automation("complete_unscheduling", { p_post_id: reserved.id, p_ok: false, p_error: "Buffer injoignable" });
    expect(await row("programme")).toMatchObject({ buffer_status: "scheduled", schedule_state: "unschedule_pending", schedule_error: "Buffer injoignable" });
  });

  it("la validation liée à un autre propriétaire que celui du canal n'est jamais réservable (écriture directe comprise)", async () => {
    db = await LocalDb.create();
    const { ines, nordwind } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    // Contournement : le canal change de client sans passer par la fonction d'attribution.
    await db.sql("update public.channels set organization_id = $1 where buffer_channel_id = 'canal-colibri'", [nordwind]);
    expect(await claim()).toEqual([]);
    // La synchronisation retire aussi la validation devenue invalide.
    await db.sync([{ id: "p" }]);
    expect(await row("p")).toMatchObject({ approval_status: "none" });
  });

  it("une date trop proche n'est pas approuvable : elle ne pourrait jamais être programmée", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    const soon = new Date(Date.now() + 60_000).toISOString();
    await db.sync([{ id: "proche", dueAt: soon }, { id: "ok" }]);
    await expect(db.decide(ines, "proche", "approved")).rejects.toThrow("date_too_close");
    // La demande de modifications reste possible.
    await db.decide(ines, "proche", "changes_requested", "Plus tard");
    await db.decide(ines, "ok", "approved");
    expect(await claim()).toHaveLength(1);
  });

  it("une approbation ne vaut que pour la version affichée : contenu modifié, plus de réservation", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p", text: "V1" }]);
    await db.decide(ines, "p", "approved");
    await db.sync([{ id: "p", text: "V2" }]);
    expect(await claim()).toEqual([]);
    expect(await row("p")).toMatchObject({ approval_status: "pending", version: 2, approved_hash: null });
  });
});

describe("B4 — concurrence entre synchronisation et programmation", () => {
  it("une confirmation tardive après modification est compensée, jamais enregistrée comme programmation valide", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p", text: "Validé" }]);
    await db.decide(ines, "p", "approved");

    const [reserved] = await claim();
    expect(reserved.token).toBeTruthy();
    // Pendant l'appel à Buffer, la synchronisation voit le contenu modifié : validation retirée.
    await db.sync([{ id: "p", text: "Modifié pendant la réservation" }]);
    expect(await row("p")).toMatchObject({ approval_status: "pending", schedule_state: "unschedule_pending", schedule_token: null });

    // Buffer avait déjà accepté : la confirmation arrive, mais elle n'est plus valable.
    expect(await completeScheduling(reserved.id, true, reserved.token)).toBe("stale");
    expect(await row("p")).toMatchObject({ approval_status: "pending", approved_hash: null, schedule_state: "unschedule_pending", buffer_status: "scheduled" });
    expect(await events("p")).toContain("schedule_stale");
    // La déprogrammation est bien à faire : le post figure dans la liste.
    expect((await toUnschedule()).map((item) => item.buffer_post_id)).toEqual(["p"]);

    await db.automation("complete_unscheduling", { p_post_id: reserved.id, p_ok: true, p_observed_status: "draft" });
    expect(await row("p")).toMatchObject({ schedule_state: "idle", buffer_status: "draft", approval_status: "pending" });
    expect(await claim()).toEqual([]);
  });

  it("une confirmation avec un ancien jeton est refusée après une nouvelle réservation", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const [first] = await claim();
    // Réservation abandonnée depuis plus de dix minutes : reprise par un autre passage avec un autre jeton.
    await db.sql("update public.posts set schedule_claimed_at = now() - interval '11 minutes' where id = $1", [first.id]);
    const [second] = await claim();
    expect(second.token).not.toBe(first.token);
    // La réservation plus récente décide : l'ancienne confirmation n'a aucun effet, et n'annule rien d'inutile.
    expect(await completeScheduling(first.id, true, first.token)).toBe("superseded");
    expect(await row("p")).toMatchObject({ schedule_state: "claimed" });
    expect(await completeScheduling(second.id, true, second.token)).toBe("scheduled");
  });

  it("confirmation normale, échec certain, puis constat d'une programmation dont la réponse a été perdue", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "ok" }, { id: "ko" }, { id: "perdu" }]);
    for (const id of ["ok", "ko", "perdu"]) await db.decide(ines, id, "approved");
    const reserved = Object.fromEntries((await claim()).map((item) => [item.id, item]));
    const id = async (bufferId: string) => (await row(bufferId)).id as string;
    expect(await completeScheduling(await id("ok"), true, reserved[await id("ok")].token)).toBe("scheduled");
    expect(await completeScheduling(await id("ko"), false, reserved[await id("ko")].token, "Refus de Buffer")).toBe("failed");
    // Délai dépassé : résultat inconnu, enregistré comme échec à vérifier (jamais comme succès).
    expect(await completeScheduling(await id("perdu"), false, reserved[await id("perdu")].token, "Délai dépassé")).toBe("failed");
    // Un second appel avec le même jeton ne change rien.
    expect(await completeScheduling(await id("ok"), false, reserved[await id("ok")].token, "tardif")).toBe("ignored");
    expect(await row("ok")).toMatchObject({ schedule_state: "scheduled" });

    // La synchronisation constate dans Buffer que « perdu » est bien programmé avec le contenu approuvé.
    await db.sync([{ id: "ok", status: "scheduled" }, { id: "ko" }, { id: "perdu", status: "scheduled" }]);
    expect(await row("perdu")).toMatchObject({ schedule_state: "scheduled", approval_status: "approved", buffer_status: "scheduled" });
    expect(await row("ko")).toMatchObject({ schedule_state: "failed" });
  });

  it("modification pendant un échec incertain : Buffer indique « programmé », le post est repassé en brouillon", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p", text: "A" }]);
    await db.decide(ines, "p", "approved");
    const [reserved] = await claim();
    await completeScheduling(reserved.id, false, reserved.token, "Délai dépassé");
    await db.sync([{ id: "p", text: "B", status: "scheduled" }]);
    expect(await row("p")).toMatchObject({ approval_status: "pending", schedule_state: "unschedule_pending" });
  });

  it("une déprogrammation d'un post déjà publié n'est jamais déclarée réussie", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const [reserved] = await claim();
    await completeScheduling(reserved.id, true, reserved.token);
    await db.sync([{ id: "p", text: "Changé", status: "scheduled" }]);
    expect(await row("p")).toMatchObject({ schedule_state: "unschedule_pending" });
    await db.automation("complete_unscheduling", { p_post_id: reserved.id, p_ok: true, p_observed_status: "sent" });
    expect(await row("p")).toMatchObject({ buffer_status: "sent", schedule_state: "idle" });
    expect(await events("p")).toContain("unschedule_too_late");
    expect(await events("p")).not.toContain("unscheduled");
  });

  it("un post programmé à la main dans Buffer, sans passage par Cadence, n'est jamais repassé en brouillon", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.sync([{ id: "manuel", status: "scheduled", hasReviewTag: false }]);
    expect(await row("manuel")).toMatchObject({ schedule_state: "idle", approval_status: "none" });
    expect(await toUnschedule()).toEqual([]);
  });

  it("la pause de quota s'enregistre sans verrou et ne raccourcit jamais une pause plus longue", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 3600, p_reason: "Quota" });
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 60, p_reason: "Quota court" });
    const [state] = await db.sql<{ backoff_until: Date; backoff_reason: string }>("select backoff_until, backoff_reason from public.sync_state where mode = 'real'");
    expect(state.backoff_until.getTime() - Date.now()).toBeGreaterThan(3000 * 1000);
    const begun = await db.automation<{ begin_sync_run: { acquired: boolean; reason?: string } }>("begin_sync_run", { p_mode: "real", p_scheduled: true });
    expect(begun[0].begin_sync_run).toMatchObject({ acquired: false, reason: "backoff" });
  });
});

describe("B5 — notifications et révocation des accès", () => {
  const queued = () => db.sql<{ status: string; recipient: string }>(
    "select n.status, pr.full_name as recipient from public.notifications n join public.profiles pr on pr.id = n.recipient_id order by n.created_at");
  const claimNotifications = () => db.automation<{ recipient_name: string; post_text: string }>("claim_notifications", { p_mode: "real" });

  it("un membre retiré pendant que la notification attend ne reçoit rien", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "p", text: "Secret de campagne" }]);
    expect(await queued()).toEqual([{ status: "pending", recipient: "ines" }]);
    await db.as(admin, "select public.admin_set_member($1, $2, false)", [colibri, ines.userId]);
    expect(await claimNotifications()).toEqual([]);
    expect(await queued()).toEqual([{ status: "cancelled", recipient: "ines" }]);
  });

  it("une tentative échouée n'est pas rejouée après la révocation, et ne transmet pas le contenu actuel", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "p", text: "Version 1" }]);
    const [first] = await claimNotifications();
    expect(first.post_text).toBe("Version 1");
    const ids = (await db.sql<{ id: string }>("select id from public.notifications")).map((item) => item.id);
    await db.as("anon", "select public.complete_notifications($1, $2::uuid[], 'failed', 'webhook')", [SECRET, ids]);
    await db.sql("update public.notifications set claimed_at = now() - interval '20 minutes'");
    await db.as(admin, "select public.admin_set_member($1, $2, false)", [colibri, ines.userId]);
    await db.sync([{ id: "p", text: "Version 2, ne doit pas partir" }]);
    expect(await claimNotifications()).toEqual([]);
    expect(await queued()).toEqual([{ status: "cancelled", recipient: "ines" }]);
  });

  it("client archivé, canal transféré, préférence désactivée ou publication retirée : notification annulée", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, colibri, nordwind } = await db.seed();
    await db.sync([{ id: "a" }, { id: "b" }, { id: "c", channelId: "canal-nordwind" }]);
    expect((await queued()).map((item) => item.recipient).sort()).toEqual(["ines", "ines", "sofia"]);
    await db.as(admin, "select public.admin_set_organization_archived($1, true)", [colibri]);
    await db.as(sofia, "select public.set_notification_preferences(false)");
    expect(await claimNotifications()).toEqual([]);
    expect((await queued()).map((item) => item.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(ines).toBeTruthy();
    expect(nordwind).toBeTruthy();
  });

  it("un transfert annule les demandes en attente de l'ancien client", async () => {
    db = await LocalDb.create();
    const { admin, nordwind } = await db.seed();
    await db.sync([{ id: "a" }]);
    await assign(admin, "canal-colibri", nordwind);
    expect(await claimNotifications()).toEqual([]);
    expect((await queued()).map((item) => item.status)).toEqual(["cancelled"]);
  });

  it("un administrateur rétrogradé en client ne reçoit plus les notifications d'administration", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    await db.sync([{ id: "a" }]);
    await db.decide(ines, "a", "changes_requested", "À revoir");
    expect((await queued()).map((item) => item.recipient).sort()).toEqual(["admin", "ines"]);
    await db.sql("update public.profiles set role = 'client' where id = $1", [admin.userId]);
    const delivered = await claimNotifications();
    expect(delivered.map((item) => item.recipient_name)).not.toContain("admin");
  });

  it("une modification d'une publication en attente met la demande non remise à la nouvelle version", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.sync([{ id: "a", text: "V1" }]);
    await db.sync([{ id: "a", text: "V2" }]);
    const delivered = await claimNotifications();
    expect(delivered.map((item) => item.post_text)).toEqual(["V2"]);
  });
});

describe("B6 — résultat Buffer incertain (côté base)", () => {
  type Saved = { id: string; revision: number };
  type Claim = { variant_id: string; buffer_post_id: string | null; revision: number; hashtags: string[]; media_ids: string[]; due_at: Date };
  const save = async (actor: Actor, payload: Record<string, unknown>) =>
    (await db.as<{ r: Saved }>(actor, "select public.studio_save_draft(null, null, $1::jsonb) as r", [JSON.stringify(payload)]))[0].r;
  const claimPush = (actor: Actor, draftId: string, force = false) => db.as<Claim>(actor, "select * from public.studio_claim_push($1, $2)", [draftId, force]);
  const completePush = (actor: Actor, variantId: string, ok: boolean, bufferPostId: string | null, uncertain = false) =>
    db.as(actor, "select public.studio_complete_push($1, $2, $3, $4, $5, $6)", [variantId, ok, bufferPostId, ok ? null : "erreur", ok ? 1 : null, uncertain]);

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

  it("une création sans réponse n'autorise aucune nouvelle création tant que Buffer n'a pas été interrogé", async () => {
    const { admin, draft } = await prepare();
    const [claimed] = await claimPush(admin, draft.id);
    await completePush(admin, claimed.variant_id, false, null, true);
    expect(await db.sql("select push_state, push_unknown_at is not null as dated from public.studio_variants")).toEqual([{ push_state: "unknown", dated: true }]);
    // Ni renvoi simple, ni renvoi forcé.
    await expect(claimPush(admin, draft.id)).rejects.toThrow("push_unknown");
    await expect(claimPush(admin, draft.id, true)).rejects.toThrow("push_unknown");
  });

  it("un échec certain autorise le renvoi ; un échec avec identifiant garde le brouillon sans le recréer", async () => {
    const { admin, draft } = await prepare();
    const [first] = await claimPush(admin, draft.id);
    await completePush(admin, first.variant_id, false, null, false);
    const [second] = await claimPush(admin, draft.id);
    // Brouillon créé puis échec ultérieur : l'identifiant est retenu même en cas d'incertitude.
    await completePush(admin, second.variant_id, false, "buf-1", true);
    expect(await db.sql("select push_state, buffer_post_id from public.studio_variants")).toEqual([{ push_state: "failed", buffer_post_id: "buf-1" }]);
    const [third] = await claimPush(admin, draft.id);
    expect(third.buffer_post_id).toBe("buf-1");
  });

  it("la réconciliation retrouve le brouillon (adopté) ou, après le délai de sécurité, autorise un nouvel envoi", async () => {
    const { admin, draft } = await prepare();
    const [claimed] = await claimPush(admin, draft.id);
    await completePush(admin, claimed.variant_id, false, null, true);
    const resolve = (id: string | null, absent: boolean, operator = false) =>
      db.as<{ r: string }>(admin, "select public.studio_resolve_unknown($1, $2, $3, $4, $5) as r", [claimed.variant_id, id, absent, operator, EVIDENCE]).then((rows) => rows[0].r);

    // Trop tôt : une réponse tardive de Buffer est encore possible.
    await expect(resolve(null, true)).rejects.toThrow("unknown_too_recent");
    expect(await resolve(null, false)).toBe("unchanged");

    await db.sql("update public.studio_variants set push_unknown_at = now() - interval '11 minutes'");
    // Cadence ne peut pas prouver l'absence d'un brouillon : seule une personne qui a vérifié Buffer peut l'affirmer.
    await expect(resolve(null, true)).rejects.toThrow("absence_requires_operator");
    expect(await resolve(null, true, true)).toBe("retry_allowed");
    const [again] = await claimPush(admin, draft.id);
    await completePush(admin, again.variant_id, false, null, true);
    expect(await resolve("buf-trouve", false)).toBe("adopted");
    expect(await db.sql("select push_state, buffer_post_id from public.studio_variants")).toEqual([{ push_state: "failed", buffer_post_id: "buf-trouve" }]);
    const [update] = await claimPush(admin, draft.id);
    expect(update.buffer_post_id).toBe("buf-trouve");
    await expect(db.as(admin, "select public.studio_resolve_unknown($1, 'x', false, false)", [claimed.variant_id])).rejects.toThrow("not_found");
  });

  it("l'envoi renvoie la photographie complète du contenu réservé, pas une relecture séparée", async () => {
    const { admin, draft } = await prepare();
    const [claimed] = await claimPush(admin, draft.id);
    expect(claimed).toMatchObject({ revision: draft.revision, hashtags: ["a"], media_ids: [] });
    expect(new Date(claimed.due_at).toISOString()).toBe(FUTURE);
    // Une modification pendant l'envoi ne change pas ce qui a été réservé.
    await db.as(admin, "select public.studio_save_draft($1, $2, $3::jsonb)", [draft.id, draft.revision, JSON.stringify({
      title: "T2", dueAt: FUTURE, hashtags: ["b"], variants: [{ channelId: await channelId("canal-colibri"), text: "Autre" }] })]);
    expect(claimed.hashtags).toEqual(["a"]);
  });

  it("un client archivé ne peut plus recevoir d'envoi", async () => {
    const { admin, colibri, draft } = await prepare();
    await db.as(admin, "select public.admin_set_organization_archived($1, true)", [colibri]);
    await expect(claimPush(admin, draft.id)).rejects.toThrow("organization_unavailable");
  });
});

describe("Versions immuables", () => {
  it("un contenu reçu publié avec un texte différent crée une nouvelle version sans toucher à la version approuvée", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    await db.sync([{ id: "p", text: "Texte approuvé" }]);
    await db.decide(ines, "p", "approved");
    const approved = await row("p");
    await db.sync([{ id: "p", text: "Texte réellement publié", status: "sent", hasReviewTag: false }]);

    const versions = await db.as<{ version: number; text: string }>(admin, "select version, text from public.post_versions where post_id = $1 order by version", [approved.id]);
    expect(versions).toEqual([{ version: 1, text: "Texte approuvé" }, { version: 2, text: "Texte réellement publié" }]);
    expect(await row("p")).toMatchObject({ version: 2, approved_version: 1, approved_hash: approved.content_hash });
    expect(await events("p")).toContain("content_changed");
  });

  it("une version enregistrée ne peut être ni modifiée ni supprimée", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.sync([{ id: "p" }]);
    await expect(db.sql("update public.post_versions set text = 'réécrit'")).rejects.toThrow("post_versions_immutable");
    await expect(db.sql("delete from public.post_versions")).rejects.toThrow("post_versions_immutable");
  });

  it("chaque changement de contenu crée une version, même sans validation en cours", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.sync([{ id: "p", text: "A", hasReviewTag: false }]);
    await db.sync([{ id: "p", text: "B", hasReviewTag: false }]);
    expect(await db.sql("select version, text from public.post_versions order by version")).toEqual([{ version: 1, text: "A" }, { version: 2, text: "B" }]);
  });
});

describe("Droits de 0009", () => {
  it("les fonctions internes ne sont pas appelables par un utilisateur, les automatisations exigent le secret", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await expect(db.as(ines, "select * from private.suspend_posts(null, null, 'x')")).rejects.toThrow(/permission denied/);
    await expect(db.as(ines, "select * from private.resolve_post_owner(null, 'x')")).rejects.toThrow(/permission denied/);
    await expect(db.as(ines, "select public.admin_set_post_owner($1, $2)", [[], null])).rejects.toThrow("forbidden");
    await expect(db.automation("claim_posts_for_scheduling_in_mode", { p_mode: "real" }, "mauvais-secret")).rejects.toThrow("invalid_secret");
    await expect(db.automation("complete_scheduling", { p_post_id: "00000000-0000-0000-0000-000000000000", p_ok: true }, "mauvais-secret")).rejects.toThrow("invalid_secret");
    await expect(db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 10 }, "mauvais-secret")).rejects.toThrow("invalid_secret");
    await expect(db.automation("set_sync_backoff", { p_mode: "autre", p_seconds: 10 })).rejects.toThrow("invalid_mode");
  });

  it("0009 refuse de s'appliquer sans les migrations 0004 à 0008", async () => {
    db = await LocalDb.create("0003");
    await expect(db.migrate("0009_stabilisation.sql")).rejects.toThrow(/migration_0009_requires_0004_to_0008/);
  });

  it("0009 peut être rejouée sans perte de données", async () => {
    db = await LocalDb.create();
    const { ines } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const before = await row("p");
    await db.migrate("0009_stabilisation.sql");
    expect(await row("p")).toMatchObject({ approval_status: "approved", approved_organization_id: before.approved_organization_id, ownership: "assigned" });
  });
});

describe("retour arrière de 0009", () => {
  it("rétablit les fonctions d'avant sans supprimer de données, et 0009 peut être rejouée ensuite", async () => {
    // Base telle qu'avant 0010 : le retour arrière de 0009 n'a de sens que sur elle (0010 se corrige en avant).
    db = await LocalDb.create("0009");
    const { admin, ines, nordwind } = await db.seed();
    await db.sync([{ id: "a" }, { id: "b" }]);
    await db.decide(ines, "a", "approved");
    const counts = () => db.sql("select (select count(*) from public.posts)::int as posts, (select count(*) from public.approval_decisions)::int as decisions, (select count(*) from public.post_versions)::int as versions");
    const before = await counts();

    await db.exec(readFileSync(resolve(process.cwd(), "supabase/outils/0009_retour_arriere.sql"), "utf8"));
    expect(await counts()).toEqual(before);
    // Anciennes signatures : réservation sans jeton, confirmation à quatre paramètres.
    const [reserved] = await db.automation<{ id: string }>("claim_posts_for_scheduling_in_mode", { p_mode: "real", p_post_id: null });
    expect(reserved).toBeTruthy();
    expect(Object.keys(reserved)).not.toContain("token");
    await db.automation("complete_scheduling", { p_post_id: reserved.id, p_ok: true });
    expect(await row("a")).toMatchObject({ schedule_state: "scheduled" });
    // Les fonctions propres à 0009 ont disparu.
    await expect(db.as(admin, "select public.admin_set_post_owner($1, $2)", [[], nordwind])).rejects.toThrow(/does not exist/);

    await db.migrate("0009_stabilisation.sql");
    await db.sync([{ id: "a" }, { id: "b" }]);
    expect(await counts()).toEqual(before);
    expect(await row("a")).toMatchObject({ ownership: "assigned" });
  });
});
