import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderPost } from "@/server/publishing/provider";
import { ConnectionRouter, type ConnectionRow, type ConnectionState } from "@/server/publishing/router";
import { emptyState, FileProvider, readState, writeState, type FakeBufferState } from "../support/file-provider";

/*
 * La chaîne RÉELLE (programmation après accord, annulation, reprise des réservations abandonnées, synchronisation)
 * branchée sur le routeur de connexions, avec deux faux comptes Buffer persistants. La base est une doublure qui
 * enregistre chaque appel ; les comptes, eux, comptent chaque requête reçue.
 * Invariant : ce qui arrive au compte du client A (panne, quota, révocation) ne bloque ni ne modifie le compte du client B.
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DUE = "2031-03-01T09:00:00.000Z";

type Call = { name: string; params: Record<string, unknown> };
const calls: Call[] = [];
let claimed: unknown[] = [];
let toUnschedule: unknown[] = [];
let orphans: unknown[] = [];
let globalPause: unknown = null;
let rows: ConnectionRow[] = [];
let routes: { posts: Record<string, string>; channels: Record<string, string> };
let connectionStates: { id: string; state: ConnectionState }[] = [];

vi.mock("@/server/env", () => ({ env: { automationSecret: "secret-de-test", bufferMode: "mock", profile: "standard" } }));
vi.mock("@/server/supabase/clients", () => ({
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      if (name === "begin_sync_run") return { data: { acquired: true, token: "s1" }, error: null };
      if (name === "renew_sync_run" || name === "renew_urgent_run") return { data: true, error: null };
      if (name === "begin_urgent_run") return { data: { acquired: true, token: "u1" }, error: null };
      if (name === "urgent_work_summary") return { data: { pending_unschedule: toUnschedule.length, orphan_claims: orphans.length }, error: null };
      if (name.startsWith("claim_posts_for_scheduling")) return { data: claimed, error: null };
      if (name === "list_posts_to_unschedule_in_mode") return { data: toUnschedule, error: null };
      if (name === "list_orphan_claims_in_mode") return { data: orphans, error: null };
      if (name === "get_sync_pause") return { data: globalPause, error: null };
      if (name === "complete_scheduling") return { data: "scheduled", error: null };
      if (name === "sync_buffer_posts") return { data: { fetched: 0, created: 0, updated: 0, invalidated: 0, removed: 0, conflicts: 0 }, error: null };
      return { data: null, error: null };
    },
  }),
}));

let dir: string;
let fileA: string;
let fileB: string;
let providerA: FileProvider;
let providerB: FileProvider;

const makeRouter = () =>
  new ConnectionRouter({
    mode: "mock",
    loadConnections: async () => rows,
    loadRoutes: async (postIds, channelIds) => ({
      posts: Object.fromEntries(postIds.filter((id) => routes.posts[id]).map((id) => [id, routes.posts[id]])),
      channels: Object.fromEntries(channelIds.filter((id) => routes.channels[id]).map((id) => [id, routes.channels[id]])),
    }),
    recordState: async (id, state) => {
      connectionStates.push({ id, state });
    },
    build: (connection) => (connection.id === A ? providerA : providerB),
  });
vi.mock("@/server/publishing", () => ({ getProvider: () => makeRouter() }));
vi.mock("@/server/notifications", () => ({ dispatchNotifications: vi.fn(async () => ({})) }));

const { scheduleApprovedPosts, runSync } = await import("@/server/sync");
const { unscheduleInvalidatedPosts, reconcileOrphanClaims } = await import("@/server/compensation");

const post = (id: string, channelId: string, status: ProviderPost["status"] = "draft"): ProviderPost => ({
  id, channelId, service: "linkedin", status, text: "Texte validé", dueAt: DUE, sentAt: null, updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [],
});
const claim = (id: string, bufferId: string) => ({ id, buffer_post_id: bufferId, text: "Texte validé", assets: [], due_at: DUE, service: "linkedin", token: `jeton-${id}` });
const row = (id: string, label: string): ConnectionRow => ({ id, label, organizationId: null, credentialSource: "none", ciphertext: null, keyVersion: null, accountKey: label.toLowerCase(), isDefault: false, pausedUntil: null, pauseReason: null });
const patch = (file: string, change: (state: FakeBufferState) => void) => {
  const state = readState(file);
  change(state);
  writeState(file, state);
};
const of = (name: string) => calls.filter((call) => call.name === name).map((call) => call.params);
const total = (file: string) => Object.values(readState(file).calls).reduce((sum, value) => sum + value, 0);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cadence-multi-"));
  fileA = join(dir, "a.json");
  fileB = join(dir, "b.json");
  providerA = new FileProvider(fileA, "mock-a");
  providerB = new FileProvider(fileB, "mock-b");
  writeState(fileA, { ...emptyState(), channels: [{ id: "ch-a", service: "linkedin", name: "A", displayName: "A", avatar: null, isDisconnected: false }], posts: { "a1": post("a1", "ch-a"), "a2": post("a2", "ch-a") } });
  writeState(fileB, { ...emptyState(), channels: [{ id: "ch-b", service: "linkedin", name: "B", displayName: "B", avatar: null, isDisconnected: false }], posts: { "b1": post("b1", "ch-b"), "b2": post("b2", "ch-b") } });
  rows = [row(A, "Colibri"), row(B, "Nordwind")];
  routes = { posts: { a1: A, a2: A, b1: B, b2: B }, channels: { "ch-a": A, "ch-b": B } };
  calls.length = 0;
  claimed = [];
  toUnschedule = [];
  orphans = [];
  globalPause = null;
  connectionStates = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("programmation après accord, deux comptes", () => {
  it("chaque publication est programmée dans SON compte, jamais dans l'autre", async () => {
    claimed = [claim("p-a1", "a1"), claim("p-b1", "b1")];
    const outcome = await scheduleApprovedPosts();
    expect(outcome).toMatchObject({ scheduled: 2, failures: 0 });
    expect(readState(fileA).posts.a1.status).toBe("scheduled");
    expect(readState(fileB).posts.b1.status).toBe("scheduled");
    expect(readState(fileA).calls).toEqual({ getPost: 1, schedulePost: 1 });
    expect(readState(fileB).calls).toEqual({ getPost: 1, schedulePost: 1 });
    expect(readState(fileA).posts.b1).toBeUndefined();
  });

  it("compte A injoignable : ses publications échouent, celles de B sont programmées, aucune pause globale", async () => {
    patch(fileA, (state) => { state.faults.push("getPost:fail"); });
    claimed = [claim("p-a1", "a1"), claim("p-a2", "a2"), claim("p-b1", "b1"), claim("p-b2", "b2")];
    const outcome = await scheduleApprovedPosts();
    expect(outcome).toMatchObject({ scheduled: 2, failures: 2, rateLimited: null });
    // A n'a reçu qu'UN appel : après la panne, il n'est plus sollicité pendant ce passage.
    expect(readState(fileA).calls).toEqual({ getPost: 1 });
    expect(readState(fileB).posts.b1.status).toBe("scheduled");
    expect(readState(fileB).posts.b2.status).toBe("scheduled");
    const done = of("complete_scheduling");
    expect(done.filter((params) => params.p_ok === true).map((params) => params.p_post_id)).toEqual(["p-b1", "p-b2"]);
    // La première erreur de A est « incertaine » (la requête est peut-être partie) ; la seconde est un refus sans appel.
    expect(done.find((params) => params.p_post_id === "p-a1")).toMatchObject({ p_ok: false, p_uncertain: true });
    expect(done.find((params) => params.p_post_id === "p-a2")).toMatchObject({ p_ok: false });
    expect(done.find((params) => params.p_post_id === "p-a2")!.p_uncertain).toBeUndefined();
    expect(of("set_sync_backoff")).toEqual([]);
  });

  it("publication dont la connexion est révoquée : refusée sans appel, sans repli sur le compte restant", async () => {
    rows = [row(B, "Nordwind")];
    claimed = [claim("p-a1", "a1"), claim("p-b1", "b1")];
    const outcome = await scheduleApprovedPosts();
    expect(outcome).toMatchObject({ scheduled: 1, failures: 1 });
    expect(total(fileA)).toBe(0);
    expect(readState(fileB).calls).toEqual({ getPost: 1, schedulePost: 1 });
    expect(String(of("complete_scheduling").find((params) => params.p_post_id === "p-a1")!.p_error)).toMatch(/révoquée ou indisponible/);
  });
});

describe("annulation (compensation), deux comptes", () => {
  beforeEach(() => {
    patch(fileA, (state) => { state.posts.a1.status = "scheduled"; state.posts.a2.status = "scheduled"; });
    patch(fileB, (state) => { state.posts.b1.status = "scheduled"; });
    toUnschedule = [claim("p-a1", "a1"), claim("p-a2", "a2"), claim("p-b1", "b1")];
  });

  it("refus de quota (429) du compte A : pause enregistrée sur A seul ; l'annulation de B est confirmée ; pas de pause globale", async () => {
    patch(fileA, (state) => { state.faults.push("unschedulePost:429"); });
    const outcome = await unscheduleInvalidatedPosts(makeRouter());
    expect(outcome).toMatchObject({ done: 1, failures: 2, blocked: null, rateLimited: null });
    expect(readState(fileB).posts.b1.status).toBe("draft");
    // A : une lecture et une tentative ; la seconde publication de A n'a déclenché AUCUN appel (pause du compte).
    expect(readState(fileA).calls).toEqual({ getPost: 1, unschedulePost: 1 });
    expect(connectionStates).toEqual([{ id: A, state: expect.objectContaining({ ok: false, pauseSeconds: 172_800 }) }]);
    expect(of("set_sync_backoff")).toEqual([]);
    const done = of("complete_unscheduling");
    expect(done.filter((params) => params.p_ok === true).map((params) => params.p_post_id)).toEqual(["p-b1"]);
    // Rien n'est annoncé annulé pour A : ses deux publications restent « à confirmer ».
    expect(done.filter((params) => params.p_ok === false).map((params) => params.p_post_id)).toEqual(["p-a1", "p-a2"]);
    expect(readState(fileA).posts.a1.status).toBe("scheduled");
  });

  it("un refus de quota GLOBAL en cours reste respecté par tous les comptes (aucune requête)", async () => {
    globalPause = { until: "2031-01-01T00:00:00Z", reason: "Quota", hard: true };
    const outcome = await unscheduleInvalidatedPosts(makeRouter());
    expect(outcome).toMatchObject({ done: 0, failures: 3, deferred: 3 });
    expect(total(fileA) + total(fileB)).toBe(0);
  });
});

describe("réservations abandonnées (reprise après crash), deux comptes", () => {
  it("compte A en panne : la réservation de B est rapprochée ; celle de A reste intacte (rien n'est inventé)", async () => {
    patch(fileA, (state) => { state.faults.push("getPost:fail"); });
    patch(fileB, (state) => { state.posts.b1.status = "scheduled"; });
    orphans = [{ ...claim("p-a1", "a1"), claimed_at: "2030-01-01T00:00:00Z" }, { ...claim("p-b1", "b1"), claimed_at: "2030-01-01T00:00:00Z" }];
    const outcome = await reconcileOrphanClaims(makeRouter());
    expect(outcome).toMatchObject({ reconciled: 1, confirmed: 1, failures: 1, rateLimited: null });
    expect(of("complete_scheduling")).toEqual([expect.objectContaining({ p_post_id: "p-b1", p_ok: true, p_token: "jeton-p-b1" })]);
  });
});

describe("synchronisation, deux comptes", () => {
  it("compte A en panne : le relevé de B est enregistré avec B pour seul périmètre de retrait, et l'anomalie de A est signalée", async () => {
    patch(fileA, (state) => { state.snapshotFails = true; });
    const result = await runSync("test");
    const [payload] = of("sync_buffer_posts").map((params) => params.p_payload as Record<string, unknown>);
    expect(payload.scopeConnectionIds).toEqual([B]);
    expect(payload.complete).toBe(true);
    expect((payload.posts as ProviderPost[]).map((item) => [item.id, item.connectionId])).toEqual([["b1", B], ["b2", B]]);
    expect((payload.channels as { id: string; connectionId: string }[]).map((item) => [item.id, item.connectionId])).toEqual([["ch-b", B]]);
    expect(result.anomalies?.join(" ")).toMatch(/Compte « Colibri » non lu/);
    expect(result.ok).toBe(true);
  });

  it("les deux comptes lus : périmètre complet, chaque publication porte son compte d'origine", async () => {
    await runSync("test");
    const [payload] = of("sync_buffer_posts").map((params) => params.p_payload as Record<string, unknown>);
    expect(payload.scopeConnectionIds).toEqual([A, B]);
    expect((payload.posts as ProviderPost[]).every((item) => item.connectionId === (item.id.startsWith("a") ? A : B))).toBe(true);
  });

  it("aucun compte actif : rien n'est déclaré retiré et l'anomalie est visible", async () => {
    rows = [];
    const result = await runSync("test");
    const [payload] = of("sync_buffer_posts").map((params) => params.p_payload as Record<string, unknown>);
    expect(payload).toMatchObject({ complete: false, scopeConnectionIds: [], posts: [] });
    expect(result.anomalies?.join(" ")).toMatch(/Aucune connexion fournisseur active/);
  });
});
