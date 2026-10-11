import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUFFER_READ_ONLY } from "@/server/publishing/provider";

/*
 * Identité du compte Buffer derrière une clé (contrôle indépendant du 10 octobre 2026, P1-02).
 *
 * Le fournisseur est un faux serveur HTTP injecté (fetch) : AUCUN appel à Buffer. Ces tests prouvent le comportement
 * de Cadence face à des réponses données ; ils ne prouvent pas qu'une vraie clé appartient à un vrai compte.
 * Les clés sont des valeurs factices générées à chaque exécution.
 */

const KEY_A = `cle-a-${randomBytes(12).toString("hex")}`;
const KEY_A2 = `cle-a2-${randomBytes(12).toString("hex")}`;
const KEY_B = `cle-b-${randomBytes(12).toString("hex")}`;
const ACCOUNTS: Record<string, { id: string; name: string | null; email: string }> = {
  [KEY_A]: { id: "acct-A", name: "Maison Colibri", email: "contact@colibri.example" },
  [KEY_A2]: { id: "acct-A", name: "Maison Colibri", email: "contact@colibri.example" },
  [KEY_B]: { id: "acct-B", name: null, email: "sofia@nordwind.example" },
};

type Fault = "401" | "429" | "timeout" | "500" | "garbage" | "no-account" | null;
let fault: Fault;
let requests: { key: string; query: string }[];

/** Faux Buffer : répond selon la clé présentée. Enregistre chaque requête reçue. */
const fakeBuffer: typeof fetch = async (_url, init) => {
  const key = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
  const { query } = JSON.parse(String(init?.body)) as { query: string };
  requests.push({ key, query });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  if (fault === "timeout") throw Object.assign(new Error("délai"), { name: "TimeoutError" });
  if (fault === "401" || !ACCOUNTS[key]) return json({ errors: [{ message: "Unauthorized" }] }, 401);
  if (fault === "429") return json({ errors: [{ message: "Too many requests", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] }, 429, { "retry-after": "900" });
  if (fault === "500") return json({}, 503);
  if (fault === "garbage") return new Response("<html>", { status: 200 });
  if (query.includes("account")) {
    if (fault === "no-account") return json({ data: { account: null } });
    const account = ACCOUNTS[key];
    return json({ data: { account: { ...account, organizations: [{ id: `org-${account.id}` }] } } });
  }
  if (query.includes("Channels")) {
    return json({ data: { channels: [
      { id: `ch-${ACCOUNTS[key].id}-li`, service: "linkedin", name: "Page", displayName: null, isDisconnected: false },
      { id: `ch-${ACCOUNTS[key].id}-ig`, service: "instagram", name: "insta", displayName: "Insta", isDisconnected: true },
    ] } });
  }
  if (query.includes("Post(")) return json({ data: { post: null } });
  return json({ data: {} });
};

beforeEach(() => {
  fault = null;
  requests = [];
});

describe("BufferProvider — à quel compte appartient cette clé ?", () => {
  const load = () => import("@/server/publishing/buffer-provider");

  it("lit le compte et ses réseaux (lecture seule) ; l'adresse n'est jamais renvoyée entière", async () => {
    const { BufferProvider } = await load();
    const a = await new BufferProvider(KEY_A, "À valider", fakeBuffer).describeAccount();
    expect(a).toMatchObject({ id: "acct-A", label: "Maison Colibri", organizations: 1 });
    expect(a.channels).toEqual([
      { id: "ch-acct-A-li", service: "linkedin", name: "Page", isDisconnected: false },
      { id: "ch-acct-A-ig", service: "instagram", name: "Insta", isDisconnected: true },
    ]);
    const b = await new BufferProvider(KEY_B, "À valider", fakeBuffer).describeAccount();
    expect(b.label).toBe("s•••@nordwind.example");
    expect(JSON.stringify([a, b])).not.toMatch(/sofia@|contact@/);
    expect(requests.every((request) => !request.query.trimStart().startsWith("mutation"))).toBe(true);
  });

  it("clé refusée, quota, délai, erreur serveur, réponse illisible ou sans compte : aucune identité n'est supposée", async () => {
    const { BufferProvider } = await load();
    for (const kind of ["401", "429", "timeout", "500", "garbage", "no-account"] as Fault[]) {
      fault = kind;
      await expect(new BufferProvider(KEY_A, "À valider", fakeBuffer).describeAccount()).rejects.toThrow();
    }
    fault = "401";
    const error: Error = await new BufferProvider(KEY_A, "À valider", fakeBuffer).describeAccount().then(() => new Error("aucune erreur"), (cause) => cause as Error);
    expect(error.message).toMatch(/clé d'API de ce compte/);
    expect(error.message).not.toMatch(/BUFFER_API_KEY/);
    expect(error.message).not.toContain(KEY_A);
  });

  it("avec une identité attendue, la première requête recontrôle le compte : une clé d'un AUTRE compte n'envoie RIEN d'autre — refusé, lecture seule", async () => {
    const { BufferProvider } = await load();
    const wrong = new BufferProvider(KEY_B, "À valider", fakeBuffer, "acct-A");
    await expect(wrong.getPost("p1")).rejects.toThrow(/n'appartient pas au compte Buffer de cette connexion/);
    // L'écriture est refusée avant toute requête : seule la lecture précédente (contrôle d'identité) a été envoyée.
    await expect(wrong.schedulePost({ id: "p1", channelId: "c", service: "linkedin", status: "draft", text: "t", dueAt: "2031-01-01T09:00:00.000Z", sentAt: null, updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [] })).rejects.toMatchObject({ message: BUFFER_READ_ONLY, refusal: "writes_disabled", outcome: "failed" });
    expect(requests.length).toBe(1);
    expect(requests.every((request) => request.query.includes("account") && !request.query.includes("mutation"))).toBe(true);

    // Même compte : contrôlé une seule fois, puis les opérations passent.
    requests = [];
    const right = new BufferProvider(KEY_A2, "À valider", fakeBuffer, "acct-A");
    await right.getPost("p1");
    await right.getPost("p2");
    expect(requests.filter((request) => request.query.includes("account")).length).toBe(1);
    expect(requests.length).toBe(3);
  });

  it("identité non vérifiable au premier appel (panne) : l'opération échoue, et le contrôle est refait à l'appel suivant", async () => {
    const { BufferProvider } = await load();
    const provider = new BufferProvider(KEY_A, "À valider", fakeBuffer, "acct-A");
    fault = "500";
    await expect(provider.getPost("p1")).rejects.toThrow();
    fault = null;
    requests = [];
    await provider.getPost("p1");
    expect(requests[0].query).toContain("account");
  });
});

/* ------------------------------------------------------------------------------------------------------------------
 * Actions serveur : ce que l'administrateur déclenche réellement depuis l'interface.
 * ---------------------------------------------------------------------------------------------------------------- */

interface Call { name: string; params: Record<string, unknown> }
let role: "admin" | "client" | null;
let calls: Call[];
let sessionCalls: Call[];
let outcomes: Record<string, unknown>;
let stored: { id: string; ciphertext: string; keyVersion: number; credentialSource: string; label: string }[];

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/auth", () => ({
  getSession: async () => (role ? { profile: { id: "user-1", role, full_name: "x", job_title: null }, organizations: [] } : null),
}));
vi.mock("@/server/automation-rpc", () => ({
  MissingFunctionError: class extends Error {},
  rpc: async (name: string, params: Record<string, unknown>) => {
    calls.push({ name, params });
    if (name === "provider_connections_for_run") return stored;
    if (outcomes[name] instanceof Error) throw outcomes[name];
    return outcomes[name] ?? null;
  },
}));
vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      sessionCalls.push({ name, params });
      return { data: outcomes[name] ?? null, error: null };
    },
  }),
}));

const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONNECTION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const original = { ...process.env };

describe("actions serveur — la clé n'est enregistrée qu'avec une identité constatée", () => {
  beforeEach(() => {
    role = "admin";
    calls = [];
    sessionCalls = [];
    outcomes = {};
    stored = [];
    vi.stubGlobal("fetch", fakeBuffer);
    Object.assign(process.env, { BUFFER_MODE: "real", NODE_ENV: "test", CADENCE_CREDENTIALS_KEY: randomBytes(32).toString("base64") });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...original };
  });
  const actions = () => import("@/server/connection-actions");
  const everything = (...results: unknown[]) => JSON.stringify([results, calls, sessionCalls]);

  it("mode réel, clé valide : identité lue chez le fournisseur par le SERVEUR, puis enregistrée chiffrée avec son empreinte", async () => {
    const { createRealConnection } = await actions();
    const result = await createRealConnection({ organizationId: ORG, label: "Buffer Colibri", apiKey: KEY_A });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/vérifiée auprès de Buffer.*Maison Colibri.*2 canaux/);
    expect(calls.map((call) => call.name)).toEqual(["server_create_provider_connection"]);
    const { params } = calls[0];
    expect(params).toMatchObject({ p_actor: "user-1", p_organization_id: ORG, p_external_account_id: "acct-A", p_external_account_label: "Maison Colibri", p_key_version: 1, p_hint: KEY_A.slice(-4) });
    expect(String(params.p_ciphertext)).toMatch(/^v1\./);
    expect(String(params.p_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    // La clé complète ne figure ni dans le résultat renvoyé au navigateur, ni dans ce qui part vers la base.
    expect(everything(result)).not.toContain(KEY_A);
    // Aucune fonction « de session » n'a servi : le navigateur ne peut pas rejouer cet enregistrement.
    expect(sessionCalls).toEqual([]);
  });

  it("mode réel, clé refusée, non vérifiable ou sans compte : RIEN n'est enregistré", async () => {
    const { createRealConnection } = await actions();
    for (const kind of ["401", "429", "timeout", "500", "garbage", "no-account"] as Fault[]) {
      fault = kind;
      const result = await createRealConnection({ organizationId: ORG, label: "Buffer", apiKey: KEY_A });
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(KEY_A);
    }
    expect(calls).toEqual([]);
  });

  it("remplacement : une clé non vérifiable ne remplace jamais la clé en place ; une clé d'un autre compte est refusée par la base", async () => {
    const { replaceConnectionCredential } = await actions();
    fault = "timeout";
    const unreachable = await replaceConnectionCredential({ connectionId: CONNECTION, apiKey: KEY_A2 });
    expect(unreachable).toMatchObject({ ok: false });
    expect(unreachable.message).toMatch(/ancienne clé reste en place/);
    expect(calls).toEqual([]);

    // Clé du compte B présentée pour la connexion du compte A : le serveur transmet l'identité CONSTATÉE (acct-B),
    // jamais celle que l'on voudrait ; la base répond « autre compte » et ne change rien.
    fault = null;
    outcomes.server_set_provider_credential = "account_mismatch";
    const other = await replaceConnectionCredential({ connectionId: CONNECTION, apiKey: KEY_B });
    expect(other.ok).toBe(false);
    expect(other.message).toMatch(/autre compte Buffer.*ancienne clé reste en place/);
    expect(calls.at(-1)).toMatchObject({ name: "server_set_provider_credential", params: { p_connection_id: CONNECTION, p_external_account_id: "acct-B" } });

    outcomes.server_set_provider_credential = "replaced";
    const same = await replaceConnectionCredential({ connectionId: CONNECTION, apiKey: KEY_A2 });
    expect(same).toMatchObject({ ok: true });
    expect(calls.at(-1)?.params).toMatchObject({ p_external_account_id: "acct-A" });
    expect(everything(unreachable, other, same)).not.toMatch(new RegExp(`${KEY_A2}|${KEY_B}`));
  });

  it("serveur en simulation : AUCUN appel au fournisseur ; la clé est enregistrée « non vérifiée »", async () => {
    process.env.BUFFER_MODE = "mock";
    const { createRealConnection, replaceConnectionCredential, verifyConnection } = await actions();
    const created = await createRealConnection({ organizationId: ORG, label: "Buffer", apiKey: KEY_A });
    expect(created.ok).toBe(true);
    expect(created.message).toMatch(/NON vérifiée.*inutilisable/);
    expect(calls[0].params).toMatchObject({ p_external_account_id: null });
    outcomes.server_set_provider_credential = "replaced";
    await replaceConnectionCredential({ connectionId: CONNECTION, apiKey: KEY_A2 });
    expect(calls[1].params).toMatchObject({ p_external_account_id: null });
    expect(await verifyConnection({ connectionId: CONNECTION })).toMatchObject({ ok: false });
    expect(requests).toEqual([]);
  });

  it("vérifier une connexion : la clé ENREGISTRÉE est déchiffrée par le serveur, le compte constaté est consigné, rien n'est écrit chez le fournisseur", async () => {
    const { encryptCredential } = await import("@/server/credentials");
    stored = [{ id: CONNECTION, ciphertext: encryptCredential(CONNECTION, KEY_B), keyVersion: 1, credentialSource: "stored", label: "Buffer Nordwind" }];
    outcomes.server_record_provider_verification = "verified";
    const { verifyConnection } = await actions();
    const result = await verifyConnection({ connectionId: CONNECTION });
    expect(result).toMatchObject({ ok: true, account: { label: "s•••@nordwind.example" } });
    expect(result.account?.channels.map((channel) => channel.service)).toEqual(["linkedin", "instagram"]);
    expect(requests.every((request) => request.key === KEY_B && !request.query.includes("mutation"))).toBe(true);
    expect(calls.at(-1)).toMatchObject({ name: "server_record_provider_verification", params: { p_ok: true, p_external_account_id: "acct-B", p_actor: "user-1" } });
    expect(JSON.stringify([result, calls.at(-1)])).not.toContain(KEY_B);

    // Clé devenue invalide : l'échec est consigné, sans identité.
    fault = "401";
    outcomes.server_record_provider_verification = "failed";
    expect(await verifyConnection({ connectionId: CONNECTION })).toMatchObject({ ok: false });
    expect(calls.at(-1)?.params).toMatchObject({ p_ok: false, p_external_account_id: null });

    // Le compte constaté n'est plus celui de la connexion : dit clairement.
    fault = null;
    outcomes.server_record_provider_verification = "account_mismatch";
    expect((await verifyConnection({ connectionId: CONNECTION })).message).toMatch(/autre compte Buffer/);
  });

  it("rotation de la clé maître : chaque clé Buffer est re-chiffrée avec la clé courante, sans appel au fournisseur", async () => {
    const { encryptCredential, decryptCredential } = await import("@/server/credentials");
    const oldKey = process.env.CADENCE_CREDENTIALS_KEY!;
    stored = [
      { id: CONNECTION, ciphertext: encryptCredential(CONNECTION, KEY_A), keyVersion: 1, credentialSource: "stored", label: "A" },
      { id: ORG, ciphertext: encryptCredential(ORG, KEY_B), keyVersion: 1, credentialSource: "stored", label: "B" },
    ];
    Object.assign(process.env, { CADENCE_CREDENTIALS_KEY: randomBytes(32).toString("base64"), CADENCE_CREDENTIALS_KEY_VERSION: "2", CADENCE_CREDENTIALS_PREVIOUS_KEYS: `1:${oldKey}` });
    outcomes.server_reencrypt_provider_credential = true;
    const { reencryptCredentials } = await actions();
    const result = await reencryptCredentials();
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toMatch(/2 clé\(s\) re-chiffrée\(s\).*n° 2/);
    const writes = calls.filter((call) => call.name === "server_reencrypt_provider_credential");
    expect(writes.map((call) => [call.params.p_connection_id, call.params.p_from_key_version, call.params.p_key_version])).toEqual([[CONNECTION, 1, 2], [ORG, 1, 2]]);
    expect(decryptCredential(CONNECTION, String(writes[0].params.p_ciphertext), 2)).toBe(KEY_A);
    expect(decryptCredential(ORG, String(writes[1].params.p_ciphertext), 2)).toBe(KEY_B);
    expect(requests).toEqual([]);
    expect(everything(result)).not.toMatch(new RegExp(`${KEY_A}|${KEY_B}`));

    // Ancienne clé maître absente du serveur : rien n'est écrasé, et l'action dit de ne pas la retirer.
    calls = [];
    delete process.env.CADENCE_CREDENTIALS_PREVIOUS_KEYS;
    const blocked = await reencryptCredentials();
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/illisible/);
    expect(calls.filter((call) => call.name === "server_reencrypt_provider_credential")).toEqual([]);
  });

  it("un client, ou une session expirée, ne déclenche ni appel au fournisseur ni écriture", async () => {
    const all = await actions();
    for (const who of ["client", null] as const) {
      role = who;
      const results = [
        await all.createRealConnection({ organizationId: ORG, label: "x", apiKey: KEY_A }),
        await all.replaceConnectionCredential({ connectionId: CONNECTION, apiKey: KEY_A }),
        await all.verifyConnection({ connectionId: CONNECTION }),
        await all.revokeConnection({ connectionId: CONNECTION, force: true }),
        await all.cancelRevocation({ connectionId: CONNECTION }),
        await all.connectionDetail({ connectionId: CONNECTION }),
        await all.reencryptCredentials(),
        await all.createMockConnection({ organizationId: ORG, label: "x" }),
      ];
      expect(results.every((result) => result.ok === false)).toBe(true);
      if (who === null) expect(results.every((result) => result.expired === true)).toBe(true);
    }
    expect(requests).toEqual([]);
    expect(calls).toEqual([]);
    expect(sessionCalls).toEqual([]);
  });

  it("révocation : d'abord DEMANDÉE (clé conservée pour annuler) ; forcée seulement sur décision explicite, en disant ce qui reste à faire", async () => {
    const { revokeConnection } = await actions();
    outcomes.admin_request_provider_revocation = { revoked: false, revoking: true, unresolved: { scheduled: 2, pending: 1, uncertain: 0 } };
    const requested = await revokeConnection({ connectionId: CONNECTION });
    expect(requested).toMatchObject({ ok: false, revoking: true, unresolved: { scheduled: 2, pending: 1, uncertain: 0 } });
    expect(requested.message).toMatch(/Révocation demandée.*2 publication\(s\) programmée\(s\)/);
    expect(sessionCalls.map((call) => call.name)).toEqual(["admin_request_provider_revocation"]);

    outcomes.admin_revoke_provider_connection = { revoked: true, forced: true };
    const forced = await revokeConnection({ connectionId: CONNECTION, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.message).toMatch(/ne sont PAS annulées chez Buffer/);
    expect(sessionCalls.at(-1)).toMatchObject({ name: "admin_revoke_provider_connection", params: { p_force: true } });
  });

  it("serveur qui utilise le vrai Buffer : aucun compte simulé ne peut y être créé", async () => {
    const { createMockConnection } = await actions();
    expect(await createMockConnection({ organizationId: ORG, label: "Simulé" })).toMatchObject({ ok: false });
    Object.assign(process.env, { NODE_ENV: "production", BUFFER_MODE: "mock" });
    delete process.env.CADENCE_ALLOW_SIMULATED_BUFFER;
    expect(await createMockConnection({ organizationId: ORG, label: "Simulé" })).toMatchObject({ ok: false });
    expect(sessionCalls).toEqual([]);
  });
});
