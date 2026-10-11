import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderError, type DraftContent, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";
import { ConnectionRouter, type ConnectionRow, type ConnectionState, type DurableConnectionState, type RouterDeps } from "@/server/publishing/router";
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
let durable: Record<string, DurableConnectionState> | null;
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
    // État durable relu avant chaque opération. `null` : base sans 0013 (l'état chargé au départ fait foi).
    loadStates: async () => durable,
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
  durable = null;
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


/*
 * Contrôle indépendant du 10 octobre 2026 — un routeur DÉJÀ CHARGÉ doit obéir à l'état durable de la base
 * (P1-01 révocation, P1-04 pause), et la version de production ne doit ni simuler ni écrire sans autorisation.
 */
const active = (): Record<string, DurableConnectionState> => ({ [A]: { status: "active", pausedUntil: null, credentialAt: "t0" }, [B]: { status: "active", pausedUntil: null, credentialAt: "t0" } });

describe("un routeur déjà chargé relit l'état durable avant chaque opération", () => {
  it("révocation confirmée après le chargement : plus aucune écriture ni lecture sur A, B continue (N10)", async () => {
    durable = active();
    const loaded = router();
    await loaded.fetchSnapshot();
    const before = total(providerA);
    durable[A] = { status: "revoked", pausedUntil: null };
    for (const call of [() => loaded.createDraft(content("ch-a")), () => loaded.schedulePost(post("post-a", "ch-a")), () => loaded.unschedulePost(post("post-a", "ch-a")), () => loaded.getPost("post-a")]) {
      const error = await call().catch((cause) => cause);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ connectionId: A, outcome: "failed" });
      expect(error.message).toMatch(/révoquée/);
    }
    expect(total(providerA)).toBe(before);
    await loaded.createDraft(content("ch-b"));
    expect(providerB.calls("createDraft")).toBe(1);
  });

  it("connexion disparue de la base : traitée comme révoquée, jamais comme utilisable", async () => {
    durable = active();
    const loaded = router();
    await loaded.fetchSnapshot();
    delete durable[A];
    await expect(loaded.createDraft(content("ch-a"))).rejects.toThrow(/révoquée/);
    expect(providerA.calls("createDraft")).toBe(0);
  });

  it("pause de quota enregistrée par un AUTRE worker après le chargement : aucune requête sur A, B continue (N11)", async () => {
    durable = active();
    const loaded = router();
    await loaded.fetchSnapshot();
    const before = total(providerA);
    durable[A] = { status: "active", pausedUntil: new Date(now + 48 * 3600_000).toISOString(), credentialAt: "t0" };
    const error = await loaded.createDraft(content("ch-a")).catch((cause) => cause);
    expect(error).toMatchObject({ kind: "rate_limit", connectionId: A });
    expect(error.retryAfterSeconds).toBeGreaterThan(172_000);
    await expect(loaded.unschedulePost(post("post-a", "ch-a"))).rejects.toMatchObject({ kind: "rate_limit" });
    expect(total(providerA)).toBe(before);
    await loaded.unschedulePost(post("post-b", "ch-b"));
    expect(providerB.calls("unschedulePost")).toBe(1);
    // Une pause plus courte lue ensuite ne raccourcit pas celle déjà connue.
    durable[A] = { status: "active", pausedUntil: new Date(now + 60_000).toISOString(), credentialAt: "t0" };
    now += 120_000;
    await expect(loaded.createDraft(content("ch-a"))).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("clé remplacée pendant le passage : le client chargé (ancienne clé) n'envoie plus rien", async () => {
    durable = active();
    const loaded = router();
    await loaded.fetchSnapshot();
    durable[A] = { status: "active", pausedUntil: null, credentialAt: "t1" };
    await expect(loaded.createDraft(content("ch-a"))).rejects.toThrow(/clé.*a changé/);
    expect(providerA.calls("createDraft")).toBe(0);
    // Un nouveau routeur (prochain passage) repart avec la nouvelle clé.
    await router().createDraft(content("ch-a"));
    expect(providerA.calls("createDraft")).toBe(1);
  });

  it("état illisible en base : l'opération est REFUSÉE (résultat certain), rien n'est envoyé", async () => {
    const loaded = router({ loadStates: async () => { throw new Error("base injoignable"); } });
    const error = await loaded.createDraft(content("ch-a")).catch((cause) => cause);
    expect(error).toMatchObject({ outcome: "failed", connectionId: A });
    expect(error.message).toMatch(/illisible en base.*rien n'a été envoyé/);
    expect(total(providerA)).toBe(0);
  });

  it("révocation demandée : annuler et lire restent possibles avec la clé conservée ; aucun NOUVEL effet", async () => {
    durable = active();
    rows = [row(A, "Colibri", { status: "revoking" }), row(B, "Nordwind")];
    durable[A].status = "revoking";
    const loaded = router();
    for (const call of [() => loaded.createDraft(content("ch-a")), () => loaded.schedulePost(post("post-a", "ch-a")), () => loaded.updateDraft("post-a", content("ch-a")), () => loaded.rescheduleDraft(post("post-a", "ch-a"), DUE)]) {
      await expect(call()).rejects.toThrow(/Révocation demandée/);
    }
    expect(total(providerA)).toBe(0);
    expect((await loaded.getPost("post-a"))?.id).toBe("post-a");
    expect((await loaded.unschedulePost(post("post-a", "ch-a"))).status).toBe("draft");
    expect(providerA.calls("unschedulePost")).toBe(1);
    // Demande posée APRÈS le chargement : même effet.
    durable = active();
    rows = [row(A, "Colibri"), row(B, "Nordwind")];
    const later = router();
    await later.fetchSnapshot();
    durable[A].status = "revoking";
    await expect(later.createDraft(content("ch-a"))).rejects.toThrow(/Révocation demandée/);
    expect(providerA.calls("createDraft")).toBe(0);
  });

  it("clé jamais vérifiée auprès du fournisseur : la connexion est inutilisable, aucun client n'est construit", async () => {
    rows = [row(A, "Colibri", { verified: false }), row(B, "Nordwind")];
    const loaded = router();
    await expect(loaded.createDraft(content("ch-a"))).rejects.toThrow(/non vérifiée/);
    expect(built).toEqual([B]);
    const snapshot = await loaded.fetchSnapshot();
    expect(snapshot.scopeConnectionIds).toEqual([B]);
    expect(snapshot.connectionErrors?.[0]).toMatchObject({ connectionId: A });
  });

  it("pause de quota impossible à enregistrer : retentée, puis signalée dans l'erreur ; le compte n'est plus sollicité", async () => {
    let attempts = 0;
    const loaded = router({ recordState: async () => { attempts += 1; throw new Error("base injoignable"); } });
    patch(fileA, (state) => state.faults.push("unschedulePost:429"));
    const error = await loaded.unschedulePost(post("post-a", "ch-a")).catch((cause) => cause);
    expect(error).toMatchObject({ kind: "rate_limit", connectionId: A });
    expect(error.message).toMatch(/pause de ce compte n'a pas pu être enregistrée/);
    expect(attempts).toBe(2);
    const calls = total(providerA);
    await expect(loaded.getPost("post-a")).rejects.toMatchObject({ kind: "rate_limit" });
    expect(total(providerA)).toBe(calls);
  });
});

describe("production : ni simulateur silencieux, ni écriture sans autorisation", () => {
  it("barrière d'activation fermée : toutes les écritures sont refusées avant tout appel ; les lectures passent", async () => {
    const loaded = router({ writesDisabled: "Les écritures vers Buffer ne sont pas activées." });
    for (const call of [
      () => loaded.createDraft(content("ch-a")), () => loaded.updateDraft("post-a", content("ch-a")), () => loaded.rescheduleDraft(post("post-a", "ch-a"), DUE),
      () => loaded.schedulePost(post("post-a", "ch-a")), () => loaded.unschedulePost(post("post-a", "ch-a")),
    ]) {
      const error = await call().catch((cause) => cause);
      expect(error).toMatchObject({ refusal: "writes_disabled", outcome: "failed", kind: "api" });
      expect(error.connectionId).toBeUndefined();
    }
    expect(total(providerA) + total(providerB)).toBe(0);
    expect((await loaded.fetchSnapshot()).posts.length).toBe(2);
    expect((await loaded.getPost("post-a"))?.id).toBe("post-a");
    expect(readState(fileA).posts["post-a"].status).toBe("scheduled");
  });

  it("configuration invalide : aucune opération, lecture comprise, et aucun fournisseur n'est construit", async () => {
    const loaded = router({ blocked: "BUFFER_MODE doit valoir « real » en production." });
    for (const call of [() => loaded.fetchSnapshot(), () => loaded.getPost("post-a"), () => loaded.createDraft(content("ch-a")), () => loaded.findDraftCandidates({ channelId: "ch-a", text: "x", dueAt: DUE })]) {
      await expect(call()).rejects.toMatchObject({ refusal: "blocked", outcome: "failed" });
    }
    expect(built).toEqual([]);
    expect(total(providerA) + total(providerB)).toBe(0);
  });

  it("mode réel sans aucun compte connecté : relevé vide signalé, aucune écriture possible, aucun compte inventé", async () => {
    rows = [];
    const loaded = router({ mode: "real" });
    const snapshot = await loaded.fetchSnapshot();
    expect(snapshot).toMatchObject({ channels: [], posts: [], complete: false, scopeConnectionIds: [] });
    expect(snapshot.connectionErrors?.[0].message).toMatch(/Aucune connexion fournisseur active/);
    await expect(loaded.createDraft(content("ch-a"))).rejects.toThrow(/révoquée ou indisponible/);
    expect(built).toEqual([]);
  });
});

describe("lecture en parallèle et quota presque épuisé", () => {
  const slow = (provider: FileProvider, ms: number, rateLimit: Record<string, number> | null = null): PublishingProvider =>
    Object.assign(Object.create(provider), {
      fetchSnapshot: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { ...(await provider.fetchSnapshot()), rateLimit };
      },
    });

  it("un compte lent ne retarde pas la lecture des autres ; le relevé garde l'ordre des connexions", async () => {
    const finished: string[] = [];
    const loaded = router({
      build: (connection) => Object.assign(Object.create(connection.id === A ? providerA : providerB), {
        fetchSnapshot: async () => {
          await new Promise((resolve) => setTimeout(resolve, connection.id === A ? 120 : 5));
          finished.push(connection.id);
          return (connection.id === A ? providerA : providerB).fetchSnapshot();
        },
      }),
    });
    const started = Date.now();
    const snapshot = await loaded.fetchSnapshot();
    expect(finished).toEqual([B, A]);
    expect(Date.now() - started).toBeLessThan(240);
    expect(snapshot.scopeConnectionIds).toEqual([A, B]);
    expect(snapshot.channels.map((channel) => channel.id)).toEqual(["ch-a", "ch-b"]);
  });

  it("quota presque épuisé sur A (plusieurs comptes) : espacement enregistré pour A seul, aucune pause, aucun ralentissement global", async () => {
    const backoffs: { id: string; seconds: number; reason: string }[] = [];
    const loaded = router({
      build: (connection) => (connection.id === A ? slow(providerA, 0, { "100-in-15min": 3, "250-in-24h": 200 }) : slow(providerB, 0, { "100-in-15min": 90 })),
      recordReadBackoff: async (id, seconds, reason) => { backoffs.push({ id, seconds, reason }); },
    });
    const snapshot = await loaded.fetchSnapshot();
    expect(backoffs.map((item) => item.id)).toEqual([A]);
    expect(backoffs[0].seconds).toBeGreaterThan(0);
    expect(backoffs[0].reason).toMatch(/lectures planifiées de ce compte espacées/);
    expect(snapshot.rateLimit).toBeNull();
    expect(states.filter((item) => item.state.pauseSeconds)).toEqual([]);
    // Écritures et annulations du compte A restent possibles : l'espacement ne concerne que ses lectures planifiées.
    await loaded.unschedulePost(post("post-a", "ch-a"));
    expect(providerA.calls("unschedulePost")).toBe(1);
  });

  it("passage planifié : le compte espacé n'est pas lu et rien n'en est déduit ; un passage manuel le lit", async () => {
    rows = [row(A, "Colibri", { readBackoffUntil: new Date(now + 3600_000).toISOString() }), row(B, "Nordwind")];
    const planned = await router({ respectReadBackoff: true }).fetchSnapshot();
    expect(providerA.calls("fetchSnapshot")).toBe(0);
    expect(planned.scopeConnectionIds).toEqual([B]);
    expect(planned.complete).toBe(false);
    expect(planned.skippedConnections).toEqual([{ connectionId: A, label: "Colibri", until: new Date(now + 3600_000).toISOString() }]);
    expect(planned.connectionErrors).toEqual([]);
    const manual = await router().fetchSnapshot();
    expect(manual.scopeConnectionIds).toEqual([A, B]);
    // Tous les comptes espacés : ce n'est pas une panne de lecture.
    rows = [row(A, "Colibri", { readBackoffUntil: new Date(now + 3600_000).toISOString() })];
    await expect(router({ respectReadBackoff: true }).fetchSnapshot()).resolves.toMatchObject({ complete: false, scopeConnectionIds: [] });
  });
});
