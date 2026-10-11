import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptCredential } from "@/server/credentials";
import type { ProviderPost } from "@/server/publishing/provider";
import { ConnectionRouter, type ConnectionRow, type DurableConnectionState } from "@/server/publishing/router";
import { configureIsolatedTests, loadLocalEnv, requireEnv } from "../support/env";
import { emptyState, FileProvider, readState, writeState } from "../support/file-provider";

/*
 * Multi-comptes sur PostgreSQL NATIF (pile isolée de scripts/test-stack.mjs) : HTTP/PostgREST réel, vrais JWT
 * (administrateur, client A, client B, anonyme), vrais services `studio`, `sync`, `urgent` et vrai routeur de
 * connexions. Seuls les fournisseurs sont remplacés, par deux faux comptes PERSISTANTS et distincts (un fichier
 * d'état chacun, qui compte chaque appel). Aucun appel à Buffer, aucun e-mail, aucune base d'application.
 *
 * Origine : les contre-tests N01 à N18 du contrôle indépendant du 10 octobre 2026 (AUDIT_CODEX_MULTITENANT_FINAL.md),
 * repris ici avec leurs assertions métier. Adaptations du PILOTE (jamais des assertions), toutes commentées sur place :
 *   - le routeur de test reçoit `loadStates` (état durable relu avant chaque opération), comme le routeur réel ;
 *   - N14 : une connexion réelle ne se crée plus par une session (refus `server_only`, devenu le comportement voulu) ;
 *     le pilote la crée par la fonction du serveur, puis l'assertion d'origine (« le remplacement par la session est
 *     refusé ») est conservée et complétée.
 * N19 et suivants sont des variantes ajoutées (ordre inverse des transactions, SIGKILL, révocation demandée…).
 */

loadLocalEnv();
configureIsolatedTests();

const URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const SECRET = requireEnv("AUTOMATION_SECRET");
const DB = requireEnv("TEST_DB_CONTAINER");
const DUE = "2031-05-12T09:00:00.000Z";

let admin: SupabaseClient, a: SupabaseClient, b: SupabaseClient, automation: SupabaseClient;
let adminId: string;
let orgA: string, orgB: string, A: string, B: string, chA: string, chB: string, fileA: string, fileB: string;
let providerA: FileProvider, providerB: FileProvider;
let sequence = 0;

const client = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket } });
/** SQL en tant que propriétaire, dans le conteneur de CETTE pile uniquement. */
const owner = (sql: string) =>
  execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
/** Session psql laissée ouverte (transaction concurrente). `ready` se résout quand `marker` apparaît sur sa sortie. */
function transaction(sql: string, marker: string) {
  const child = spawn("docker", ["exec", "-i", DB, "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise<void>((resolveReady, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) resolveReady();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error("transaction de test en échec"));
    });
  });
  child.stdin.end(sql);
  const done = () => (child.exitCode === null ? new Promise<void>((finished) => child.once("exit", () => finished())) : Promise.resolve());
  return { ready, done, output: () => output };
}
async function rpc(c: SupabaseClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await c.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.code}: ${error.message}`);
  return data;
}
const auto = (name: string, args: Record<string, unknown> = {}) => rpc(automation, name, { p_secret: SECRET, ...args });

/** Le routeur réel, branché sur les vraies fonctions SQL ; seuls les deux fournisseurs sont des faux persistants. */
const router = (scheduled = false) => new ConnectionRouter({
  mode: "mock",
  loadConnections: async () => (await auto("provider_connections_for_run", { p_mode: "mock" }) as ConnectionRow[]).filter((x) => x.id === A || x.id === B),
  loadRoutes: async (posts, channels) => auto("provider_routes", { p_mode: "mock", p_post_ids: posts, p_channel_ids: channels }),
  recordState: async (id, state) => (await auto("record_provider_connection_state", { p_connection_id: id, p_ok: state.ok, p_error: state.error ?? null, p_rate_limit: state.rateLimit ?? null, p_pause_seconds: state.pauseSeconds ?? 0, p_pause_reason: state.pauseReason ?? null, p_synced: state.synced ?? false })) !== false,
  // Adaptation du pilote : état durable relu avant chaque opération, exactement comme src/server/publishing/index.ts.
  loadStates: async () => (await auto("provider_connection_states", { p_mode: "mock" })) as Record<string, DurableConnectionState>,
  recordReadBackoff: async (id, seconds, reason) => { await auto("record_provider_connection_backoff", { p_connection_id: id, p_seconds: seconds, p_reason: reason }); },
  respectReadBackoff: scheduled,
  build: (row) => (row.id === A ? providerA : providerB),
});
vi.mock("@/server/supabase/clients", () => ({ createSessionClient: async () => admin, getAutomationClient: () => automation }));
vi.mock("@/server/publishing", () => ({ getProvider: (options: { scheduled?: boolean } = {}) => router(options.scheduled === true), emissionProblem: async () => null }));
vi.mock("@/server/notifications", () => ({ dispatchNotifications: async () => ({}) }));
const { pushDraftToBuffer, reconcileDraftPush } = await import("@/server/studio");
const { scheduleApprovedPosts, runSync } = await import("@/server/sync");
const { runUrgentCycle } = await import("@/server/urgent");

const post = (id: string, channelId: string, status: ProviderPost["status"] = "draft", text = "Texte indépendant") =>
  ({ id, channelId, service: "linkedin", status, text, dueAt: DUE, sentAt: null, updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [] }) as ProviderPost;
const content = (channelId: string) => ({ channelId, service: "linkedin", text: "Test indépendant", dueAt: DUE, assets: [] });
async function snapshot(posts: ProviderPost[] = []) {
  const channels = [
    { id: chA, service: "linkedin", name: "A indépendant", organizationSlug: "maison-colibri", connectionId: A },
    { id: chB, service: "linkedin", name: "B indépendant", organizationSlug: "nordwind-cycles", connectionId: B },
  ];
  return auto("sync_buffer_posts", { p_payload: { mode: "mock", complete: false, scopeConnectionIds: [A, B], channels, posts: posts.map((p) => ({ ...p, connectionId: p.channelId === chA ? A : B })) } });
}
async function draft(which: "A" | "B") {
  const { data } = await admin.from("channels").select("id").eq("buffer_channel_id", which === "A" ? chA : chB).single();
  const result = await rpc(admin, "studio_save_draft", { p_id: null, p_expected_revision: null, p_payload: { organizationId: which === "A" ? orgA : orgB, title: "Audit indépendant", dueAt: DUE, variants: [{ channelId: data!.id, text: "Texte indépendant" }] } });
  return result.id as string;
}
async function row(id: string) {
  const { data, error } = await admin.from("posts").select("*").eq("buffer_post_id", id).single();
  if (error) throw new Error(error.message);
  return data;
}
async function approved(which: "A" | "B") {
  const id = `mock-independent-${sequence}-${which}-${randomUUID()}`;
  const p = post(id, which === "A" ? chA : chB);
  const file = which === "A" ? fileA : fileB;
  const state = readState(file);
  state.posts[id] = p;
  writeState(file, state);
  await snapshot([p]);
  const local = await row(id);
  await rpc(which === "A" ? a : b, "decide_post", { p_post_id: local.id, p_decision: "approved", p_expected_hash: local.content_hash, p_comment: null });
  return { id, localId: local.id as string };
}
/** Une ligne sans sa date de dernière lecture (seul champ qu'une relecture a le droit de changer). */
const stable = (item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "synced_at"));
const status = (id: string) => owner(`select status from public.provider_connections where id='${id}'`);
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");

beforeAll(async () => {
  automation = client();
  [admin, a, b] = await Promise.all(["ADMIN", "INES", "SOFIA"].map(async (who) => {
    const c = client();
    const { error } = await c.auth.signInWithPassword({ email: requireEnv(`DEMO_${who}_EMAIL`), password: requireEnv(`DEMO_${who}_PASSWORD`) });
    if (error) throw new Error("Connexion de test impossible");
    return c;
  }));
  adminId = (await admin.auth.getUser()).data.user!.id;
  const { data } = await admin.from("organizations").select("id,slug");
  orgA = data!.find((x) => x.slug === "maison-colibri")!.id;
  orgB = data!.find((x) => x.slug === "nordwind-cycles")!.id;
  // Clé maître synthétique, propre à ces tests.
  process.env.CADENCE_CREDENTIALS_KEY = Buffer.alloc(32, 71).toString("base64");
});
beforeEach(async () => {
  sequence++;
  owner("update public.sync_state set backoff_until=null,backoff_hard=false,locked_until=null,lock_token=null,urgent_until=null,urgent_token=null where mode='mock'; update public.posts set schedule_state='idle',schedule_token=null where buffer_post_id like 'mock-%';");
  A = randomUUID();
  B = randomUUID();
  chA = `mock-independent-${A}`;
  chB = `mock-independent-${B}`;
  for (const [id, org] of [[A, orgA], [B, orgB]]) {
    await rpc(admin, "admin_create_provider_connection", { p_id: id, p_mode: "mock", p_label: "Audit indépendant", p_organization_id: org, p_credential_source: "none", p_account_key: id.replaceAll("-", "").slice(0, 20) });
  }
  const dir = mkdtempSync(join(tmpdir(), "cadence-independent-multi-"));
  fileA = join(dir, "a.json");
  fileB = join(dir, "b.json");
  providerA = new FileProvider(fileA, `mock-${A}`);
  providerB = new FileProvider(fileB, `mock-${B}`);
  writeState(fileA, { ...emptyState(), channels: [{ id: chA, service: "linkedin", name: "A", displayName: null, avatar: null, isDisconnected: false }] });
  writeState(fileB, { ...emptyState(), channels: [{ id: chB, service: "linkedin", name: "B", displayName: null, avatar: null, isDisconnected: false }] });
  await snapshot();
});

describe("contrôle indépendant multi-comptes — PostgreSQL natif et deux faux comptes persistants (N01–N18)", () => {
  it("N01 — clients A/B et anon ne lisent aucun secret ou connexion ; admin lit seulement les métadonnées", async () => {
    for (const c of [a, b]) {
      expect((await c.from("provider_connections").select("*")).data).toEqual([]);
      expect((await c.from("provider_connection_events").select("*")).data).toEqual([]);
      expect((await c.rpc("admin_provider_connections")).error).not.toBeNull();
      expect((await c.rpc("admin_revoke_provider_connection", { p_connection_id: A, p_force: true })).error).not.toBeNull();
    }
    expect((await automation.from("provider_connections").select("*")).error).not.toBeNull();
    expect(owner("select has_table_privilege('authenticated','private.provider_credentials','SELECT')")).toBe("f");
    expect((await rpc(admin, "admin_provider_connections", {})).some((x: { id: string }) => x.id === A)).toBe(true);
  });

  it("N02 — les nouvelles RPC serveur refusent un mauvais secret", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["provider_connections_for_run", { p_mode: "mock" }], ["provider_routes", { p_mode: "mock", p_channel_ids: [chA] }],
      ["record_provider_connection_state", { p_connection_id: A, p_ok: true }],
      // Ajoutées par 0013 : mêmes exigences.
      ["provider_connection_states", { p_mode: "mock" }], ["record_provider_connection_backoff", { p_connection_id: A, p_seconds: 60 }],
      ["server_record_provider_verification", { p_actor: adminId, p_connection_id: A, p_ok: true, p_external_account_id: "x" }],
    ];
    for (const [name, args] of calls) expect((await automation.rpc(name, { p_secret: "incorrect", ...args })).error).not.toBeNull();
  });

  it("N03 — envois simultanés A/B et deux workers sur A : une seule création par contenu", async () => {
    const da = await draft("A"), db = await draft("B");
    await Promise.all([pushDraftToBuffer(da), pushDraftToBuffer(da), pushDraftToBuffer(db)]);
    expect(providerA.calls("createDraft")).toBe(1);
    expect(providerB.calls("createDraft")).toBe(1);
    expect(Object.values(readState(fileA).posts).every((p) => p.channelId === chA)).toBe(true);
    expect(Object.values(readState(fileB).posts).every((p) => p.channelId === chB)).toBe(true);
  });

  it("N04 — réponse de création A perdue : inconnu durable, reprise sans doublon, B indépendant", async () => {
    const da = await draft("A"), db = await draft("B");
    const state = readState(fileA);
    state.faults.push("createDraft:lose");
    writeState(fileA, state);
    expect(await pushDraftToBuffer(da)).toMatchObject({ unknown: 1 });
    await pushDraftToBuffer(da);
    expect(providerA.calls("createDraft")).toBe(1);
    await pushDraftToBuffer(db);
    expect(providerB.calls("createDraft")).toBe(1);
    await reconcileDraftPush(da);
    await pushDraftToBuffer(da);
    expect(providerA.calls("createDraft")).toBe(1);
    expect(providerB.calls("createDraft")).toBe(1);
  });

  it("N05 — SIGKILL après création A, nouveau processus fournisseur et rapprochement : aucun doublon ni effet A sur B", async () => {
    const da = await draft("A"), db = await draft("B");
    const result = spawnSync(process.execPath, [resolve("tests/support/crash-worker.mjs"), JSON.stringify({ action: "studio-create-then-die", url: URL, anon: ANON, secret: SECRET, email: requireEnv("DEMO_ADMIN_EMAIL"), password: requireEnv("DEMO_ADMIN_PASSWORD"), draftId: da, file: fileA, run: A })], { stdio: "pipe" });
    expect(result.signal).toBe("SIGKILL");
    expect(providerA.calls("createDraft")).toBe(1);
    owner(`update public.studio_variants set push_claimed_at=now()-interval '6 minutes' where draft_id='${da}'`);
    providerA = new FileProvider(fileA, `mock-${A}`);
    await pushDraftToBuffer(db);
    await reconcileDraftPush(da);
    await pushDraftToBuffer(da);
    expect(providerA.calls("createDraft")).toBe(1);
    expect(providerB.calls("createDraft")).toBe(1);
  });

  it("N06 — deux workers de programmation sur deux comptes : une programmation par post", async () => {
    const pa = await approved("A"), pb = await approved("B");
    await Promise.all([scheduleApprovedPosts(pa.localId), scheduleApprovedPosts(pa.localId), scheduleApprovedPosts(pb.localId)]);
    expect(providerA.calls("schedulePost")).toBe(1);
    expect(providerB.calls("schedulePost")).toBe(1);
    expect((await row(pa.id)).schedule_state).toBe("scheduled");
    expect((await row(pb.id)).schedule_state).toBe("scheduled");
  });

  it("N07 — programmation A à réponse perdue, reprise urgente avec B disponible : compte et jeton conservés", async () => {
    const pa = await approved("A"), pb = await approved("B");
    const state = readState(fileA);
    state.faults.push("schedulePost:lose");
    writeState(fileA, state);
    await scheduleApprovedPosts(pa.localId);
    await scheduleApprovedPosts(pb.localId);
    expect((await row(pa.id)).schedule_state).toBe("claimed");
    owner(`update public.posts set schedule_claimed_at=now()-interval '3 minutes' where id='${pa.localId}'`);
    await runUrgentCycle(router());
    expect((await row(pa.id)).schedule_state).toBe("scheduled");
    expect(providerA.calls("schedulePost")).toBe(1);
    expect(providerB.calls("schedulePost")).toBe(1);
  });

  it("N08 — quota A 48 heures : annulation urgente B confirmée, pause persistante limitée à A", async () => {
    const pa = await approved("A"), pb = await approved("B");
    await scheduleApprovedPosts(pa.localId);
    await scheduleApprovedPosts(pb.localId);
    owner(`update public.posts set schedule_state='unschedule_pending' where id in ('${pa.localId}','${pb.localId}')`);
    const state = readState(fileA);
    state.faults.push("unschedulePost:429");
    writeState(fileA, state);
    await runUrgentCycle(router());
    expect((await row(pa.id)).schedule_state).toBe("unschedule_pending");
    expect(readState(fileB).posts[pb.id].status).toBe("draft");
    const rows = await auto("provider_connections_for_run", { p_mode: "mock" });
    expect(Date.parse(rows.find((x: ConnectionRow) => x.id === A).pausedUntil) - Date.now()).toBeGreaterThan(172000000);
    expect(rows.find((x: ConnectionRow) => x.id === B).pausedUntil).toBeNull();
  });

  it("N09 — invariant : une annulation A bloquée ne suspend pas la programmation approuvée de B", async () => {
    const pa = await approved("A");
    await scheduleApprovedPosts(pa.localId);
    const pb = await approved("B");
    owner(`update public.posts set schedule_state='unschedule_pending' where id='${pa.localId}'`);
    await auto("record_provider_connection_state", { p_connection_id: A, p_ok: false, p_pause_seconds: 172800, p_pause_reason: "Quota" });
    await runSync("independent-starvation");
    expect(readState(fileB).posts[pb.id].status).toBe("scheduled");
    // Complément : A n'a reçu aucune requête d'annulation pendant sa pause, et reste « à confirmer ».
    expect(providerA.calls("unschedulePost")).toBe(0);
    expect((await row(pa.id)).schedule_state).toBe("unschedule_pending");
  });

  it("N10 — invariant : routeur déjà chargé, révocation normale confirmée, aucune nouvelle écriture sur A", async () => {
    const r = router();
    await r.fetchSnapshot();
    expect(await rpc(admin, "admin_revoke_provider_connection", { p_connection_id: A, p_force: false })).toMatchObject({ revoked: true });
    const result = await r.createDraft(content(chA)).then(() => "WRITE_ACCEPTED", () => "REFUSED");
    expect(result).toBe("REFUSED");
    expect(providerA.calls("createDraft")).toBe(0);
  });

  it("N11 — invariant : pause enregistrée après chargement du routeur, aucune nouvelle requête A", async () => {
    const r = router();
    await r.fetchSnapshot();
    await auto("record_provider_connection_state", { p_connection_id: A, p_ok: false, p_pause_seconds: 172800, p_pause_reason: "Quota" });
    const result = await r.createDraft(content(chA)).then(() => "WRITE_ACCEPTED", () => "REFUSED");
    expect(result).toBe("REFUSED");
    expect(providerA.calls("createDraft")).toBe(0);
  });

  it("N12 — invariant : collision de post entre canaux de deux comptes, aucune mutation de la publication A", async () => {
    const id = `mock-collision-${randomUUID()}`;
    await snapshot([post(id, chA)]);
    const original = await row(id);
    const result = await snapshot([post(id, chB, "sent", "CONFIDENTIEL-B-COLLISION")]);
    expect(result.conflicts).toBeGreaterThan(0);
    expect((await row(id)).channel_id).toBe(original.channel_id);
    // Complément : aucun champ métier de A n'a changé (hors date de lecture).
    expect(stable(await row(id))).toEqual(stable(original));
  });

  it("N13 — invariant sécurité : une collision ne révèle jamais le contenu B au client A via posts ou versions", async () => {
    const id = `mock-collision-${randomUUID()}`;
    await snapshot([post(id, chA)]);
    await snapshot([post(id, chB, "sent", "CONFIDENTIEL-B-COLLISION")]);
    const local = await row(id);
    const visible = await a.from("posts").select("text").eq("id", local.id);
    const versions = await a.from("post_versions").select("text").eq("post_id", local.id);
    expect(JSON.stringify([visible.data, versions.data])).not.toContain("CONFIDENTIEL-B-COLLISION");
    // Complément : nulle part ailleurs non plus pour le client A (toutes ses publications, versions et événements).
    const everything = await Promise.all([a.from("posts").select("*"), a.from("post_versions").select("*"), a.from("post_events").select("*"), a.from("comments").select("*")]);
    expect(JSON.stringify(everything.map((item) => item.data))).not.toContain("CONFIDENTIEL");
  });

  it("N14 — invariant : clé remplacée sans identité distante démontrée, le compte ne peut être considéré vérifié", async () => {
    const id = randomUUID();
    const first = encryptCredential(id, "synthetic-key-account-A-0000");
    // Adaptation du pilote : la création d'une connexion réelle par une session est désormais REFUSÉE (le navigateur
    // ne peut plus enregistrer de clé réelle) ; elle passe par la fonction du serveur, avec l'identité constatée.
    expect((await admin.rpc("admin_create_provider_connection", { p_id: id, p_mode: "real", p_label: "A synthétique", p_organization_id: orgA, p_credential_source: "stored", p_ciphertext: first })).error?.message).toMatch(/server_only/);
    await auto("server_create_provider_connection", { p_actor: adminId, p_id: id, p_label: "A synthétique", p_organization_id: orgA, p_ciphertext: first, p_key_version: 1, p_hint: "0000", p_fingerprint: fingerprint(`a-${id}`), p_external_account_id: `acct-a-${id}`, p_external_account_label: "Compte A synthétique" });
    // Assertion d'origine, inchangée : même appel que l'ancienne action serveur, aucune identité fournie → refusé.
    const result = await admin.rpc("admin_set_provider_credential", { p_connection_id: id, p_ciphertext: encryptCredential(id, "synthetic-key-account-B-1111"), p_key_version: 1, p_hint: "1111" });
    expect(result.error).not.toBeNull();
    // Compléments : une identité déclarée par la session est refusée aussi ; par le serveur, une clé d'un autre
    // compte ou d'identité inconnue ne remplace pas la clé en place.
    expect((await admin.rpc("admin_set_provider_credential", { p_connection_id: id, p_ciphertext: encryptCredential(id, "synthetic-key-account-B-1111"), p_key_version: 1, p_hint: "1111", p_external_account_id: `acct-a-${id}` })).error).not.toBeNull();
    const replace = (account: string | null) => automation.rpc("server_set_provider_credential", { p_secret: SECRET, p_actor: adminId, p_connection_id: id, p_ciphertext: encryptCredential(id, "synthetic-key-account-B-1111"), p_key_version: 1, p_hint: "1111", p_fingerprint: fingerprint(`b-${id}`), p_external_account_id: account, p_external_account_label: null });
    expect((await replace(`acct-b-${id}`)).data).toBe("account_mismatch");
    expect((await replace(null)).error?.message).toMatch(/verification_required/);
    expect(owner(`select ciphertext from private.provider_credentials where connection_id='${id}'`)).toBe(first);
    // Un client, même en présentant le secret du serveur, n'est pas un acteur administrateur.
    const clientId = (await a.auth.getUser()).data.user!.id;
    expect((await automation.rpc("server_set_provider_credential", { p_secret: SECRET, p_actor: clientId, p_connection_id: id, p_ciphertext: first, p_key_version: 1, p_hint: "0000", p_fingerprint: fingerprint(`c-${id}`), p_external_account_id: `acct-a-${id}` })).error?.message).toMatch(/forbidden/);
  });

  it("N15 — révocation déjà effectuée : un nouveau routeur refuse A et conserve B", async () => {
    await rpc(admin, "admin_revoke_provider_connection", { p_connection_id: A, p_force: false });
    await expect(router().createDraft(content(chA))).rejects.toThrow(/révoquée|indisponible/);
    expect(providerA.calls("createDraft")).toBe(0);
    await router().createDraft(content(chB));
    expect(providerB.calls("createDraft")).toBe(1);
  });

  it("N16 — compte A tronqué ou en panne : son historique n'est pas retiré par la lecture complète B", async () => {
    const id = `mock-independent-${randomUUID()}`;
    await snapshot([post(id, chA)]);
    const state = readState(fileA);
    state.snapshotComplete = false;
    writeState(fileA, state);
    await runSync("independent-incomplete");
    expect((await row(id)).removed_at).toBeNull();
    state.snapshotFails = true;
    writeState(fileA, state);
    await runSync("independent-failure");
    expect((await row(id)).removed_at).toBeNull();
  });

  it("N17 — invariant : révocation normale et réservation concurrentes ne laissent jamais une programmation sans clé", async () => {
    const pa = await approved("A");
    // La révocation a validé « aucun effet », mais sa transaction n'a pas encore été rendue visible.
    // Le rôle anon de la pile Supabase a un statement_timeout de 3 s : maintenir le verrou 2 s
    // suffit après le signal ready, sans confondre ce délai de sécurité avec une corruption d'état.
    const revoking = transaction(`begin; select set_config('request.jwt.claim.sub','${adminId}',false); set role authenticated; select public.admin_revoke_provider_connection('${A}',false); select pg_sleep(2); commit;`, '"revoked": true');
    await revoking.ready;
    await scheduleApprovedPosts(pa.localId);
    await revoking.done();
    expect(status(A) === "revoked" && readState(fileA).posts[pa.id].status === "scheduled").toBe(false);
    // Compléments : la réservation a attendu la révocation, puis n'a rien réservé ni envoyé.
    expect(status(A)).toBe("revoked");
    expect(providerA.calls("schedulePost")).toBe(0);
    expect((await row(pa.id)).schedule_state).toBe("idle");
  });

  it("N18 — invariant rollback : ancien appel complet sans périmètre ne retire pas le compte B", async () => {
    const id = `mock-independent-rollback-${randomUUID()}`;
    await snapshot([post(id, chB)]);
    // Format réellement produit par la V1 : pas de scopeConnectionIds, pas de connectionId.
    await auto("sync_buffer_posts", { p_payload: { mode: "mock", complete: true, channels: [], posts: [] } });
    expect((await row(id)).removed_at).toBeNull();
  });
});

describe("variantes ajoutées après correction (N19 et suivants)", () => {
  it("N19 — ordre inverse de N17 : la réservation est en cours quand la révocation arrive → la révocation attend, puis est REFUSÉE", async () => {
    const pa = await approved("A");
    // Un worker a réservé la programmation de A et n'a pas encore validé sa transaction.
    const claiming = transaction(`begin; select 'reserve:' || count(*) from public.claim_posts_for_scheduling_in_mode('${SECRET}','mock','${pa.localId}',1); select pg_sleep(3); commit;`, "reserve:1");
    await claiming.ready;
    const started = Date.now();
    const result = await rpc(admin, "admin_revoke_provider_connection", { p_connection_id: A, p_force: false });
    // Elle a attendu la fin de la réservation (verrou partagé), puis a constaté l'opération en cours.
    expect(Date.now() - started).toBeGreaterThan(1500);
    expect(result).toMatchObject({ revoked: false, unresolved: { pending: 1 } });
    await claiming.done();
    expect(status(A)).toBe("active");
    expect((await row(pa.id)).schedule_state).toBe("claimed");
  });

  it("N20 — SIGKILL après l'effet externe sur A (programmée chez le fournisseur, jamais confirmée) : révocation refusée tant que rien n'est rapproché, reprise sur le BON compte", async () => {
    const pa = await approved("A"), pb = await approved("B");
    const result = spawnSync(process.execPath, [resolve("tests/support/crash-worker.mjs"), JSON.stringify({ action: "schedule-then-die", url: URL, anon: ANON, secret: SECRET, postId: pa.localId, bufferPostId: pa.id, file: fileA })], { stdio: "pipe" });
    expect(result.signal).toBe("SIGKILL");
    expect(readState(fileA).posts[pa.id].status).toBe("scheduled");
    expect((await row(pa.id)).schedule_state).toBe("claimed");
    // L'effet est engagé chez le fournisseur : une révocation normale est refusée, la clé reste.
    expect(await rpc(admin, "admin_revoke_provider_connection", { p_connection_id: A, p_force: false })).toMatchObject({ revoked: false });
    expect(status(A)).toBe("active");
    // B n'est pas concerné.
    await scheduleApprovedPosts(pb.localId);
    expect((await row(pb.id)).schedule_state).toBe("scheduled");
    // Reprise urgente (nouveau processus) : la réservation abandonnée est rapprochée par le compte A, sans nouvelle programmation.
    owner(`update public.posts set schedule_claimed_at=now()-interval '3 minutes' where id='${pa.localId}'`);
    providerA = new FileProvider(fileA, `mock-${A}`);
    await runUrgentCycle(router());
    expect((await row(pa.id)).schedule_state).toBe("scheduled");
    expect(providerA.calls("schedulePost")).toBe(1);
    expect(providerB.calls("schedulePost")).toBe(1);
    expect(providerB.calls("getPost")).toBeGreaterThan(0);
    expect(Object.keys(readState(fileB).posts)).not.toContain(pa.id);
  });

  it("N21 — révocation DEMANDÉE avec une publication programmée : plus aucun nouvel effet sur A, mais l'annulation passe encore par SA clé ; puis révocation définitive", async () => {
    const programmed = await approved("A");
    await scheduleApprovedPosts(programmed.localId);
    const waiting = await approved("A");
    const pb = await approved("B");
    const requested = await rpc(admin, "admin_request_provider_revocation", { p_connection_id: A });
    expect(requested).toMatchObject({ revoked: false, revoking: true, unresolved: { scheduled: 1 } });
    expect(status(A)).toBe("revoking");

    // Nouveaux effets : aucun (programmation approuvée en attente, création Studio).
    await scheduleApprovedPosts(waiting.localId);
    await scheduleApprovedPosts(pb.localId);
    expect((await row(waiting.id)).schedule_state).toBe("idle");
    expect(providerA.calls("schedulePost")).toBe(1);
    expect((await row(pb.id)).schedule_state).toBe("scheduled");
    const da = await draft("A");
    await pushDraftToBuffer(da);
    expect(providerA.calls("createDraft")).toBe(0);
    await expect(router().createDraft(content(chA))).rejects.toThrow(/Révocation demandée/);

    // Compensation de l'effet engagé : elle part par le compte A, qui a toujours sa clé.
    owner(`update public.posts set schedule_state='unschedule_pending' where id='${programmed.localId}'`);
    await runUrgentCycle(router());
    expect(readState(fileA).posts[programmed.id].status).toBe("draft");
    expect((await row(programmed.id)).schedule_state).not.toBe("unschedule_pending");
    expect(providerB.calls("unschedulePost")).toBe(0);

    // Plus rien en attente : la révocation devient définitive.
    await runSync("independent-revoking");
    expect(await rpc(admin, "admin_request_provider_revocation", { p_connection_id: A })).toMatchObject({ revoked: true });
    expect(status(A)).toBe("revoked");
    expect(status(B)).toBe("active");
  });

  it("N22 — vrai runSync : compte A injoignable (lecture et relecture en panne), B approuvé → B est programmé, aucune pause ni erreur portée sur B", async () => {
    const pa = await approved("A"), pb = await approved("B");
    const state = readState(fileA);
    state.snapshotFails = true;
    state.faults.push("getPost:fail", "getPost:fail");
    writeState(fileA, state);
    const result = await runSync("independent-outage");
    expect(readState(fileB).posts[pb.id].status).toBe("scheduled");
    expect((await row(pb.id)).schedule_state).toBe("scheduled");
    expect(readState(fileA).posts[pa.id].status).toBe("draft");
    expect(result.anomalies?.some((line) => /non lu/.test(line))).toBe(true);
    const rows = await auto("provider_connections_for_run", { p_mode: "mock" });
    expect(rows.find((x: ConnectionRow) => x.id === B).pausedUntil).toBeNull();
    expect(owner("select coalesce(backoff_until::text,'aucune') from public.sync_state where mode='mock'")).toBe("aucune");
    const overview = await rpc(admin, "admin_provider_connections", {});
    expect(overview.find((x: { id: string }) => x.id === B)).toMatchObject({ last_sync_ok: true, last_error: null });
    expect(overview.find((x: { id: string }) => x.id === A)).toMatchObject({ last_sync_ok: false });
  });

  it("N23 — pause de quota durable : un NOUVEAU routeur (redémarrage) ne sollicite pas A, ni à la main ni par le planificateur ; B est lu", async () => {
    await auto("record_provider_connection_state", { p_connection_id: A, p_ok: false, p_pause_seconds: 172800, p_pause_reason: "Quota" });
    const before = Object.values(readState(fileA).calls).reduce((sum, value) => sum + value, 0);
    await runSync("independent-manual");
    await runSync("independent-planned", { scheduled: true });
    await expect(router().getPost("inconnu")).rejects.toThrow();
    expect(Object.values(readState(fileA).calls).reduce((sum, value) => sum + value, 0)).toBe(before);
    expect(providerB.calls("fetchSnapshot")).toBeGreaterThanOrEqual(2);
    // Une pause plus courte enregistrée ensuite ne raccourcit pas celle-ci.
    await auto("record_provider_connection_state", { p_connection_id: A, p_ok: false, p_pause_seconds: 60, p_pause_reason: "plus court" });
    const rows = await auto("provider_connections_for_run", { p_mode: "mock" });
    expect(Date.parse(rows.find((x: ConnectionRow) => x.id === A).pausedUntil) - Date.now()).toBeGreaterThan(172000000);
  });

  it("N24 — relevé complet et NON vide d'un ancien appelant (format V1) : rien n'est retiré, modifié ni réattribué sur les comptes A et B", async () => {
    const ida = `mock-independent-legacy-a-${randomUUID()}`, idb = `mock-independent-legacy-b-${randomUUID()}`;
    await snapshot([post(ida, chA, "scheduled"), post(idb, chB)]);
    const before = [await row(ida), await row(idb)];
    // L'ancienne application ne connaît que le compte de démonstration ; ici elle annonce en plus des identifiants de A et B.
    const result = await auto("sync_buffer_posts", { p_payload: { mode: "mock", complete: true, channels: [{ id: chA, service: "linkedin", name: "Renommé par l'ancien appelant" }], posts: [{ ...post(idb, chB, "sent", "ÉCRASÉ PAR L'ANCIEN APPELANT") }] } });
    expect(result.conflicts).toBe(2);
    const after = [await row(ida), await row(idb)];
    expect(after.map(stable)).toEqual(before.map(stable));
    const { data: channel } = await admin.from("channels").select("name, provider_connection_id").eq("buffer_channel_id", chA).single();
    expect(channel).toEqual({ name: "A indépendant", provider_connection_id: A });
  });

  it("N25 — connexion créée pendant un passage : le routeur déjà chargé ne l'utilise pas (refus), le passage suivant oui ; jamais de repli sur A ou B", async () => {
    const loaded = router();
    await loaded.fetchSnapshot();
    const C = randomUUID();
    const chC = `mock-independent-${C}`;
    await rpc(admin, "admin_create_provider_connection", { p_id: C, p_mode: "mock", p_label: "Arrivée en cours de passage", p_organization_id: orgB, p_credential_source: "none", p_account_key: C.replaceAll("-", "").slice(0, 20) });
    await auto("sync_buffer_posts", { p_payload: { mode: "mock", complete: false, scopeConnectionIds: [C], channels: [{ id: chC, service: "linkedin", name: "C", connectionId: C }], posts: [] } });
    const before = [providerA.calls("createDraft"), providerB.calls("createDraft")];
    await expect(loaded.createDraft(content(chC))).rejects.toThrow(/révoquée ou indisponible/);
    expect([providerA.calls("createDraft"), providerB.calls("createDraft")]).toEqual(before);
    owner(`update public.provider_connections set status='revoked', revoked_at=now() where id='${C}'`);
  });

  it("N26 — espacement des lectures par compte : quota presque épuisé sur A → le planificateur saute A, lit B, ne retire rien de A ; une lecture manuelle lit A", async () => {
    const id = `mock-independent-backoff-${randomUUID()}`;
    await snapshot([post(id, chA)]);
    await auto("record_provider_connection_backoff", { p_connection_id: A, p_seconds: 3600, p_reason: "Quota presque épuisé" });
    const reads = providerA.calls("fetchSnapshot");
    const planned = await runSync("independent-backoff", { scheduled: true });
    expect(providerA.calls("fetchSnapshot")).toBe(reads);
    expect(providerB.calls("fetchSnapshot")).toBeGreaterThan(0);
    expect((await row(id)).removed_at).toBeNull();
    expect(planned.anomalies?.some((line) => /lectures planifiées espacées/.test(line))).toBe(true);
    await runSync("independent-backoff-manual");
    expect(providerA.calls("fetchSnapshot")).toBe(reads + 1);
  });
});
