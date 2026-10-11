import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { SECRET, FUTURE, LocalDb, type Actor } from "../support/local-db";

/*
 * Migration 0013 — cycle de vie des connexions, identité du compte, collisions, anciens appelants.
 * Chaque test énonce un invariant du contrôle indépendant du 10 octobre 2026 (P1-01 à P1-05) et le vérifie avec les
 * rôles PostgreSQL réels, sur une base locale en mémoire. Aucun secret réel, aucun appel externe.
 * (La concurrence entre deux transactions ne peut pas se jouer ici : elle l'est sur PostgreSQL natif, dans
 * tests/integration/multi-comptes.test.ts.)
 */

let db: LocalDb;
afterEach(() => db?.close());

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

type Seed = Awaited<ReturnType<LocalDb["seed"]>>;
type User = { userId: string };

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const create = (actor: User, id: string, args: { org?: string | null; ciphertext?: string; account?: string | null; label?: string } = {}) => {
  const ciphertext = args.ciphertext ?? `v1.${id.slice(0, 8)}.t.c`;
  return db.automation("server_create_provider_connection", {
    p_actor: actor.userId, p_id: id, p_label: args.label ?? `Compte ${id.slice(0, 4)}`, p_organization_id: args.org ?? null, p_ciphertext: ciphertext,
    p_key_version: 1, p_hint: "1234", p_fingerprint: fingerprint(ciphertext),
    p_external_account_id: args.account === undefined ? `acct-${id.slice(0, 8)}` : args.account, p_external_account_label: "Compte constaté",
  });
};
const replace = async (actor: User, id: string, ciphertext: string, account: string | null) =>
  (await db.automation<{ server_set_provider_credential: string }>("server_set_provider_credential", {
    p_actor: actor.userId, p_connection_id: id, p_ciphertext: ciphertext, p_key_version: 1, p_hint: "9999", p_fingerprint: fingerprint(ciphertext),
    p_external_account_id: account, p_external_account_label: null,
  }))[0].server_set_provider_credential;
const verify = async (actor: User, id: string, ok: boolean, account: string | null, detail: string | null = null) =>
  (await db.automation<{ server_record_provider_verification: string }>("server_record_provider_verification", {
    p_actor: actor.userId, p_connection_id: id, p_ok: ok, p_external_account_id: account, p_external_account_label: "Compte", p_detail: detail,
  }))[0].server_record_provider_verification;

/** Deux clients, chacun avec SON compte réel vérifié, un canal attribué et lu depuis chaque compte. */
async function twoAccounts(): Promise<Seed> {
  db = await LocalDb.create();
  const seed = await db.seed();
  await create(seed.admin, A, { org: seed.colibri });
  await create(seed.admin, B, { org: seed.nordwind });
  return seed;
}

interface Item { id: string; channelId: string; status?: string; text?: string }
const snapshot = (connectionId: string, channels: { id: string; org?: string }[], posts: Item[], extra: Record<string, unknown> = {}) => ({
  mode: "real", complete: true, scopeConnectionIds: [connectionId],
  channels: channels.map((c) => ({ id: c.id, service: "linkedin", name: c.id, connectionId, ...(c.org ? { organizationSlug: c.org } : {}) })),
  posts: posts.map((p) => ({ id: p.id, channelId: p.channelId, service: "linkedin", status: p.status ?? "draft", text: p.text ?? `Texte ${p.id}`, dueAt: FUTURE, hasReviewTag: true, assets: [], connectionId })),
  ...extra,
});
const sync = async (payload: Record<string, unknown>) =>
  (await db.automation<{ sync_buffer_posts: Record<string, number> }>("sync_buffer_posts", { p_payload: payload }))[0].sync_buffer_posts;
const status = async (id: string) => (await db.sql<{ status: string }>("select status from public.provider_connections where id = $1", [id]))[0].status;
const events = async (id: string) => (await db.sql<{ type: string }>("select type from public.provider_connection_events where connection_id = $1 order by id", [id])).map((e) => e.type);
const claim = async (postId: string | null = null) =>
  (await db.automation<{ buffer_post_id: string }>("claim_posts_for_scheduling_in_mode", { p_mode: "real", p_post_id: postId })).map((row) => row.buffer_post_id).sort();
const run = async () =>
  (await db.automation<{ provider_connections_for_run: Record<string, unknown>[] }>("provider_connections_for_run", { p_mode: "real" }))[0].provider_connections_for_run;
const revoke = async (actor: Actor, fn: "admin_request_provider_revocation" | "admin_revoke_provider_connection", id: string, force?: boolean) =>
  (await db.as<{ r: { revoked: boolean; revoking?: boolean; forced?: boolean; unresolved?: Record<string, number> } }>(
    actor, fn === "admin_revoke_provider_connection" ? "select public.admin_revoke_provider_connection($1, $2) as r" : "select public.admin_request_provider_revocation($1) as r",
    fn === "admin_revoke_provider_connection" ? [id, force ?? false] : [id]))[0].r;

/** A et B ont chacun une publication approuvée par leur client, prête à être programmée. */
async function approvedOnBoth(seed: Seed) {
  await sync(snapshot(A, [{ id: "ch-a", org: "colibri" }], [{ id: "a1", channelId: "ch-a" }]));
  await sync(snapshot(B, [{ id: "ch-b", org: "nordwind" }], [{ id: "b1", channelId: "ch-b" }]));
  await db.decide(seed.ines, "a1", "approved");
  await db.decide(seed.sofia, "b1", "approved");
}

describe("P1-02 — une clé réelle et son identité ne s'enregistrent que par le serveur", () => {
  it("une session, même administrateur, ne peut ni enregistrer une clé réelle ni la remplacer ni déclarer une identité", async () => {
    const seed = await twoAccounts();
    await expect(db.as(seed.admin, "select public.admin_create_provider_connection($1, 'real', 'x', null, 'stored', 'v1.a.b.c', 1, '1234', null)", [C])).rejects.toThrow(/server_only/);
    await expect(db.as(seed.admin, "select public.admin_create_provider_connection($1, 'real', 'x', null, 'environment', null, 1, null, null)", [C])).rejects.toThrow(/server_only/);
    await expect(db.as(seed.admin, "select public.admin_set_provider_credential($1, 'v1.a.b.c', 1, '0000', 'acct-11111111')", [A])).rejects.toThrow(/server_only/);
    // Les fonctions du serveur exigent le secret ET un acteur administrateur.
    await expect(db.automation("server_create_provider_connection", { p_actor: seed.admin.userId, p_id: C, p_label: "x", p_organization_id: null, p_ciphertext: "v1.a.b.c", p_key_version: 1, p_hint: "1", p_fingerprint: fingerprint("z") }, "mauvais-secret")).rejects.toThrow();
    await expect(create(seed.ines, C)).rejects.toThrow(/forbidden/);
    await expect(verify(seed.sofia, A, true, "acct-pirate")).rejects.toThrow(/forbidden/);
    // Et aucune écriture directe : l'identité constatée n'est pas modifiable par une session.
    await expect(db.as(seed.admin, "update public.provider_connections set external_account_id = 'acct-pirate' where id = $1", [A])).rejects.toThrow(/permission denied/);
    expect(await db.sql("select 1 from public.provider_connections where id = $1", [C])).toEqual([]);
  });

  it("un compte fournisseur n'est relié que par UNE connexion ; une même clé ne s'enregistre qu'une fois", async () => {
    const seed = await twoAccounts();
    await expect(create(seed.admin, C, { org: seed.nordwind, account: "acct-11111111" })).rejects.toThrow(/provider_account_already_connected/);
    await expect(create(seed.admin, C, { org: seed.nordwind, ciphertext: `v1.${A.slice(0, 8)}.t.c`, account: "acct-autre" })).rejects.toThrow(/provider_credential_reused/);
    // La clé du client B présentée pour remplacer celle du client A : refusée, rien ne change.
    expect(await replace(seed.admin, A, `v1.${B.slice(0, 8)}.t.c`, "acct-11111111")).toBe("credential_reused");
    expect(await replace(seed.admin, A, "v1.neuve.t.c", "acct-22222222")).toBe("account_mismatch");
    expect((await run()).find((c) => c.id === A)).toMatchObject({ ciphertext: `v1.${A.slice(0, 8)}.t.c`, externalAccountId: "acct-11111111", verified: true });
    // Une fois le compte libéré par une révocation, il peut être relié de nouveau.
    expect((await revoke(seed.admin, "admin_request_provider_revocation", A)).revoked).toBe(true);
    await create(seed.admin, C, { org: seed.colibri, account: "acct-11111111" });
  });

  it("remplacement : même compte accepté ; identité inconnue refusée sur une connexion vérifiée ; l'ancienne clé reste", async () => {
    const seed = await twoAccounts();
    await expect(replace(seed.admin, A, "v1.sans-identite.t.c", null)).rejects.toThrow(/verification_required/);
    expect((await run()).find((c) => c.id === A)?.ciphertext).toBe(`v1.${A.slice(0, 8)}.t.c`);
    expect(await replace(seed.admin, A, "v1.meme-compte.t.c", "acct-11111111")).toBe("replaced");
    expect((await run()).find((c) => c.id === A)).toMatchObject({ ciphertext: "v1.meme-compte.t.c", verified: true });
    expect(await events(A)).toEqual(["created", "credential_replaced"]);
    expect(JSON.stringify(await db.sql("select * from public.provider_connection_events"))).not.toMatch(/meme-compte|sans-identite/);
  });

  it("une clé enregistrée sans vérification (serveur en simulation) est signalée non vérifiée ; la vérification pose l'identité une fois pour toutes", async () => {
    db = await LocalDb.create();
    const seed = await db.seed();
    await create(seed.admin, A, { org: seed.colibri, account: null });
    expect((await run())[0]).toMatchObject({ id: A, verified: false, externalAccountId: null });
    expect(await events(A)).toEqual(["created"]);
    // Un échec (clé refusée, délai, quota) ne démontre rien et ne pose aucune identité.
    expect(await verify(seed.admin, A, false, null, "Buffer n'a pas répondu")).toBe("failed");
    expect((await run())[0]).toMatchObject({ verified: false });
    expect(await verify(seed.admin, A, true, "acct-colibri")).toBe("verified");
    expect((await run())[0]).toMatchObject({ verified: true, externalAccountId: "acct-colibri" });
    // Ensuite, la même clé constatée sous un AUTRE compte : signalée, l'identité d'origine reste.
    expect(await verify(seed.admin, A, true, "acct-etranger")).toBe("account_mismatch");
    expect((await run())[0]).toMatchObject({ externalAccountId: "acct-colibri" });
    // Un échec passager n'efface pas une identité déjà constatée.
    expect(await verify(seed.admin, A, false, null)).toBe("failed");
    expect((await run())[0]).toMatchObject({ verified: true, externalAccountId: "acct-colibri" });
    expect(await events(A)).toEqual(["created", "verification_failed", "verified", "verification_failed", "verification_failed"]);
    // Un second compte ne peut pas être vérifié sous une identité déjà reliée.
    await create(seed.admin, B, { org: seed.nordwind, account: null });
    expect(await verify(seed.admin, B, true, "acct-colibri")).toBe("account_already_connected");
  });

  it("rotation de la clé maître : re-chiffrement conditionnel à la version, identité et vérification conservées", async () => {
    const seed = await twoAccounts();
    const reencrypt = async (from: number, to: number, text: string) =>
      (await db.automation<{ server_reencrypt_provider_credential: boolean }>("server_reencrypt_provider_credential", {
        p_actor: seed.admin.userId, p_connection_id: A, p_ciphertext: text, p_key_version: to, p_from_key_version: from, p_fingerprint: fingerprint(text),
      }))[0].server_reencrypt_provider_credential;
    expect(await reencrypt(1, 2, "v1.rechiffre.t.c")).toBe(true);
    // Une seconde rotation partie de l'ancienne version n'écrase pas la première.
    expect(await reencrypt(1, 3, "v1.perdant.t.c")).toBe(false);
    expect((await run()).find((c) => c.id === A)).toMatchObject({ ciphertext: "v1.rechiffre.t.c", keyVersion: 2, verified: true, externalAccountId: "acct-11111111" });
    expect((await run()).find((c) => c.id === B)).toMatchObject({ keyVersion: 1 });
    expect(await events(A)).toEqual(["created", "credential_reencrypted"]);
    await expect(db.as(seed.ines, "select public.server_reencrypt_provider_credential($1, $2, $3, 'v1.x.y.z', 2, 1, $4)", [SECRET, seed.ines.userId, A, fingerprint("x")])).rejects.toThrow(/forbidden/);
  });
});

describe("P1-01 — révocation et réservations partagent le même verrou", () => {
  it("connexion révoquée : aucune programmation n'est plus réservée sur ses canaux ; l'autre client continue", async () => {
    const seed = await twoAccounts();
    await approvedOnBoth(seed);
    expect((await revoke(seed.admin, "admin_request_provider_revocation", A)).revoked).toBe(true);
    expect(await claim()).toEqual(["b1"]);
    expect((await db.post("a1")).schedule_state).toBe("idle");
    expect((await db.post("b1")).schedule_state).toBe("claimed");
    // Même demandée nommément, la publication du compte révoqué n'est pas réservée.
    expect(await claim((await db.post("a1")).id)).toEqual([]);
  });

  it("révocation demandée avec des effets en attente : nouveaux effets bloqués, clé CONSERVÉE pour annuler, révocation définitive seulement quand il ne reste rien", async () => {
    const seed = await twoAccounts();
    await approvedOnBoth(seed);
    await sync(snapshot(A, [{ id: "ch-a", org: "colibri" }], [{ id: "a1", channelId: "ch-a" }, { id: "a2", channelId: "ch-a", status: "scheduled" }]));
    const requested = await revoke(seed.admin, "admin_request_provider_revocation", A);
    expect(requested).toMatchObject({ revoked: false, revoking: true, unresolved: { scheduled: 1 } });
    expect(await status(A)).toBe("revoking");
    // La clé est toujours là, et le serveur reçoit la connexion marquée « revoking » (annuler et lire seulement).
    expect((await run()).find((c) => c.id === A)).toMatchObject({ status: "revoking", ciphertext: `v1.${A.slice(0, 8)}.t.c` });
    expect(await claim()).toEqual(["b1"]);
    // La révocation normale reste refusée tant qu'un effet n'est pas rapproché.
    expect(await revoke(seed.admin, "admin_revoke_provider_connection", A)).toMatchObject({ revoked: false, revoking: true });
    expect(await status(A)).toBe("revoking");
    // Le fournisseur constate la publication repassée en brouillon : plus rien en attente, la révocation aboutit.
    await sync(snapshot(A, [{ id: "ch-a", org: "colibri" }], [{ id: "a1", channelId: "ch-a" }, { id: "a2", channelId: "ch-a", status: "draft" }]));
    expect(await revoke(seed.admin, "admin_request_provider_revocation", A)).toMatchObject({ revoked: true });
    expect(await db.sql("select 1 from private.provider_credentials where connection_id = $1", [A])).toEqual([]);
    expect(await events(A)).toEqual(["created", "revoke_requested", "revoke_refused", "revoked"]);
    expect(await status(B)).toBe("active");
  });

  it("une demande de révocation s'annule (la connexion redevient active) ; une révocation définitive, jamais", async () => {
    const seed = await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a", org: "colibri" }], [{ id: "a2", channelId: "ch-a", status: "scheduled" }]));
    await revoke(seed.admin, "admin_request_provider_revocation", A);
    await expect(db.as(seed.ines, "select public.admin_cancel_provider_revocation($1)", [A])).rejects.toThrow(/forbidden/);
    await db.as(seed.admin, "select public.admin_cancel_provider_revocation($1)", [A]);
    expect(await status(A)).toBe("active");
    expect(await revoke(seed.admin, "admin_revoke_provider_connection", A, true)).toMatchObject({ revoked: true, forced: true });
    await expect(db.as(seed.admin, "select public.admin_cancel_provider_revocation($1)", [A])).rejects.toThrow(/invalid_connection/);
    await expect(db.sql("update public.provider_connections set status = 'active', revoked_at = null where id = $1", [A])).rejects.toThrow(/provider_connection_revoked/);
    // La décision forcée dit explicitement ce qu'elle laisse derrière elle.
    const [{ detail }] = await db.sql<{ detail: string }>("select detail from public.provider_connection_events where connection_id = $1 and type = 'revoked'", [A]);
    expect(detail).toMatch(/FORCÉE.*à traiter à la main/);
  });

  it("un envoi Studio n'est pas réservé sur une connexion révoquée ou en cours de révocation", async () => {
    const seed = await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a", org: "colibri" }], [{ id: "a2", channelId: "ch-a", status: "scheduled" }]));
    await sync(snapshot(B, [{ id: "ch-b", org: "nordwind" }], []));
    const draft = async (org: string, channel: string) => {
      const [{ id }] = await db.sql<{ id: string }>("select id from public.channels where buffer_channel_id = $1", [channel]);
      const [{ r }] = await db.as<{ r: { id: string } }>(seed.admin, "select public.studio_save_draft(null, null, $1::jsonb) as r", [
        JSON.stringify({ organizationId: org, title: "Contenu", dueAt: FUTURE, variants: [{ channelId: id, text: "Texte" }] }),
      ]);
      return r.id;
    };
    const draftA = await draft(seed.colibri, "ch-a");
    const draftB = await draft(seed.nordwind, "ch-b");
    await revoke(seed.admin, "admin_request_provider_revocation", A);
    expect(await status(A)).toBe("revoking");
    expect(await db.as(seed.admin, "select * from public.studio_claim_push($1, false)", [draftA])).toEqual([]);
    expect((await db.sql<{ push_state: string }>("select push_state from public.studio_variants where draft_id = $1", [draftA]))[0].push_state).toBe("idle");
    expect((await db.as(seed.admin, "select * from public.studio_claim_push($1, false)", [draftB])).length).toBe(1);
  });

  it("l'état durable est lisible par tout worker : révocation et pause décidées ailleurs, sans aucun secret", async () => {
    const seed = await twoAccounts();
    await expect(db.automation("provider_connection_states", { p_mode: "real" }, "mauvais-secret")).rejects.toThrow();
    await db.automation("record_provider_connection_state", { p_connection_id: A, p_ok: false, p_error: "429", p_pause_seconds: 172800, p_pause_reason: "Quota" });
    await revoke(seed.admin, "admin_request_provider_revocation", B);
    const [{ provider_connection_states: states }] = await db.automation<{ provider_connection_states: Record<string, { status: string; pausedUntil: string | null }> }>("provider_connection_states", { p_mode: "real" });
    expect(states[B]).toMatchObject({ status: "revoked", pausedUntil: null });
    expect(states[A].status).toBe("active");
    expect(Date.parse(states[A].pausedUntil!) - Date.now()).toBeGreaterThan(172_000_000);
    expect(JSON.stringify(states)).not.toMatch(/v1\.|ciphertext|fingerprint/);
    // Enregistrer un état sur une connexion révoquée ne fait rien et le dit.
    const [{ record_provider_connection_state: written }] = await db.automation<{ record_provider_connection_state: boolean }>("record_provider_connection_state", { p_connection_id: B, p_ok: true });
    expect(written).toBe(false);
  });
});

describe("P1-03 — une publication garde son compte d'origine", () => {
  it("le même identifiant annoncé sur un canal d'un autre compte ne modifie RIEN et ne révèle rien au client d'origine", async () => {
    const seed = await twoAccounts();
    await approvedOnBoth(seed);
    const before = await db.post("a1");
    const versionsBefore = await db.sql("select * from public.post_versions where post_id = $1 order by version", [before.id]);
    const eventsBefore = await db.sql("select type, version from public.post_events where post_id = $1 order by id", [before.id]);

    for (const state of ["draft", "scheduled", "sent", "error"]) {
      const result = await sync(snapshot(B, [{ id: "ch-b", org: "nordwind" }], [{ id: "b1", channelId: "ch-b" }, { id: "a1", channelId: "ch-b", status: state, text: "CONFIDENTIEL-B-COLLISION" }]));
      expect(result.conflicts).toBe(1);
    }
    const after = await db.post("a1");
    expect(after).toEqual(before);
    expect(await db.sql("select * from public.post_versions where post_id = $1 order by version", [before.id])).toEqual(versionsBefore);
    expect(await db.sql("select type, version from public.post_events where post_id = $1 order by id", [before.id])).toEqual(eventsBefore);
    // Le client A ne lit le texte de B nulle part ; la publication de A n'est pas considérée comme absente.
    const visible = await db.as(seed.ines, "select text from public.posts");
    const versions = await db.as(seed.ines, "select text from public.post_versions");
    expect(JSON.stringify([visible, versions])).not.toContain("CONFIDENTIEL");
    expect(after.removed_at).toBeNull();
    // La collision est consignée une fois, sans aucun contenu.
    const logged = await db.sql<{ detail: string }>("select detail from public.provider_connection_events where type = 'collision'");
    expect(logged.length).toBe(1);
    expect(logged[0].detail).toMatch(/publication.*a1/);
    expect(logged[0].detail).not.toContain("CONFIDENTIEL");
    // Le compte B reste pleinement utilisable.
    expect(await claim()).toEqual(["a1", "b1"]);
  });

  it("collision dans un même relevé, et publication d'origine déjà retirée : toujours aucune mutation", async () => {
    await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "p", channelId: "ch-a" }]));
    await sync(snapshot(A, [{ id: "ch-a" }], []));
    const removed = await db.post("p");
    expect(removed.removed_at).not.toBeNull();
    const result = await sync({
      mode: "real", complete: true, scopeConnectionIds: [B],
      channels: [{ id: "ch-b", service: "linkedin", name: "ch-b", connectionId: B }],
      posts: [
        { id: "q", channelId: "ch-b", service: "linkedin", status: "draft", text: "B", dueAt: FUTURE, hasReviewTag: true, assets: [], connectionId: B },
        { id: "p", channelId: "ch-b", service: "linkedin", status: "draft", text: "B-COLLISION", dueAt: FUTURE, hasReviewTag: true, assets: [], connectionId: B },
      ],
    });
    expect(result).toMatchObject({ conflicts: 1, created: 1 });
    expect(await db.post("p")).toEqual(removed);
  });
});

describe("P1-05 — un ancien appelant ne vaut que pour le compte historique", () => {
  const legacy = (posts: { id: string; channelId: string }[], complete = true, mode = "real") => sync({
    mode, complete, channels: [],
    posts: posts.map((p) => ({ id: p.id, channelId: p.channelId, service: "linkedin", status: "draft", text: `Texte ${p.id}`, dueAt: FUTURE, hasReviewTag: true, assets: [] })),
  });

  it("relevé complet au format de la V1 (sans périmètre), vide ou non : les publications des comptes des clients ne sont ni retirées ni modifiées", async () => {
    await twoAccounts();
    await sync(snapshot(A, [{ id: "ch-a" }], [{ id: "a1", channelId: "ch-a" }, { id: "a2", channelId: "ch-a", status: "scheduled" }]));
    await sync(snapshot(B, [{ id: "ch-b" }], [{ id: "b1", channelId: "ch-b" }]));
    await db.sync([{ id: "historique-1" }, { id: "historique-2" }]);
    const before = await db.sql("select * from public.posts where buffer_post_id in ('a1', 'a2', 'b1') order by buffer_post_id");

    expect(await legacy([])).toMatchObject({ removed: 2 });
    // Il ne peut pas non plus écrire sur les canaux des comptes des clients : refusé, rien n'est modifié.
    expect(await legacy([{ id: "b1", channelId: "ch-b" }, { id: "a1", channelId: "ch-a" }], false)).toMatchObject({ conflicts: 2, updated: 0 });
    await db.sync([{ id: "historique-1" }], { complete: true });

    const after = await db.sql<Record<string, unknown>>("select * from public.posts where buffer_post_id in ('a1', 'a2', 'b1') order by buffer_post_id");
    const stable = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "synced_at"));
    expect(after.map(stable)).toEqual((before as Record<string, unknown>[]).map(stable));
    expect((await db.post("historique-2")).removed_at).not.toBeNull();
    expect((await db.post("historique-1")).removed_at).toBeNull();
  });

  it("avec un compte historique identifié : l'ancien appelant est borné à lui, et ne peut pas écrire sur le canal d'un autre compte", async () => {
    db = await LocalDb.create("0011");
    const seed = await db.seed();
    await db.sync([{ id: "h1" }, { id: "h2" }]);
    await db.migrate("0012_connexions_fournisseur.sql");
    await db.migrate("0013_connexions_cycle_de_vie.sql");
    const [{ id: historical }] = await db.sql<{ id: string }>("select id from public.provider_connections where mode = 'real' and is_default");
    await create(seed.admin, B, { org: seed.nordwind });
    await sync(snapshot(B, [{ id: "ch-b" }], [{ id: "b1", channelId: "ch-b" }, { id: "b2", channelId: "ch-b", status: "scheduled" }]));

    // Relevé complet de la V1 : seul le compte historique est concerné.
    expect(await db.sync([{ id: "h1" }], { complete: true })).toMatchObject({ removed: 1 });
    expect((await db.post("h2")).removed_at).not.toBeNull();
    expect((await db.post("b1")).removed_at).toBeNull();
    expect((await db.post("b2")).removed_at).toBeNull();
    // L'ancien appelant annonce une publication sur le canal du compte B : refusée (il ne parle que pour l'historique).
    const forged = await legacy([{ id: "b1", channelId: "ch-b" }, { id: "intrus", channelId: "ch-b" }], false);
    expect(forged.conflicts).toBe(2);
    expect(await db.post("intrus")).toBeUndefined();
    // Un nouveau canal vu par l'ancien appelant appartient au compte historique, pas à un autre.
    await db.sync([{ id: "h3", channelId: "canal-libre" }]);
    expect((await db.sql<{ provider_connection_id: string }>("select provider_connection_id from public.channels where buffer_channel_id = 'canal-libre'"))[0].provider_connection_id).toBe(historical);

    // Compte historique révoqué (inactif) : l'ancien appelant ne retire plus rien du tout.
    await db.as(seed.admin, "select public.admin_revoke_provider_connection($1, true)", [historical]);
    expect(await db.sync([], { complete: true })).toMatchObject({ removed: 0 });
    expect((await db.post("h1")).removed_at).toBeNull();
    expect((await db.post("b1")).removed_at).toBeNull();
  });
});

describe("quota, détail et droits", () => {
  it("espacement des lectures planifiées : propre au compte, jamais raccourci, plafonné", async () => {
    await twoAccounts();
    const backoff = (seconds: number) => db.automation("record_provider_connection_backoff", { p_connection_id: A, p_seconds: seconds, p_reason: "Quota presque épuisé" });
    await backoff(3600);
    await backoff(60);
    await backoff(0);
    let rows = await run();
    expect(Date.parse(rows.find((c) => c.id === A)!.readBackoffUntil as string) - Date.now()).toBeGreaterThan(3_000_000);
    expect(rows.find((c) => c.id === B)!.readBackoffUntil).toBeNull();
    await backoff(400 * 86400);
    rows = await run();
    expect(Date.parse(rows.find((c) => c.id === A)!.readBackoffUntil as string) - Date.now()).toBeLessThan(32 * 86400_000);
    // L'espacement des lectures n'est PAS une pause : écritures et annulations du compte restent possibles.
    expect(rows.find((c) => c.id === A)!.pausedUntil).toBeNull();
    await expect(db.automation("record_provider_connection_backoff", { p_connection_id: A, p_seconds: 10 }, "mauvais-secret")).rejects.toThrow();
  });

  it("détail d'une connexion : ses réseaux, ses programmations en attente et ses envois non résolus, réservé à l'administrateur", async () => {
    const seed = await twoAccounts();
    await approvedOnBoth(seed);
    await sync(snapshot(A, [{ id: "ch-a", org: "colibri" }], [{ id: "a1", channelId: "ch-a" }, { id: "a2", channelId: "ch-a", status: "scheduled" }]));
    await claim((await db.post("a1")).id);
    const [{ r: detail }] = await db.as<{ r: { channels: { name: string }[]; scheduled: { bufferPostId: string; scheduleState: string }[]; uncertain: unknown[] } }>(
      seed.admin, "select public.admin_provider_connection_detail($1) as r", [A]);
    expect(detail.channels.map((c) => c.name)).toEqual(["ch-a"]);
    expect(detail.scheduled.map((p) => [p.bufferPostId, p.scheduleState]).sort()).toEqual([["a1", "claimed"], ["a2", "idle"]]);
    expect(detail.uncertain).toEqual([]);
    // Rien du compte de l'autre client (comparaison sur l'identifiant exact : un UUID peut contenir « b1 »).
    expect(detail.scheduled.some((p) => p.bufferPostId === "b1")).toBe(false);
    for (const actor of [seed.ines, seed.sofia, "anon"] as Actor[]) {
      await expect(db.as(actor, "select public.admin_provider_connection_detail($1)", [A])).rejects.toThrow();
    }
    const overview = await db.as<Record<string, unknown>>(seed.admin, "select * from public.admin_provider_connections()");
    expect(overview.find((r) => r.id === A)).toMatchObject({ external_account_label: "Compte constaté", external_account_id: "acct-11111111", key_version: 1, unresolved: { scheduled: 1, pending: 1, uncertain: 0 } });
    expect(JSON.stringify(overview)).not.toMatch(/v1\.|fingerprint/);
  });

  it("aucune fonction interne n'est appelable par un client ou un visiteur ; l'empreinte des clés reste dans le schéma privé", async () => {
    const seed = await twoAccounts();
    for (const actor of [seed.ines, "anon"] as Actor[]) {
      await expect(db.as(actor, "select private.connection_emittable($1)", [A])).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "select private.require_admin_actor($1)", [seed.admin.userId])).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "select private.log_connection_collision($1, 'x', 'y')", [A])).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "select fingerprint from private.provider_credentials")).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "select public.admin_request_provider_revocation($1)", [A])).rejects.toThrow();
    }
    await expect(db.as(seed.admin, "select fingerprint from private.provider_credentials")).rejects.toThrow(/permission denied/);
  });
});

describe("migration 0013", () => {
  it("s'applique sur une base au niveau 0012 déjà utilisée, sans rien perdre, et se rejoue", async () => {
    db = await LocalDb.create("0012");
    const seed = await db.seed();
    // Données créées par la version 4e132cb : clé enregistrée par une session, jamais vérifiée.
    await db.as(seed.admin, "select public.admin_create_provider_connection($1, 'real', 'Ancienne', $2, 'stored', 'v1.ancienne.t.c', 1, '1234', null)", [A, seed.colibri]);
    await sync(snapshot(A, [{ id: "ch-a", org: "colibri" }], [{ id: "a1", channelId: "ch-a" }]));
    const before = await db.sql("select * from public.posts order by buffer_post_id");
    await db.migrate("0013_connexions_cycle_de_vie.sql");
    await db.migrate("0013_connexions_cycle_de_vie.sql");
    expect(await db.sql("select * from public.posts order by buffer_post_id")).toEqual(before);
    // La clé d'avant est conservée, mais signalée non vérifiée : elle ne servira qu'après vérification par le serveur.
    expect((await run())[0]).toMatchObject({ id: A, ciphertext: "v1.ancienne.t.c", verified: false, status: "active" });
    const [{ schema_status: schema }] = await db.automation<{ schema_status: { ready: boolean; checks: Record<string, boolean> } }>("schema_status", {});
    expect(schema).toMatchObject({ ready: true, checks: { "0012": true, "0013": true } });
  });

  it("refuse de s'appliquer sans 0012", async () => {
    db = await LocalDb.create("0011");
    await expect(db.migrate("0013_connexions_cycle_de_vie.sql")).rejects.toThrow(/0012 doit être appliquée/);
  });
});
