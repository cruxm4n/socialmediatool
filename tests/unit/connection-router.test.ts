import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderError, type DraftContent, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";
import { ConnectionRouter, type ConnectionRow, type ConnectionState, type RouterDeps } from "@/server/publishing/router";
import { emptyState, FileProvider, readState, writeState, type FakeBufferState } from "../support/file-provider";

/*
 * Routeur de connexions : deux faux comptes Buffer PERSISTANTS et isolés (un fichier d'état chacun, qui COMPTE chaque
 * appel reçu). Les preuves reposent sur ces compteurs : « le compte B n'a reçu aucun appel », et non sur une doublure
 * qui répondrait ce qu'on attend. La table de routage joue le rôle de la base (canal → connexion, immuable).
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVOKED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DUE = "2031-03-01T09:00:00.000Z";

let dir: string;
let fileA: string;
let fileB: string;
let providerA: FileProvider;
let providerB: FileProvider;
let routes: { posts: Record<string, string>; channels: Record<string, string> };
let states: { id: string; state: ConnectionState }[];
let rows: ConnectionRow[] | null;
let built: string[];
let now: number;

const row = (id: string, label: string, extra: Partial<ConnectionRow> = {}): ConnectionRow => ({
  id, label, organizationId: null, credentialSource: "none", ciphertext: null, keyVersion: null, accountKey: label.toLowerCase(), isDefault: false, pausedUntil: null, pauseReason: null, ...extra,
});
const post = (id: string, channelId: string, extra: Partial<ProviderPost> = {}): ProviderPost => ({
  id, channelId, service: "linkedin", status: "draft", text: `Texte ${id}`, dueAt: DUE, sentAt: null, updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [], ...extra,
});
const content = (channelId: string): DraftContent => ({ channelId, service: "linkedin", text: "Nouveau brouillon", dueAt: DUE, assets: [] });
const seed = (file: string, patch: Partial<FakeBufferState>) => writeState(file, { ...emptyState(), ...patch });
const patch = (file: string, change: (state: FakeBufferState) => void) => {
  const state = readState(file);
  change(state);
  writeState(file, state);
};
const total = (provider: FileProvider) => Object.values(readState(provider === providerA ? fileA : fileB).calls).reduce((sum, value) => sum + value, 0);

function router(overrides: Partial<RouterDeps> = {}): ConnectionRouter {
  return new ConnectionRouter({
    mode: "mock",
    loadConnections: async () => rows,
    loadRoutes: async (postIds, channelIds) => ({
      posts: Object.fromEntries(postIds.filter((id) => routes.posts[id]).map((id) => [id, routes.posts[id]])),
      channels: Object.fromEntries(channelIds.filter((id) => routes.channels[id]).map((id) => [id, routes.channels[id]])),
    }),
    recordState: async (id, state) => {
      states.push({ id, state });
    },
    build: (connection) => {
      built.push(connection.id);
      if (connection.id === A) return providerA;
      if (connection.id === B) return providerB;
      throw new Error("connexion inconnue du test");
    },
    now: () => now,
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cadence-router-"));
  fileA = join(dir, "compte-a.json");
  fileB = join(dir, "compte-b.json");
  providerA = new FileProvider(fileA, "mock-a");
  providerB = new FileProvider(fileB, "mock-b");
  seed(fileA, { channels: [{ id: "ch-a", service: "linkedin", name: "A", displayName: "A", avatar: null, isDisconnected: false }], posts: { "post-a": post("post-a", "ch-a", { status: "scheduled" }) } });
  seed(fileB, { channels: [{ id: "ch-b", service: "instagram", name: "B", displayName: "B", avatar: null, isDisconnected: false }], posts: { "post-b": post("post-b", "ch-b", { status: "scheduled" }) } });
  routes = { posts: { "post-a": A, "post-b": B }, channels: { "ch-a": A, "ch-b": B } };
  rows = [row(A, "Colibri"), row(B, "Nordwind")];
  states = [];
  built = [];
  now = Date.parse("2030-01-01T00:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("chaque opération part avec le compte de SON canal", () => {
  it("création, programmation, annulation, relecture, changement de date et recherche du client A ne touchent que le compte A", async () => {
    const r = router();
    const created = await r.createDraft(content("ch-a"));
    expect(created.connectionId).toBe(A);
    await r.updateDraft(created.id, content("ch-a"));
    const live = (await r.getPost("post-a"))!;
    expect(live.connectionId).toBe(A);
    await r.unschedulePost(live);
    await r.schedulePost(live);
    await r.rescheduleDraft(live, DUE);
    await r.findDraftCandidates({ channelId: "ch-a", text: "x", dueAt: DUE });
    expect(readState(fileA).calls).toMatchObject({ createDraft: 1, updateDraft: 1, getPost: 1, unschedulePost: 1, schedulePost: 1, rescheduleDraft: 1 });
    // Le compte B n'a reçu AUCUN appel, d'aucune sorte.
    expect(total(providerB)).toBe(0);
    // Et réciproquement.
    await r.unschedulePost((await r.getPost("post-b"))!);
    expect(readState(fileB).calls).toMatchObject({ getPost: 1, unschedulePost: 1 });
    expect(readState(fileA).calls.unschedulePost).toBe(1);
  });

  it("le brouillon créé existe dans le compte A seulement", async () => {
    const created = await router().createDraft(content("ch-a"));
    expect(readState(fileA).posts[created.id]).toBeDefined();
    expect(Object.keys(readState(fileB).posts)).toEqual(["post-b"]);
  });
});

describe("aucun repli, aucun compte par défaut", () => {
  it("canal ou publication sans route : refus certain, aucun compte sollicité", async () => {
    const r = router();
    await expect(r.createDraft(content("ch-inconnu"))).rejects.toThrow(/Aucune connexion fournisseur n'est associée/);
    await expect(r.getPost("post-inconnu")).rejects.toThrow(/Aucune connexion fournisseur/);
    await expect(r.findDraftCandidates({ channelId: "ch-inconnu", text: "x", dueAt: DUE })).rejects.toBeInstanceOf(ProviderError);
    expect(total(providerA) + total(providerB)).toBe(0);
  });

  it("connexion révoquée : ses publications ne partent par AUCUN autre compte", async () => {
    routes.channels["ch-r"] = REVOKED;
    routes.posts["post-r"] = REVOKED;
    const r = router();
    const error = await r.getPost("post-r").catch((e: ProviderError) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).connectionId).toBe(REVOKED);
    expect((error as ProviderError).outcome).toBe("failed");
    await expect(r.unschedulePost(post("post-r", "ch-r", { status: "scheduled" }))).rejects.toThrow(/révoquée ou indisponible/);
    expect(total(providerA) + total(providerB)).toBe(0);
  });

  it("secret illisible sur A : A est refusé avec un message clair, B fonctionne, rien n'est construit à la place de A", async () => {
    const r = router({
      build: (connection) => {
        built.push(connection.id);
        if (connection.id === A) throw new Error("Secret de connexion indéchiffrable");
        return providerB;
      },
    });
    await expect(r.createDraft(content("ch-a"))).rejects.toThrow(/Connexion « Colibri » inutilisable : Secret de connexion indéchiffrable/);
    expect((await r.getPost("post-b"))!.id).toBe("post-b");
    expect(total(providerA)).toBe(0);
    expect(built).toEqual([A, B]);
  });

  it("une publication connue sous le compte A n'est jamais modifiée via le canal du compte B", async () => {
    const r = router();
    await expect(r.updateDraft("post-a", content("ch-b"))).rejects.toThrow(/autre compte/);
    await expect(r.schedulePost(post("post-a", "ch-b", { connectionId: A }))).rejects.toThrow(/autre compte/);
    expect(total(providerA) + total(providerB)).toBe(0);
  });

  it("base sans la migration 0012 : mode réel refusé (aucune clé sans connexion), mode simulé servi par l'ancien fournisseur", async () => {
    rows = null;
    await expect(router({ mode: "real" }).fetchSnapshot()).rejects.toThrow(/migration 0012/);
    const legacy = router({ legacy: () => providerA });
    expect((await legacy.fetchSnapshot()).scopeConnectionIds).toBeUndefined();
    expect(readState(fileA).calls.fetchSnapshot).toBe(1);
  });
});

describe("lecture de plusieurs comptes", () => {
  it("fusionne les relevés en marquant l'origine de chaque canal et publication ; les deux comptes sont lus en entier", async () => {
    const snapshot = await router().fetchSnapshot();
    expect(snapshot.channels.map((c) => [c.id, c.connectionId])).toEqual([["ch-a", A], ["ch-b", B]]);
    expect(snapshot.posts.map((p) => [p.id, p.connectionId])).toEqual([["post-a", A], ["post-b", B]]);
    expect(snapshot.scopeConnectionIds).toEqual([A, B]);
    expect(snapshot.connectionErrors).toEqual([]);
    expect(states.map((s) => [s.id, s.state.ok, s.state.synced])).toEqual([[A, true, true], [B, true, true]]);
  });

  it("compte A en panne : B est lu normalement ; seules les publications de B peuvent être déclarées retirées", async () => {
    patch(fileA, (state) => { state.snapshotFails = true; });
    const snapshot = await router().fetchSnapshot();
    expect(snapshot.posts.map((p) => p.id)).toEqual(["post-b"]);
    expect(snapshot.scopeConnectionIds).toEqual([B]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.connectionErrors).toEqual([{ connectionId: A, label: "Colibri", message: "Buffer injoignable" }]);
    expect(states.find((s) => s.id === A)!.state).toMatchObject({ ok: false, synced: true });
    expect(states.find((s) => s.id === B)!.state).toMatchObject({ ok: true });
  });

  it("lecture tronquée du compte A : il sort du périmètre des retraits, B y reste", async () => {
    patch(fileA, (state) => { state.snapshotComplete = false; });
    const snapshot = await router().fetchSnapshot();
    expect(snapshot.scopeConnectionIds).toEqual([B]);
    expect(snapshot.posts.length).toBe(2);
  });

  it("tous les comptes en panne : c'est une erreur de lecture, pas un relevé vide", async () => {
    patch(fileA, (state) => { state.snapshotFails = true; });
    patch(fileB, (state) => { state.snapshotFails = true; });
    await expect(router().fetchSnapshot()).rejects.toThrow(/injoignable/);
  });

  it("aucune connexion active : relevé vide, incomplet et signalé ; rien ne peut être retiré", async () => {
    rows = [];
    const snapshot = await router().fetchSnapshot();
    expect(snapshot).toMatchObject({ channels: [], posts: [], complete: false, scopeConnectionIds: [] });
    expect(snapshot.connectionErrors![0].message).toMatch(/Aucune connexion fournisseur active/);
  });
});

describe("quota et panne par compte", () => {
  it("429 sur le compte A : erreur marquée A, pause enregistrée pour A seul, A n'est plus sollicité, B continue", async () => {
    patch(fileA, (state) => { state.faults.push("unschedulePost:429"); });
    const r = router();
    const error = await r.unschedulePost(post("post-a", "ch-a", { status: "scheduled" })).catch((e: ProviderError) => e);
    expect(error).toMatchObject({ kind: "rate_limit", connectionId: A, retryAfterSeconds: 172_800 });
    expect(states).toEqual([{ id: A, state: expect.objectContaining({ ok: false, pauseSeconds: 172_800 }) }]);

    const before = total(providerA);
    const refused = await r.getPost("post-a").catch((e: ProviderError) => e);
    expect(refused).toMatchObject({ kind: "rate_limit", connectionId: A, outcome: "failed" });
    await expect(r.createDraft(content("ch-a"))).rejects.toThrow(/Quota du compte « Colibri »/);
    expect(total(providerA)).toBe(before);
    // Le compte B n'est ni en pause ni ralenti.
    expect((await r.unschedulePost(post("post-b", "ch-b", { status: "scheduled" }))).status).toBe("draft");
    expect(states.filter((s) => s.id === B)).toEqual([]);
  });

  it("pause de quota lue en base : aucun appel avant l'échéance, appel de nouveau possible après", async () => {
    rows = [row(A, "Colibri", { pausedUntil: new Date(now + 3_600_000).toISOString() }), row(B, "Nordwind")];
    await expect(router().getPost("post-a")).rejects.toMatchObject({ kind: "rate_limit", connectionId: A });
    expect(total(providerA)).toBe(0);
    const snapshot = await router().fetchSnapshot();
    expect(snapshot.scopeConnectionIds).toEqual([B]);
    expect(total(providerA)).toBe(0);
    now += 3_700_000;
    expect((await router().getPost("post-a"))!.id).toBe("post-a");
  });

  it("panne réseau du compte A : A n'est plus sollicité pendant ce passage ; B continue ; le passage suivant réessaie A", async () => {
    patch(fileA, (state) => { state.faults.push("getPost:fail"); });
    const r = router();
    const first = await r.getPost("post-a").catch((e: ProviderError) => e);
    expect(first).toMatchObject({ kind: "network", connectionId: A, outcome: "unknown" });
    const second = await r.unschedulePost(post("post-a", "ch-a", { status: "scheduled" })).catch((e: ProviderError) => e);
    // Refus SANS appel : rien n'a pu être fait (résultat certain), contrairement à la première erreur.
    expect(second).toMatchObject({ kind: "network", connectionId: A, outcome: "failed" });
    expect(readState(fileA).calls).toEqual({ getPost: 1 });
    expect((await r.getPost("post-b"))!.id).toBe("post-b");
    expect((await router().getPost("post-a"))!.id).toBe("post-a");
  });

  it("réponse perdue sur une programmation du compte A : le résultat reste « inconnu », marqué A", async () => {
    patch(fileA, (state) => { state.faults.push("schedulePost:lose"); });
    const error = await router().schedulePost(post("post-a", "ch-a")).catch((e: ProviderError) => e);
    expect(error).toMatchObject({ outcome: "unknown", connectionId: A });
    expect(readState(fileA).posts["post-a"].status).toBe("scheduled");
  });
});

describe("le marquage d'une erreur ne se perd pas", () => {
  it("withCreatedPost conserve la connexion", () => {
    const error = new ProviderError("échec après création", "network", undefined, "unknown");
    error.connectionId = A;
    expect(error.withCreatedPost("p1")).toMatchObject({ connectionId: A, createdPostId: "p1" });
  });

  it("deux workers concurrents sur deux comptes : chacun n'écrit que dans le sien", async () => {
    const work = async (r: PublishingProvider, channel: string) => Promise.all(Array.from({ length: 5 }, () => r.createDraft(content(channel))));
    const [a, b] = await Promise.all([work(router(), "ch-a"), work(router(), "ch-b")]);
    expect(a.every((p) => p.connectionId === A) && b.every((p) => p.connectionId === B)).toBe(true);
    expect(readState(fileA).calls.createDraft).toBe(5);
    expect(readState(fileB).calls.createDraft).toBe(5);
    expect(Object.values(readState(fileA).posts).every((p) => p.channelId === "ch-a")).toBe(true);
    expect(Object.values(readState(fileB).posts).every((p) => p.channelId === "ch-b")).toBe(true);
  });
});

