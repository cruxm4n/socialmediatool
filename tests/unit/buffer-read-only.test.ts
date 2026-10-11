import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUFFER_READ_ONLY, ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";

/*
 * GARANTIE CENTRALE DU PRODUIT : Cadence ne fait que LIRE Buffer.
 *
 * Une approbation, une demande de modification, un commentaire ou une synchronisation ne créent, ne modifient, ne
 * programment et ne déprogramment rien dans Buffer — y compris quand l'ancienne variable CADENCE_BUFFER_WRITES est
 * positionnée à « enabled ». La programmation se fait à la main dans Buffer.
 *
 * Trois niveaux sont vérifiés : le client du vrai Buffer (aucune mutation ne part), les actions et la
 * synchronisation (aucune méthode d'écriture n'est appelée), et le code source (aucun chemin d'écriture ne subsiste).
 */

const WRITE_METHODS = ["schedulePost", "unschedulePost", "createDraft", "updateDraft", "rescheduleDraft"] as const;

const DUE = "2030-01-15T09:00:00.000Z";
const post = (overrides: Partial<ProviderPost> = {}): ProviderPost => ({
  id: "b1", channelId: "c1", service: "twitter", status: "draft", text: "Texte validé", dueAt: DUE, sentAt: null,
  updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [], ...overrides,
});

// --- Doublures : base (session et automatisation) et fournisseur espion ------------------------------------------

const sessionCalls: { name: string; params: Record<string, unknown> }[] = [];
const automationCalls: { name: string; params: Record<string, unknown> }[] = [];
/** Ce que la base proposerait à la programmation si quelqu'un le demandait : un piège, jamais consommé. */
const CLAIMABLE = [{ id: "p1", buffer_post_id: "b1", text: "Texte validé", assets: [], due_at: DUE, service: "twitter", token: "jeton-p1" }];
let toUnschedule: unknown[] = [];

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: (task: () => void) => task() }));
vi.mock("@/server/auth", () => ({
  homePath: () => "/client",
  getSession: async () => ({ profile: { id: "u1", fullName: "Cliente", jobTitle: "", role: "client" }, organizations: [] }),
}));
vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      sessionCalls.push({ name, params });
      return { data: {}, error: null };
    },
  }),
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      automationCalls.push({ name, params });
      if (name.startsWith("claim_posts_for_scheduling")) return { data: CLAIMABLE, error: null };
      if (name.startsWith("list_posts_to_unschedule")) return { data: toUnschedule, error: null };
      if (name === "begin_sync_run") return { data: { acquired: true, token: "verrou" }, error: null };
      if (name === "begin_urgent_run") return { data: { acquired: true, token: "urgent" }, error: null };
      if (name === "renew_sync_run" || name === "renew_urgent_run") return { data: true, error: null };
      if (name === "sync_buffer_posts") return { data: { fetched: 1, created: 0, updated: 1, invalidated: 0, removed: 0 }, error: null };
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/server/notifications", () => ({ dispatchNotifications: vi.fn(async () => ({})) }));

type Spy = PublishingProvider & Record<(typeof WRITE_METHODS)[number] | "getPost" | "fetchSnapshot", ReturnType<typeof vi.fn>>;
let provider: Spy;
vi.mock("@/server/publishing", () => ({ getProvider: () => provider }));

function spyProvider(mode: "real" | "mock"): Spy {
  return {
    mode,
    fetchSnapshot: vi.fn(async () => ({ channels: [], posts: [post()], complete: true, rateLimit: null })),
    getPost: vi.fn(async () => post({ status: "scheduled" })),
    // Si une écriture était appelée, elle « réussirait » : le test échouerait alors sur le nombre d'appels.
    schedulePost: vi.fn(async (item: ProviderPost) => ({ ...item, status: "scheduled" as const })),
    unschedulePost: vi.fn(async (item: ProviderPost) => ({ ...item, status: "draft" as const })),
    createDraft: vi.fn(async () => post()),
    updateDraft: vi.fn(async () => post()),
    rescheduleDraft: vi.fn(async () => post()),
    findDraftCandidates: vi.fn(async () => ({ candidates: [], complete: true })),
  } as Spy;
}

function expectNoWrite() {
  for (const method of WRITE_METHODS) expect(provider[method], `appel inattendu de ${method}`).toHaveBeenCalledTimes(0);
  const names = [...automationCalls, ...sessionCalls].map((call) => call.name);
  expect(names.filter((name) => name.startsWith("claim_posts_for_scheduling"))).toEqual([]);
  expect(names.filter((name) => name === "complete_scheduling")).toEqual([]);
}

const POST_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  sessionCalls.length = 0;
  automationCalls.length = 0;
  toUnschedule = [];
  provider = spyProvider("real");
  vi.stubEnv("AUTOMATION_SECRET", "secret-de-test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "cle-de-test");
  // L'ancienne barrière est volontairement « ouverte » dans TOUS les tests de ce fichier : elle ne doit rien ouvrir.
  vi.stubEnv("CADENCE_BUFFER_WRITES", "enabled");
  vi.stubEnv("BUFFER_MODE", "real");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(["real", "mock"] as const)("décisions du client, fournisseur %s : aucune écriture vers Buffer", (mode) => {
  beforeEach(() => {
    provider = spyProvider(mode);
  });

  it("approuver une publication n'envoie rien à Buffer et n'annonce aucune programmation automatique", async () => {
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(result).toEqual({ ok: true, message: "Publication approuvée. Votre agence la programmera dans Buffer." });
    expect(sessionCalls).toEqual([{ name: "decide_post", params: { p_post_id: POST_ID, p_decision: "approved", p_expected_hash: "empreinte", p_comment: null } }]);
    expectNoWrite();
    // Aucune lecture non plus : la décision est entièrement interne à Cadence.
    expect(provider.getPost).toHaveBeenCalledTimes(0);
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(0);
    expect(automationCalls).toEqual([]);
  });

  it("approuver plusieurs publications n'envoie rien à Buffer", async () => {
    const { approvePosts } = await import("@/server/actions");
    const result = await approvePosts([{ postId: POST_ID, expectedHash: "a" }, { postId: OTHER_ID, expectedHash: "b" }]);
    expect(result).toMatchObject({ ok: true, approved: 2, refused: [] });
    expect(sessionCalls.map((call) => [call.name, call.params.p_post_id, call.params.p_decision])).toEqual([
      ["decide_post", POST_ID, "approved"],
      ["decide_post", OTHER_ID, "approved"],
    ]);
    expectNoWrite();
    expect(provider.getPost).toHaveBeenCalledTimes(0);
    expect(automationCalls).toEqual([]);
  });

  it("demander des modifications n'envoie rien à Buffer", async () => {
    const { requestChanges } = await import("@/server/actions");
    const result = await requestChanges({ postId: POST_ID, expectedHash: "empreinte", comment: "Changer le visuel" });
    expect(result.ok).toBe(true);
    expect(sessionCalls).toEqual([{ name: "decide_post", params: { p_post_id: POST_ID, p_decision: "changes_requested", p_expected_hash: "empreinte", p_comment: "Changer le visuel" } }]);
    expectNoWrite();
    expect(automationCalls).toEqual([]);
  });

  it("commenter n'envoie rien à Buffer", async () => {
    const { addComment } = await import("@/server/actions");
    const result = await addComment({ postId: POST_ID, body: "Bien reçu" });
    expect(result.ok).toBe(true);
    expect(sessionCalls).toEqual([{ name: "add_comment", params: { p_post_id: POST_ID, p_body: "Bien reçu" } }]);
    expectNoWrite();
    expect(automationCalls).toEqual([]);
  });
});

describe.each(["real", "mock"] as const)("synchronisation, fournisseur %s : lecture seule", (mode) => {
  beforeEach(() => {
    provider = spyProvider(mode);
  });

  it("des publications approuvées attendent : la synchronisation ne réserve et ne programme rien", async () => {
    const { runSync } = await import("@/server/sync");
    const result = await runSync("manuel");
    expect(result).toMatchObject({ ok: true, fetched: 1, updated: 1, scheduled: 0, scheduleFailures: 0, unscheduled: 0, unscheduleFailures: 0 });
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1);
    expectNoWrite();
  });

  it("la synchronisation planifiée ne réserve et ne programme rien non plus", async () => {
    const { runSync } = await import("@/server/sync");
    const result = await runSync("planificateur", { scheduled: true });
    expect(result).toMatchObject({ ok: true, scheduled: 0, scheduleFailures: 0 });
    expectNoWrite();
  });

  it("publication programmée à la main sans accord valable : signalée, jamais déprogrammée par Cadence", async () => {
    toUnschedule = [{ id: "p9", buffer_post_id: "b9", text: "Texte", assets: [], due_at: DUE, service: "twitter" }];
    const { runSync } = await import("@/server/sync");
    const { STILL_SCHEDULED } = await import("@/server/compensation");
    const result = await runSync("manuel");
    expect(result).toMatchObject({ ok: false, unscheduled: 0, unscheduleFailures: 1 });
    expect(result.error).toContain("Repassez-les en brouillon dans Buffer");
    // Une lecture pour constater, aucune écriture.
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(provider.getPost).toHaveBeenCalledWith("b9");
    expect(automationCalls.filter((call) => call.name === "complete_unscheduling").map((call) => call.params)).toEqual([
      { p_secret: "secret-de-test", p_post_id: "p9", p_ok: false, p_error: STILL_SCHEDULED },
    ]);
    expectNoWrite();
  });

  it("retour en brouillon fait à la main dans Buffer : constaté et enregistré, sans écriture", async () => {
    toUnschedule = [{ id: "p9", buffer_post_id: "b9", text: "Texte", assets: [], due_at: DUE, service: "twitter" }];
    provider.getPost.mockResolvedValue(post({ id: "b9", status: "draft" }));
    const { runSync } = await import("@/server/sync");
    const result = await runSync("manuel");
    expect(result).toMatchObject({ ok: true, unscheduled: 1, unscheduleFailures: 0 });
    expect(automationCalls.filter((call) => call.name === "complete_unscheduling").map((call) => call.params)).toEqual([
      { p_secret: "secret-de-test", p_post_id: "p9", p_ok: true, p_observed_status: "draft" },
    ]);
    expectNoWrite();
  });
});

describe("vrai Buffer : aucune mutation ne quitte le serveur", () => {
  const content = { channelId: "c1", service: "twitter", text: "Bonjour", dueAt: DUE, assets: [] };

  async function realProvider() {
    const { BufferProvider } = await import("@/server/publishing/buffer-provider");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    return { instance: new BufferProvider("cle-de-test", "À valider", fetchImpl as unknown as typeof fetch), fetchImpl };
  }

  const writes: [string, (instance: PublishingProvider) => Promise<unknown>][] = [
    ["schedulePost", (instance) => instance.schedulePost(post())],
    ["unschedulePost", (instance) => instance.unschedulePost(post({ status: "scheduled" }))],
    ["createDraft", (instance) => instance.createDraft(content)],
    ["updateDraft", (instance) => instance.updateDraft("b1", content)],
    ["rescheduleDraft", (instance) => instance.rescheduleDraft(post(), "2030-02-01T09:00:00.000Z")],
  ];

  it("couvre toutes les opérations d'écriture du contrat", () => {
    expect(writes.map(([name]) => name).sort()).toEqual([...WRITE_METHODS].sort());
  });

  it.each(writes)("%s est refusé sans aucun appel réseau, même avec CADENCE_BUFFER_WRITES=enabled", async (_name, call) => {
    const { instance, fetchImpl } = await realProvider();
    const failure = await call(instance).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toBe(BUFFER_READ_ONLY);
    // Résultat certain : rien n'est parti, aucune réconciliation n'est nécessaire.
    expect((failure as ProviderError).outcome).toBe("failed");
    expect((failure as ProviderError).refusal).toBe("writes_disabled");
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("la configuration ne peut pas rouvrir les écritures en mode réel", async () => {
    const { env } = await import("@/server/env");
    for (const nodeEnv of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      for (const value of ["enabled", "1", "true", "on"]) {
        vi.stubEnv("CADENCE_BUFFER_WRITES", value);
        expect(env.bufferMode).toBe("real");
        expect(env.bufferWritesEnabled, `NODE_ENV=${nodeEnv}, CADENCE_BUFFER_WRITES=${value}`).toBe(false);
      }
    }
  });
});

describe("code source : aucun chemin d'écriture vers Buffer", () => {
  const root = join(__dirname, "..", "..", "src");
  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  const sources = files(root).map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));

  it("le client du vrai Buffer ne contient plus aucune mutation GraphQL", () => {
    const source = sources.find((file) => file.path === "server/publishing/buffer-provider.ts")!.text;
    // Les commentaires peuvent nommer une mutation ; aucune requête ne doit en porter une.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/`\s*mutation\b/);
    expect(code).not.toMatch(/\b(createPost|editPost|deletePost|movePostInQueue|createTag|updateTag|deleteTag|createIdea)\b/);
    expect(code).not.toMatch(/saveToDraft/);
  });

  it("seuls le contrat et ses implémentations nomment une opération d'écriture", () => {
    const allowed = new Set([
      "server/publishing/provider.ts", "server/publishing/buffer-provider.ts", "server/publishing/mock-provider.ts",
      "server/publishing/router.ts",
    ]);
    const offenders = sources
      .filter((file) => !allowed.has(file.path))
      .filter((file) => /\.(schedulePost|unschedulePost|createDraft|updateDraft|rescheduleDraft)\s*\(/.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("l'ancien moteur du Studio n'existe plus : ni module, ni import, ni page", () => {
    expect(sources.filter((file) => /(^|\/)studio/.test(file.path)).map((file) => file.path)).toEqual([]);
    const importers = sources
      .filter((file) => /from\s+["']@\/(server|lib\/domain)\/studio(-actions)?["']|import\(\s*["']@\/server\/studio(-actions)?["']\s*\)/.test(file.text))
      .map((file) => file.path);
    expect(importers).toEqual([]);
  });

  it("aucun module ne réserve une publication pour la programmer", () => {
    const offenders = sources
      .filter((file) => file.path !== "server/compensation.ts")
      .filter((file) => file.text.includes("claim_posts_for_scheduling"))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
    // compensation.ts garde le nom dans un type partagé, mais plus aucun appelant ne le demande.
    const callers = sources.filter((file) => /rpcForMode\(\s*["']claim_posts_for_scheduling["']/.test(file.text)).map((file) => file.path);
    expect(callers).toEqual([]);
  });

  it("les validations, la synchronisation et le démarrage n'importent aucune programmation", () => {
    for (const file of sources) {
      expect(file.text, file.path).not.toMatch(/scheduleApprovedPosts|compensatePendingUnschedules|startUrgentLoop/);
    }
    // Aucune tâche de fond au démarrage : le serveur ne lit Buffer que sur demande ou par le planificateur.
    expect(sources.some((file) => file.path === "instrumentation.ts")).toBe(false);
  });
});
