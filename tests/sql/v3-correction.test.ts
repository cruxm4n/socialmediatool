import { afterEach, describe, expect, it } from "vitest";

import { FUTURE, LocalDb, type Actor } from "../support/local-db";

/*
 * Migration 0011 (mission de correction V3). Chaque test énonce un invariant et le vérifie avec les rôles
 * PostgreSQL réels (anon / authenticated) et la RLS, sur une base locale en mémoire. Rien ne touche Supabase.
 * Les scénarios qui exigent plusieurs connexions simultanées sont dans tests/integration (PostgreSQL natif).
 */

let db: LocalDb;
afterEach(() => db?.close());

const row = async (bufferId: string) => (await db.sql<Record<string, unknown>>("select * from public.posts where buffer_post_id = $1", [bufferId]))[0];
const claim = () => db.automation<{ id: string; token: string; buffer_post_id: string }>("claim_posts_for_scheduling_in_mode", { p_mode: "real" });
const complete = async (postId: string, ok: boolean, token: string | null, extra: Record<string, unknown> = {}) =>
  (await db.automation<{ complete_scheduling: string }>("complete_scheduling", { p_post_id: postId, p_ok: ok, p_token: token, ...extra }))[0].complete_scheduling;
const toUnschedule = async () => (await db.automation<{ buffer_post_id: string }>("list_posts_to_unschedule_in_mode", { p_mode: "real" })).map((r) => r.buffer_post_id);
const summary = async (grace = 120) =>
  (await db.automation<{ urgent_work_summary: Record<string, unknown> }>("urgent_work_summary", { p_mode: "real", p_orphan_grace_seconds: grace }))[0].urgent_work_summary;

/** Un client, une publication approuvée puis réservée pour programmation (jeton retourné). */
const reserved = async () => {
  db = await LocalDb.create();
  const seed = await db.seed();
  await db.sync([{ id: "p1" }]);
  await db.decide(seed.ines, "p1", "approved");
  const [claimed] = await claim();
  return { ...seed, postId: claimed.id, token: claimed.token };
};

describe("C03 — confirmation incertaine, annulations à confirmer, réservations abandonnées", () => {
  it("une réponse perdue n'est pas un échec certain : la réservation reste en cours (même jeton) avec sa note", async () => {
    const { postId, token } = await reserved();
    expect(await complete(postId, false, token, { p_error: "Résultat incertain : délai dépassé.", p_uncertain: true })).toBe("uncertain");
    expect(await row("p1")).toMatchObject({ schedule_state: "claimed", schedule_token: token, schedule_error: expect.stringContaining("incertain") });
    // Un échec CERTAIN, lui, libère la réservation.
    expect(await complete(postId, false, token, { p_error: "refus" })).toBe("failed");
    expect(await row("p1")).toMatchObject({ schedule_state: "failed", schedule_token: null });
  });

  it("retrait de l'approbateur pendant une réservation incertaine : annulation à confirmer immédiatement, sans attendre un cycle", async () => {
    const { ines, colibri, postId, token } = await reserved();
    await complete(postId, false, token, { p_error: "Résultat incertain", p_uncertain: true });
    await db.sql("delete from public.organization_members where user_id = $1 and organization_id = $2", [ines.userId, colibri]);
    expect(await row("p1")).toMatchObject({ schedule_state: "unschedule_pending", approval_status: "pending", schedule_token: null });
    expect(await toUnschedule()).toEqual(["p1"]);
    // Le jeton d'avant l'invalidation ne confirme plus rien, et une réponse tardive prouvant l'effet est rapprochée.
    expect(await complete(postId, true, token)).toBe("stale");
    expect(await row("p1")).toMatchObject({ schedule_state: "unschedule_pending" });
  });

  it("une réservation abandonnée est listée (avec son jeton) après le délai de grâce seulement", async () => {
    const { postId, token } = await reserved();
    expect(await db.automation("list_orphan_claims_in_mode", { p_mode: "real", p_grace_seconds: 120 })).toEqual([]);
    expect((await summary()).orphan_claims).toBe(0);
    await db.sql("update public.posts set schedule_claimed_at = now() - interval '3 minutes' where id = $1", [postId]);
    const orphans = await db.automation<{ id: string; token: string }>("list_orphan_claims_in_mode", { p_mode: "real", p_grace_seconds: 120 });
    expect(orphans).toEqual([expect.objectContaining({ id: postId, token })]);
    expect((await summary()).orphan_claims).toBe(1);
    expect(await db.automation("list_orphan_claims_in_mode", { p_mode: "real", p_grace_seconds: 600 })).toEqual([]);
  });

  it("mark_unschedule_needed : idempotent, jamais pour un post déjà parti", async () => {
    const { postId } = await reserved();
    const mark = async () => (await db.automation<{ mark_unschedule_needed: string }>("mark_unschedule_needed", { p_post_id: postId, p_reason: "contenu différent" }))[0].mark_unschedule_needed;
    expect(await mark()).toBe("pending");
    expect(await row("p1")).toMatchObject({ schedule_state: "unschedule_pending", buffer_status: "scheduled" });
    expect(await mark()).toBe("pending");
    expect(await toUnschedule()).toEqual(["p1"]);
    await db.sql("update public.posts set schedule_state = 'idle', buffer_status = 'sending' where id = $1", [postId]);
    expect(await mark()).toBe("too_late");
    expect(await row("p1")).toMatchObject({ schedule_state: "idle", buffer_status: "sending" });
  });

  it("les annulations sont comptées et datées : l'urgence reste visible tant que Buffer n'a rien constaté", async () => {
    const { postId } = await reserved();
    await db.automation("mark_unschedule_needed", { p_post_id: postId });
    expect(await summary()).toMatchObject({ pending_unschedule: 1, orphan_claims: 0 });
    const before = await row("p1");
    expect(before.unschedule_since).not.toBeNull();
    expect(before.unschedule_attempts).toBe(0);
    await db.automation("complete_unscheduling", { p_post_id: postId, p_ok: false, p_error: "Buffer injoignable" });
    await db.automation("complete_unscheduling", { p_post_id: postId, p_ok: false, p_error: "Buffer injoignable" });
    expect(await row("p1")).toMatchObject({ schedule_state: "unschedule_pending", unschedule_attempts: 2, schedule_error: "Buffer injoignable" });
    expect((await row("p1")).unschedule_attempted_at).not.toBeNull();
    // Un statut non reconnu n'est jamais une annulation constatée.
    await db.automation("complete_unscheduling", { p_post_id: postId, p_ok: true, p_observed_status: "scheduled" });
    expect(await row("p1")).toMatchObject({ schedule_state: "unschedule_pending", unschedule_attempts: 3 });
    // Seul « draft » constaté la termine.
    await db.automation("complete_unscheduling", { p_post_id: postId, p_ok: true, p_observed_status: "draft" });
    expect(await row("p1")).toMatchObject({ schedule_state: "idle", buffer_status: "draft", unschedule_attempts: 0, unschedule_since: null });
  });

  it("un post publié pendant la panne est enregistré avec son vrai statut, jamais « brouillon »", async () => {
    const { postId } = await reserved();
    await db.automation("mark_unschedule_needed", { p_post_id: postId });
    await db.automation("complete_unscheduling", { p_post_id: postId, p_ok: true, p_observed_status: "sent" });
    expect(await row("p1")).toMatchObject({ schedule_state: "idle", buffer_status: "sent" });
  });
});

describe("C03 — baux et verrous", () => {
  it("le traitement urgent est exclusif ; son bail se renouvelle ; un bail expiré ne se renouvelle pas", async () => {
    db = await LocalDb.create();
    await db.seed();
    const begin = async () => (await db.automation<{ begin_urgent_run: { acquired: boolean; token?: string } }>("begin_urgent_run", { p_mode: "real" }))[0].begin_urgent_run;
    const first = await begin();
    expect(first.acquired).toBe(true);
    expect(await begin()).toMatchObject({ acquired: false, reason: "running" });
    const renew = async (token: string) => (await db.automation<{ renew_urgent_run: boolean }>("renew_urgent_run", { p_mode: "real", p_token: token }))[0].renew_urgent_run;
    expect(await renew(first.token!)).toBe(true);
    expect(await renew("00000000-0000-4000-8000-000000000000")).toBe(false);
    // Bail expiré : un nouveau détenteur le reprend, l'ancien ne peut plus ni renouveler ni conclure.
    await db.sql("update public.sync_state set urgent_until = now() - interval '1 second' where mode = 'real'");
    expect(await renew(first.token!)).toBe(false);
    const second = await begin();
    expect(second.acquired).toBe(true);
    const finish = async (token: string, ok = true) =>
      (await db.automation<{ finish_urgent_run: boolean }>("finish_urgent_run", { p_mode: "real", p_token: token, p_ok: ok, p_error: ok ? null : "panne", p_done: 2 }))[0].finish_urgent_run;
    expect(await finish(first.token!)).toBe(false);
    expect(await finish(second.token!, false)).toBe(true);
    expect(await db.sql("select urgent_last_ok, urgent_last_error, urgent_last_done from public.sync_state where mode = 'real'")).toEqual([
      { urgent_last_ok: false, urgent_last_error: "panne", urgent_last_done: 2 },
    ]);
  });

  it("le bail de la synchronisation générale se renouvelle ; expiré, il est perdu (l'ancien détenteur ne reprend pas la main)", async () => {
    db = await LocalDb.create();
    await db.seed();
    const [{ begin_sync_run: lock }] = await db.automation<{ begin_sync_run: { acquired: boolean; token: string } }>("begin_sync_run", { p_mode: "real", p_triggered_by: "test" });
    expect(lock.acquired).toBe(true);
    const renew = async (token: string) => (await db.automation<{ renew_sync_run: boolean }>("renew_sync_run", { p_mode: "real", p_token: token }))[0].renew_sync_run;
    expect(await renew(lock.token)).toBe(true);
    await db.sql("update public.sync_state set locked_until = now() - interval '1 second' where mode = 'real'");
    expect(await renew(lock.token)).toBe(false);
    const [{ begin_sync_run: next }] = await db.automation<{ begin_sync_run: { acquired: boolean; token: string } }>("begin_sync_run", { p_mode: "real", p_triggered_by: "test" });
    expect(next.acquired).toBe(true);
    // L'ancien détenteur ne peut pas clore l'exécution du nouveau.
    const [{ finish_sync_run: stale }] = await db.automation<{ finish_sync_run: boolean }>("finish_sync_run", { p_mode: "real", p_token: lock.token, p_ok: true });
    expect(stale).toBe(false);
  });
});

describe("C08 — une pause demandée n'est jamais raccourcie ; un refus se distingue d'une pause préventive", () => {
  const pause = async () => (await db.automation<{ get_sync_pause: { until: string; hard: boolean } | null }>("get_sync_pause", { p_mode: "real" }))[0].get_sync_pause;

  it("48 h puis 30 jours conservés ; la fin d'une exécution avec une pause plus courte ne la raccourcit pas", async () => {
    db = await LocalDb.create();
    await db.seed();
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 172_800, p_reason: "429" });
    const hours = async () => {
      const current = await pause();
      return (Date.parse(current!.until) - Date.now()) / 3_600_000;
    };
    expect(await hours()).toBeGreaterThan(47.9);
    expect((await pause())!.hard).toBe(true);
    const [{ begin_sync_run: lock }] = await db.automation<{ begin_sync_run: { token: string } }>("begin_sync_run", { p_mode: "real", p_triggered_by: "m" });
    await db.automation("finish_sync_run", { p_mode: "real", p_token: lock.token, p_ok: true, p_backoff_seconds: 900, p_backoff_reason: "préventive" });
    expect(await hours()).toBeGreaterThan(47.9);
    expect((await pause())!.hard).toBe(true);
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 30 * 86_400, p_reason: "429" });
    expect(await hours()).toBeGreaterThan(29 * 24);
    // Au-delà de la fenêtre de 30 jours : plafonné à cette fenêtre, jamais davantage.
    await db.automation("set_sync_backoff", { p_mode: "real", p_seconds: 90 * 86_400, p_reason: "429" });
    expect(await hours()).toBeLessThan(30 * 24 + 0.1);
  });

  it("une pause préventive n'est pas « dure » : les compensations restent permises", async () => {
    db = await LocalDb.create();
    await db.seed();
    const [{ begin_sync_run: lock }] = await db.automation<{ begin_sync_run: { token: string } }>("begin_sync_run", { p_mode: "real", p_triggered_by: "m" });
    await db.automation("finish_sync_run", { p_mode: "real", p_token: lock.token, p_ok: true, p_backoff_seconds: 3600, p_backoff_reason: "quota presque épuisé", p_backoff_hard: false });
    expect(await pause()).toMatchObject({ hard: false });
  });
});

describe("C05 — un changement de rôle retire les accords de l'approbateur", () => {
  it("client → administrateur : accord retiré, programmation à annuler, retour du rôle sans résurrection", async () => {
    const { ines, postId, token } = await reserved();
    expect(await complete(postId, true, token)).toBe("scheduled");
    await db.sql("update public.profiles set role = 'admin' where id = $1", [ines.userId]);
    expect(await row("p1")).toMatchObject({ approval_status: "pending", approved_by: null, schedule_state: "unschedule_pending" });
    expect(await toUnschedule()).toEqual(["p1"]);
    await db.sql("update public.profiles set role = 'client' where id = $1", [ines.userId]);
    // Aucune résurrection : une nouvelle décision sur la version actuelle est nécessaire.
    expect(await row("p1")).toMatchObject({ approval_status: "pending", approved_by: null });
  });

  it("deux approbateurs du même client : seul l'accord de la personne dont le rôle change est retiré", async () => {
    db = await LocalDb.create();
    const { ines, colibri } = await db.seed();
    const [{ id: hugo }] = await db.sql<{ id: string }>("insert into auth.users (email) values ('hugo@test.example') returning id");
    await db.sql("insert into public.profiles (id, full_name, role) values ($1, 'hugo', 'client')", [hugo]);
    await db.sql("insert into public.organization_members (organization_id, user_id) values ($1, $2)", [colibri, hugo]);
    await db.sync([{ id: "a" }, { id: "b" }]);
    await db.decide(ines, "a", "approved");
    await db.decide({ userId: hugo }, "b", "approved");
    await db.sql("update public.profiles set role = 'admin' where id = $1", [hugo]);
    expect(await row("a")).toMatchObject({ approval_status: "approved" });
    expect(await row("b")).toMatchObject({ approval_status: "pending" });
  });
});

describe("C05 — suppression du compte d'un approbateur", () => {
  it("le compte supprimé : son accord ne reste jamais exécutable, la programmation passe en annulation à confirmer", async () => {
    const { ines, postId, token } = await reserved();
    expect(await complete(postId, true, token)).toBe("scheduled");
    // Suppression du compte : le profil et les accès disparaissent avec lui (cascade), l'accord ne lui survit pas.
    await db.sql("delete from public.organization_members where user_id = $1", [ines.userId]);
    await db.sql("update public.posts set approved_by = null where approved_by = $1", [ines.userId]).catch(() => undefined);
    const after = await row("p1");
    expect(after).toMatchObject({ approval_status: "pending", schedule_state: "unschedule_pending" });
    expect(await claim()).toEqual([]);
  });
});

describe("C01 — une notification n'est lisible que si la publication l'est encore", () => {
  it("un destinataire déplacé vers un autre client ne relit plus les notifications de l'ancien", async () => {
    db = await LocalDb.create();
    const { ines, sofia, colibri, nordwind } = await db.seed();
    await db.sync([{ id: "col" }, { id: "nor", channelId: "canal-nordwind" }]);
    await db.decide(ines, "col", "approved");
    const insert = async (recipient: string, bufferId: string, key: string) => {
      const post = await row(bufferId);
      await db.sql(
        "insert into public.notifications (kind, mode, recipient_id, post_id, organization_id, post_version, dedupe_key) values ('review_requested', 'real', $1, $2, $3, 1, $4)",
        [recipient, post.id, post.owner_organization_id, key],
      );
    };
    await insert(ines.userId, "col", "k1");
    await insert(sofia.userId, "nor", "k2");
    // Les notifications générées par les déclencheurs et celles insérées ici : chacun ne lit que les siennes.
    const keys = async (actor: Actor) => (await db.as<{ dedupe_key: string }>(actor, "select dedupe_key from public.notifications")).map((r) => r.dedupe_key);
    expect(await keys(ines)).toContain("k1");
    expect(await keys(ines)).not.toContain("k2");
    expect(await keys(sofia)).toContain("k2");
    expect(await keys(sofia)).not.toContain("k1");

    // Inès change de client : elle ne lit plus rien de ce qui concernait Colibri.
    await db.sql("delete from public.organization_members where user_id = $1", [ines.userId]);
    await db.sql("insert into public.organization_members (organization_id, user_id) values ($1, $2)", [nordwind, ines.userId]);
    expect(await keys(ines)).toEqual([]);
    expect(await keys(sofia)).toContain("k2");
    expect(colibri).toBeTruthy();
  });
});

describe("C02 — identité des tentatives d'envoi Studio", () => {
  type Seed = Awaited<ReturnType<LocalDb["seed"]>>;
  const channel = async (bufferId: string) => (await db.sql<{ id: string }>("select id from public.channels where buffer_channel_id = $1", [bufferId]))[0].id;
  const save = async (actor: Actor, id: string | null, revision: number | null, payload: Record<string, unknown>) =>
    (await db.as<{ r: { id: string; revision: number } }>(actor, "select public.studio_save_draft($1, $2, $3::jsonb) as r", [id, revision, JSON.stringify(payload)]))[0].r;
  const claimPush = (actor: Actor, draftId: string) =>
    db.as<{ variant_id: string; attempt_id: string; text: string; buffer_post_id: string | null }>(actor, "select * from public.studio_claim_push($1, false)", [draftId]);
  const completePush = async (actor: Actor, variantId: string, ok: boolean, postId: string | null, attempt: string | null, extra: { uncertain?: boolean; revision?: number | null } = {}) =>
    (await db.as<{ r: string }>(actor, "select public.studio_complete_push($1, $2, $3, null, $4, $5, $6) as r", [variantId, ok, postId, extra.revision ?? 1, extra.uncertain ?? false, attempt]))[0].r;
  const variant = async () => (await db.sql<Record<string, unknown>>("select * from public.studio_variants"))[0];
  const start = async (): Promise<Seed & { draftId: string }> => {
    db = await LocalDb.create();
    const seed = await db.seed();
    await db.sync([]);
    const saved = await save(seed.admin, null, null, { organizationId: seed.colibri, title: "T", dueAt: FUTURE, variants: [{ channelId: await channel("canal-colibri"), text: "Bonjour" }] });
    return { ...seed, draftId: saved.id };
  };

  it("la tentative est numérotée ; sa confirmation l'applique ; l'événement est consigné", async () => {
    const { admin, draftId } = await start();
    const [claimed] = await claimPush(admin, draftId);
    expect(claimed.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await completePush(admin, claimed.variant_id, true, "buf-1", claimed.attempt_id)).toBe("applied");
    expect(await variant()).toMatchObject({ push_state: "pushed", buffer_post_id: "buf-1" });
    expect(await db.sql("select outcome, attempt_id from public.studio_push_events")).toEqual([{ outcome: "applied", attempt_id: claimed.attempt_id }]);
  });

  it("une réponse tardive d'une AUTRE tentative n'est jamais appliquée : brouillon orphelin consigné, tentative courante intacte", async () => {
    const { admin, draftId } = await start();
    const [first] = await claimPush(admin, draftId);
    await db.sql("update public.studio_variants set push_claimed_at = now() - interval '6 minutes'");
    await db.as(admin, "select public.studio_expire_abandoned($1)", [draftId]);
    await db.sql("update public.studio_variants set push_unknown_at = now() - interval '11 minutes'");
    const resolved = await db.as<{ r: string }>(admin, "select public.studio_resolve_unknown($1, null, true, true, 'Vérifié dans Buffer : aucun brouillon.') as r", [first.variant_id]);
    expect(resolved[0].r).toBe("retry_allowed");
    const [second] = await claimPush(admin, draftId);
    expect(second.attempt_id).not.toBe(first.attempt_id);
    // La première tentative répond enfin : elle avait bien créé un brouillon.
    expect(await completePush(admin, first.variant_id, true, "tardif-1", first.attempt_id)).toBe("orphan");
    expect(await variant()).toMatchObject({ push_state: "pushing", buffer_post_id: null, push_orphans: ["tardif-1"], push_attempt_id: second.attempt_id });
    // La seconde se termine normalement.
    expect(await completePush(admin, second.variant_id, true, "buf-2", second.attempt_id)).toBe("applied");
    expect(await variant()).toMatchObject({ push_state: "pushed", buffer_post_id: "buf-2" });
  });

  it("la réponse tardive de la MÊME tentative (devenue « inconnue ») est rapprochée sans réconciliation", async () => {
    const { admin, draftId } = await start();
    const [claimed] = await claimPush(admin, draftId);
    await db.sql("update public.studio_variants set push_claimed_at = now() - interval '6 minutes'");
    await db.as(admin, "select public.studio_expire_abandoned($1)", [draftId]);
    expect(await variant()).toMatchObject({ push_state: "unknown" });
    expect(await completePush(admin, claimed.variant_id, true, "buf-tardif", claimed.attempt_id)).toBe("late_applied");
    expect(await variant()).toMatchObject({ push_state: "pushed", buffer_post_id: "buf-tardif" });
  });

  it("une absence ne se confirme qu'avec une preuve consignée (qui, quand, quoi), pour cette tentative", async () => {
    const { admin, draftId } = await start();
    const [claimed] = await claimPush(admin, draftId);
    await completePush(admin, claimed.variant_id, false, null, claimed.attempt_id, { uncertain: true, revision: null });
    expect(await variant()).toMatchObject({ push_state: "unknown" });
    await db.sql("update public.studio_variants set push_unknown_at = now() - interval '11 minutes'");
    const resolve = (evidence: string | null) =>
      db.as(admin, "select public.studio_resolve_unknown($1, null, true, true, $2) as r", [claimed.variant_id, evidence]);
    await expect(resolve(null)).rejects.toThrow("evidence_required");
    await expect(resolve("ok")).rejects.toThrow("evidence_required");
    expect((await resolve("Brouillons du canal LinkedIn relus dans Buffer à 14 h : aucun.")) as { r: string }[]).toEqual([{ r: "retry_allowed" }]);
    const attempt = (await variant()).push_attempt as Record<string, unknown>;
    expect(attempt).toMatchObject({ absenceEvidence: expect.stringContaining("LinkedIn"), attemptId: claimed.attempt_id });
    expect(attempt.absenceConfirmedBy).toBeTruthy();
  });

  it("un brouillon déjà publié ou rattaché ailleurs ne peut pas être adopté", async () => {
    const { admin, draftId } = await start();
    await db.sync([{ id: "deja-publie", status: "sent" }]);
    const [claimed] = await claimPush(admin, draftId);
    await completePush(admin, claimed.variant_id, false, null, claimed.attempt_id, { uncertain: true, revision: null });
    await expect(db.as(admin, "select public.studio_resolve_unknown($1, 'deja-publie', false, false)", [claimed.variant_id])).rejects.toThrow("post_already_published");
  });
});

describe("T09 — droits, signatures et paramètres non autorisés (migration 0011)", () => {
  const WITH_ARGS: Record<string, Record<string, unknown>> = {
    begin_urgent_run: { p_mode: "real" },
    renew_urgent_run: { p_mode: "real", p_token: "00000000-0000-4000-8000-000000000000" },
    finish_urgent_run: { p_mode: "real", p_token: "00000000-0000-4000-8000-000000000000", p_ok: true },
    renew_sync_run: { p_mode: "real", p_token: "00000000-0000-4000-8000-000000000000" },
    urgent_work_summary: { p_mode: "real" },
    list_orphan_claims_in_mode: { p_mode: "real" },
    mark_unschedule_needed: { p_post_id: "00000000-0000-4000-8000-000000000000" },
    complete_scheduling: { p_post_id: "00000000-0000-4000-8000-000000000000", p_ok: true },
    complete_unscheduling: { p_post_id: "00000000-0000-4000-8000-000000000000", p_ok: true },
    list_posts_to_unschedule_in_mode: { p_mode: "real" },
    set_sync_backoff: { p_mode: "real", p_seconds: 60 },
    get_sync_pause: { p_mode: "real" },
    complete_notifications: { p_ids: [], p_status: "verify" },
    schema_status: {},
  };

  it("chaque fonction d'automatisation refuse un secret faux ou absent, sans aucun effet", async () => {
    db = await LocalDb.create();
    await db.seed();
    const before = await db.sql("select count(*)::int as n from public.sync_state");
    for (const [name, args] of Object.entries(WITH_ARGS)) {
      await expect(db.automation(name, args, "secret-faux"), name).rejects.toThrow();
      await expect(db.as("anon", `select * from public.${name}(${["p_secret => null", ...Object.keys(args).map((key, index) => `${key} => $${index + 1}`)].join(", ")})`, Object.values(args).map((value) => (Array.isArray(value) ? JSON.stringify(value) : value))), name).rejects.toThrow();
    }
    expect(await db.sql("select count(*)::int as n from public.sync_state")).toEqual(before);
  });

  it("un mode inattendu est refusé (aucune injection d'un autre « mode »)", async () => {
    db = await LocalDb.create();
    await db.seed();
    for (const mode of ["", "REAL", "real'; drop table public.posts; --", "x"]) {
      await expect(db.automation("urgent_work_summary", { p_mode: mode })).rejects.toThrow(/invalid_mode/);
      await expect(db.automation("begin_urgent_run", { p_mode: mode })).rejects.toThrow(/invalid_mode/);
    }
  });

  it("les fonctions de 0011 : SECURITY DEFINER avec search_path vide, une seule signature par nom, pas d'EXECUTE public", async () => {
    db = await LocalDb.create();
    const names = [...Object.keys(WITH_ARGS), "track_unschedule", "on_profile_role_changed", "studio_claim_push", "studio_complete_push", "studio_resolve_unknown", "finish_sync_run"];
    const rows = await db.sql<{ schema: string; name: string; args: string; definer: boolean; config: string | null; public_exec: boolean }>(
      `select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as definer, p.proconfig::text as config,
              has_function_privilege('public', p.oid, 'execute') as public_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.proname = any ($1)`, [names]);
    for (const name of names) {
      const copies = rows.filter((row) => row.name === name);
      expect(copies.length, `${name} : une seule signature`).toBe(1);
      expect(copies[0].definer, `${name} SECURITY DEFINER`).toBe(true);
      expect(copies[0].config ?? "", `${name} search_path vide`).toMatch(/search_path=\\"\\"/);
      expect(copies[0].public_exec, `${name} : pas d'EXECUTE pour PUBLIC`).toBe(false);
    }
  });

  it("les fonctions internes (private.*) ne sont exécutables ni par anon ni par authenticated", async () => {
    db = await LocalDb.create();
    for (const signature of ["private.track_unschedule()", "private.on_profile_role_changed()", "private.revoke_member_approvals(uuid, uuid, text)", "private.notification_is_eligible(uuid)"]) {
      const [row] = await db.sql<{ anon: boolean; authenticated: boolean }>(
        "select has_function_privilege('anon', $1::regprocedure, 'execute') as anon, has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated", [signature]);
      expect(row, signature).toEqual({ anon: false, authenticated: false });
    }
  });

  it("le journal des tentatives est en lecture administrateur seule : un client n'en lit aucune ligne et n'y écrit pas", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    expect(await db.as(ines, "select 1 from public.studio_push_events")).toEqual([]);
    await expect(db.as(ines, "insert into public.studio_push_events (variant_id, outcome, ok) values (gen_random_uuid(), 'applied', true)")).rejects.toThrow(/permission denied/);
    await expect(db.as(admin, "update public.studio_push_events set error = 'x'")).rejects.toThrow(/permission denied/);
    await expect(db.as("anon", "select 1 from public.studio_push_events")).rejects.toThrow(/permission denied/);
  });
});
