import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUFFER_READ_ONLY, ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";

/*
 * GARANTIE CENTRALE DU PRODUIT : Cadence n'écrit dans Buffer qu'UNE chose — la programmation d'un brouillon que le
 * client vient d'approuver, à la date que ce brouillon porte déjà.
 *
 * Tout le reste reste interdit : créer, modifier un contenu, changer une date, supprimer, repasser en brouillon.
 * Une demande de modification, un commentaire ou une lecture n'écrivent rien.
 *
 * Trois niveaux sont vérifiés : le client du vrai Buffer (une seule mutation peut partir), les actions et la
 * synchronisation (seule `schedulePost` est appelée, et seulement pour un accord valable sur le contenu relu), et le
 * code source (aucun autre chemin d'écriture n'existe).
 */

const FORBIDDEN_WRITES = ["unschedulePost", "createDraft", "updateDraft", "rescheduleDraft"] as const;
const WRITE_METHODS = ["schedulePost", ...FORBIDDEN_WRITES] as const;

const DUE = "2030-01-15T09:00:00.000Z";
const post = (overrides: Partial<ProviderPost> = {}): ProviderPost => ({
  id: "b1", channelId: "c1", service: "twitter", status: "draft", text: "Texte validé", dueAt: DUE, sentAt: null,
  updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [], ...overrides,
});

// --- Doublures : base (session et automatisation) et fournisseur espion ------------------------------------------

const sessionCalls: { name: string; params: Record<string, unknown> }[] = [];
const automationCalls: { name: string; params: Record<string, unknown> }[] = [];
const CLAIM = { id: "p1", buffer_post_id: "b1", text: "Texte validé", assets: [], due_at: DUE, service: "twitter", token: "jeton-p1" };
/** Ce que la base accepte de réserver : un accord valable, sur un brouillon daté. */
let claimable: (typeof CLAIM)[] = [];
let toUnschedule: unknown[] = [];
let decisionError: string | null = null;

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
      return name === "decide_post" && decisionError ? { data: null, error: { message: decisionError } } : { data: {}, error: null };
    },
  }),
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      automationCalls.push({ name, params });
      if (name.startsWith("claim_posts_for_scheduling")) return { data: claimable, error: null };
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
    // Par défaut, Buffer contient exactement le brouillon que le client a validé.
    getPost: vi.fn(async () => post()),
    schedulePost: vi.fn(async (item: ProviderPost) => ({ ...item, status: "scheduled" as const })),
    // Si une écriture interdite était appelée, elle « réussirait » : le test échouerait alors sur le nombre d'appels.
    unschedulePost: vi.fn(async (item: ProviderPost) => ({ ...item, status: "draft" as const })),
    createDraft: vi.fn(async () => post()),
    updateDraft: vi.fn(async () => post()),
    rescheduleDraft: vi.fn(async () => post()),
    findDraftCandidates: vi.fn(async () => ({ candidates: [], complete: true })),
  } as Spy;
}

const named = (name: string) => automationCalls.filter((call) => call.name === name);
const claims = () => automationCalls.filter((call) => call.name.startsWith("claim_posts_for_scheduling"));

function expectNoForbiddenWrite() {
  for (const method of FORBIDDEN_WRITES) expect(provider[method], `appel inattendu de ${method}`).toHaveBeenCalledTimes(0);
}

function expectNoWrite() {
  expectNoForbiddenWrite();
  expect(provider.schedulePost, "appel inattendu de schedulePost").toHaveBeenCalledTimes(0);
}

const POST_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  sessionCalls.length = 0;
  automationCalls.length = 0;
  claimable = [CLAIM];
  toUnschedule = [];
  decisionError = null;
  provider = spyProvider("real");
  vi.stubEnv("AUTOMATION_SECRET", "secret-de-test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "cle-de-test");
  vi.stubEnv("BUFFER_MODE", "real");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(["real", "mock"] as const)("décisions du client, fournisseur %s", (mode) => {
  beforeEach(() => {
    provider = spyProvider(mode);
  });

  it("approuver une publication la programme aussitôt dans Buffer, à sa date, après relecture du brouillon", async () => {
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(result).toEqual({ ok: true, message: "Publication approuvée et programmée dans Buffer." });
    expect(sessionCalls).toEqual([{ name: "decide_post", params: { p_post_id: POST_ID, p_decision: "approved", p_expected_hash: "empreinte", p_comment: null } }]);
    // La base ne réserve que CETTE publication ; le brouillon est relu, puis programmé tel quel.
    expect(claims().map((call) => call.params.p_post_id)).toEqual([POST_ID]);
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(provider.getPost).toHaveBeenCalledWith("b1");
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
    expect(provider.schedulePost).toHaveBeenCalledWith(post());
    // La confirmation représente le jeton de la réservation.
    expect(named("complete_scheduling").map((call) => call.params)).toEqual([{ p_secret: "secret-de-test", p_post_id: "p1", p_ok: true, p_token: "jeton-p1" }]);
    expectNoForbiddenWrite();
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(0);
  });

  it("contenu modifié dans Buffer depuis l'accord : rien n'est programmé, l'accord reste enregistré, le message le dit", async () => {
    provider.getPost.mockResolvedValue(post({ text: "Texte retouché après l'accord" }));
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("n'a pas abouti");
    expectNoWrite();
    expect(named("complete_scheduling").map((call) => [call.params.p_ok, call.params.p_token])).toEqual([[false, "jeton-p1"]]);
    expect(String(named("complete_scheduling")[0].params.p_error)).toContain("modifié dans Buffer depuis la validation");
  });

  it("date modifiée dans Buffer depuis l'accord : rien n'est programmé", async () => {
    provider.getPost.mockResolvedValue(post({ dueAt: "2030-02-01T09:00:00.000Z" }));
    const { approvePost } = await import("@/server/actions");
    await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expectNoWrite();
  });

  it("brouillon disparu de Buffer : rien n'est programmé", async () => {
    provider.getPost.mockResolvedValue(null);
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(result.message).toContain("n'a pas abouti");
    expectNoWrite();
  });

  it("déjà programmé dans Buffer avec le contenu validé : constaté, sans nouvelle écriture", async () => {
    provider.getPost.mockResolvedValue(post({ status: "scheduled" }));
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(result.message).toBe("Publication approuvée et programmée dans Buffer.");
    expectNoWrite();
    expect(named("complete_scheduling").map((call) => call.params.p_ok)).toEqual([true]);
  });

  it("publié ou en erreur dans Buffer : jamais reprogrammé", async () => {
    const { approvePost } = await import("@/server/actions");
    for (const status of ["sent", "error", "sending", "needs_approval"] as const) {
      provider.getPost.mockResolvedValue(post({ status }));
      await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    }
    expectNoWrite();
  });

  it("brouillon sans date (rien de réservable) : l'accord est enregistré, rien n'est envoyé à Buffer", async () => {
    claimable = [];
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(result).toEqual({ ok: true, message: "Publication approuvée. Elle n'a pas encore de date de publication (ou sa date est trop proche) : votre agence la programmera dans Buffer." });
    expectNoWrite();
    expect(provider.getPost).toHaveBeenCalledTimes(0);
  });

  it("Buffer refuse ou ne répond pas : l'accord reste enregistré, l'échec est consigné, jamais annoncé comme programmé", async () => {
    provider.schedulePost.mockRejectedValueOnce(new ProviderError("Buffer a refusé la programmation : limite atteinte"));
    provider.schedulePost.mockRejectedValueOnce(new ProviderError("Buffer ne répond pas (délai dépassé).", "network", undefined, "unknown"));
    const { approvePost } = await import("@/server/actions");
    const refused = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    const lost = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(refused.message).toContain("n'a pas abouti");
    expect(lost.message).toContain("n'a pas abouti");
    const completions = named("complete_scheduling").map((call) => call.params);
    expect(completions.map((params) => params.p_ok)).toEqual([false, false]);
    // Réponse perdue : résultat incertain, la réservation n'est pas déclarée en échec certain.
    expect(completions[0].p_uncertain).toBeUndefined();
    expect(completions[1].p_uncertain).toBe(true);
  });

  it("une décision refusée par la base ne déclenche aucune programmation", async () => {
    decisionError = "stale_version";
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "ancienne" });
    expect(result.ok).toBe(false);
    expect(claims()).toEqual([]);
    expectNoWrite();
    expect(provider.getPost).toHaveBeenCalledTimes(0);
  });

  it("approuver plusieurs publications programme celles que la base réserve, une fois chacune", async () => {
    claimable = [CLAIM, { ...CLAIM, id: "p2", buffer_post_id: "b2", token: "jeton-p2" }];
    provider.getPost.mockImplementation(async (id: string) => post({ id }));
    const { approvePosts } = await import("@/server/actions");
    const result = await approvePosts([{ postId: POST_ID, expectedHash: "a" }, { postId: OTHER_ID, expectedHash: "b" }]);
    expect(result).toMatchObject({ ok: true, approved: 2, refused: [] });
    expect(sessionCalls.map((call) => [call.name, call.params.p_post_id, call.params.p_decision])).toEqual([
      ["decide_post", POST_ID, "approved"],
      ["decide_post", OTHER_ID, "approved"],
    ]);
    expect(claims()).toHaveLength(1);
    expect(provider.schedulePost.mock.calls.map(([item]) => (item as ProviderPost).id)).toEqual(["b1", "b2"]);
    expectNoForbiddenWrite();
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

describe("interrupteur de la programmation (CADENCE_BUFFER_SCHEDULING=off)", () => {
  it("vrai Buffer, programmation coupée : l'accord est enregistré, rien n'est réservé ni envoyé", async () => {
    vi.stubEnv("CADENCE_BUFFER_SCHEDULING", "off");
    const { approvePost } = await import("@/server/actions");
    const result = await approvePost({ postId: POST_ID, expectedHash: "empreinte" });
    expect(result).toEqual({ ok: true, message: "Publication approuvée. Votre agence la programmera dans Buffer." });
    expect(claims()).toEqual([]);
    expectNoWrite();
    expect(provider.getPost).toHaveBeenCalledTimes(0);
  });

  it("la programmation est active par défaut en mode réel ; seule « off » la coupe ; l'ancienne variable est ignorée", async () => {
    const { env } = await import("@/server/env");
    expect(env.bufferMode).toBe("real");
    expect(env.bufferWritesEnabled).toBe(true);
    vi.stubEnv("CADENCE_BUFFER_WRITES", "disabled");
    expect(env.bufferWritesEnabled).toBe(true);
    vi.stubEnv("CADENCE_BUFFER_SCHEDULING", "off");
    expect(env.bufferWritesEnabled).toBe(false);
  });
});

describe.each(["real", "mock"] as const)("synchronisation, fournisseur %s", (mode) => {
  beforeEach(() => {
    provider = spyProvider(mode);
  });

  it("reprend les publications approuvées pas encore programmées (accord donné pendant une panne, date fixée après l'accord)", async () => {
    const { runSync } = await import("@/server/sync");
    const result = await runSync("manuel");
    expect(result).toMatchObject({ ok: true, fetched: 1, updated: 1, scheduled: 1, scheduleFailures: 0, unscheduled: 0, unscheduleFailures: 0 });
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
    expect(claims().map((call) => call.params.p_post_id)).toEqual([null]);
    expectNoForbiddenWrite();
  });

  it("rien d'approuvé en attente : la synchronisation n'écrit rien", async () => {
    claimable = [];
    const { runSync } = await import("@/server/sync");
    const result = await runSync("planificateur", { scheduled: true });
    expect(result).toMatchObject({ ok: true, scheduled: 0, scheduleFailures: 0 });
    expectNoWrite();
  });

  it("un échec de programmation rend la synchronisation partielle et le dit", async () => {
    provider.schedulePost.mockRejectedValue(new ProviderError("Buffer a refusé la programmation : limite atteinte"));
    const { runSync } = await import("@/server/sync");
    const result = await runSync("manuel");
    expect(result).toMatchObject({ ok: false, scheduled: 0, scheduleFailures: 1 });
    expect(result.error).toContain("n'ont pas pu être programmées dans Buffer");
  });

  it("publication programmée sans accord valable : signalée, jamais déprogrammée par Cadence", async () => {
    claimable = [];
    toUnschedule = [{ id: "p9", buffer_post_id: "b9", text: "Texte", assets: [], due_at: DUE, service: "twitter" }];
    provider.getPost.mockResolvedValue(post({ id: "b9", status: "scheduled" }));
    const { runSync } = await import("@/server/sync");
    const { STILL_SCHEDULED } = await import("@/server/compensation");
    const result = await runSync("manuel");
    expect(result).toMatchObject({ ok: false, unscheduled: 0, unscheduleFailures: 1 });
    expect(result.error).toContain("repassez-les en brouillon dans Buffer");
    // Une lecture pour constater, aucune écriture.
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(provider.getPost).toHaveBeenCalledWith("b9");
    expect(named("complete_unscheduling").map((call) => call.params)).toEqual([
      { p_secret: "secret-de-test", p_post_id: "p9", p_ok: false, p_error: STILL_SCHEDULED },
    ]);
    expectNoWrite();
  });

  it("retour en brouillon fait à la main dans Buffer : constaté et enregistré, sans écriture", async () => {
    claimable = [];
    toUnschedule = [{ id: "p9", buffer_post_id: "b9", text: "Texte", assets: [], due_at: DUE, service: "twitter" }];
    provider.getPost.mockResolvedValue(post({ id: "b9", status: "draft" }));
    const { runSync } = await import("@/server/sync");
    const result = await runSync("manuel");
    expect(result).toMatchObject({ ok: true, unscheduled: 1, unscheduleFailures: 0 });
    expect(named("complete_unscheduling").map((call) => call.params)).toEqual([
      { p_secret: "secret-de-test", p_post_id: "p9", p_ok: true, p_observed_status: "draft" },
    ]);
    expectNoWrite();
  });
});

describe("vrai Buffer : une seule mutation peut quitter le serveur", () => {
  const content = { channelId: "c1", service: "twitter", text: "Bonjour", dueAt: DUE, assets: [] };
  const scheduledAnswer = {
    data: { editPost: { __typename: "PostActionSuccess", post: { id: "b1", status: "scheduled", text: "Texte validé", dueAt: DUE, sentAt: null, updatedAt: null, externalLink: null, channelId: "c1", channelService: "twitter", schedulingType: "automatic", error: null, tags: [], assets: [] } } },
  };

  async function realProvider() {
    const { BufferProvider } = await import("@/server/publishing/buffer-provider");
    const fetchImpl = vi.fn(async (...args: [unknown, RequestInit?]) => { void args; return new Response(JSON.stringify(scheduledAnswer), { status: 200 }); });
    return { instance: new BufferProvider("cle-de-test", "À valider", fetchImpl as unknown as typeof fetch), fetchImpl };
  }

  const forbidden: [string, (instance: PublishingProvider) => Promise<unknown>][] = [
    ["unschedulePost", (instance) => instance.unschedulePost(post({ status: "scheduled" }))],
    ["createDraft", (instance) => instance.createDraft(content)],
    ["updateDraft", (instance) => instance.updateDraft("b1", content)],
    ["rescheduleDraft", (instance) => instance.rescheduleDraft(post(), "2030-02-01T09:00:00.000Z")],
  ];

  it("couvre toutes les opérations d'écriture du contrat", () => {
    expect(["schedulePost", ...forbidden.map(([name]) => name)].sort()).toEqual([...WRITE_METHODS].sort());
  });

  it.each(forbidden)("%s est refusé sans aucun appel réseau", async (_name, call) => {
    const { instance, fetchImpl } = await realProvider();
    const failure = await call(instance).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toBe(BUFFER_READ_ONLY);
    // Résultat certain : rien n'est parti, aucune réconciliation n'est nécessaire.
    expect((failure as ProviderError).outcome).toBe("failed");
    expect((failure as ProviderError).refusal).toBe("writes_disabled");
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("schedulePost envoie UNE requête : editPost, passage en « programmé » à la date du brouillon, rien d'autre", async () => {
    const { instance, fetchImpl } = await realProvider();
    const result = await instance.schedulePost(post());
    expect(result.status).toBe("scheduled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.query).toMatch(/^mutation SchedulePost/);
    expect(body.query).toContain("editPost(input: $input)");
    expect(body.variables).toEqual({ input: { id: "b1", saveToDraft: false, mode: "customScheduled", schedulingType: "automatic", dueAt: DUE, text: "Texte validé" } });
  });

  it("toute autre mutation est refusée par le dernier garde-fou, avant de quitter le serveur", async () => {
    const { instance, fetchImpl } = await realProvider();
    const send = (instance as unknown as { send(query: string, variables: Record<string, unknown>): Promise<unknown> }).send.bind(instance);
    for (const query of [
      "mutation { deletePost(input: { id: \"b1\" }) { __typename } }",
      "mutation Create($input: CreatePostInput!) { createPost(input: $input) { __typename } }",
      "mutation SchedulePost($input: EditPostInput!) { editPost(input: $input) { __typename } }",
    ]) {
      const failure = await send(query, {}).then(() => null, (error: unknown) => error);
      expect(failure, query).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).refusal).toBe("writes_disabled");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});

describe("code source : un seul chemin d'écriture vers Buffer", () => {
  const root = join(__dirname, "..", "..", "src");
  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  const sources = files(root).map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));
  const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("le client du vrai Buffer contient exactement une mutation GraphQL : la programmation", () => {
    const code = withoutComments(sources.find((file) => file.path === "server/publishing/buffer-provider.ts")!.text);
    expect(code.match(/`\s*mutation\b/g)).toHaveLength(1);
    expect(code).toMatch(/`mutation SchedulePost\(/);
    expect(code).not.toMatch(/\b(createPost|deletePost|movePostInQueue|createTag|updateTag|deleteTag|createIdea|tagIds)\b/);
    // Jamais de retour en brouillon : la seule valeur écrite est « false ».
    expect(code.match(/saveToDraft[^,}\n]*/g)).toEqual(["saveToDraft: false"]);
  });

  it("seule la programmation après accord appelle une écriture du fournisseur ; les autres n'ont aucun appelant", () => {
    const contract = new Set([
      "server/publishing/provider.ts", "server/publishing/buffer-provider.ts", "server/publishing/mock-provider.ts",
      "server/publishing/router.ts",
    ]);
    const outside = sources.filter((file) => !contract.has(file.path));
    expect(outside.filter((file) => /\.schedulePost\s*\(/.test(file.text)).map((file) => file.path)).toEqual(["server/sync.ts"]);
    expect(outside.filter((file) => /\.(unschedulePost|createDraft|updateDraft|rescheduleDraft)\s*\(/.test(file.text)).map((file) => file.path)).toEqual([]);
  });

  it("la réservation d'une publication à programmer n'est demandée qu'à un endroit", () => {
    const callers = sources.filter((file) => /rpcForMode\(\s*["']claim_posts_for_scheduling["']/.test(file.text)).map((file) => file.path);
    expect(callers).toEqual(["server/sync.ts"]);
    const users = sources.filter((file) => /scheduleApprovedPosts/.test(file.text)).map((file) => file.path).sort();
    expect(users).toEqual(["server/actions.ts", "server/sync.ts"]);
  });

  it("l'ancien moteur du Studio n'existe plus : ni module, ni import, ni page", () => {
    expect(sources.filter((file) => /(^|\/)studio/.test(file.path)).map((file) => file.path)).toEqual([]);
    const importers = sources
      .filter((file) => /from\s+["']@\/(server|lib\/domain)\/studio(-actions)?["']|import\(\s*["']@\/server\/studio(-actions)?["']\s*\)/.test(file.text))
      .map((file) => file.path);
    expect(importers).toEqual([]);
  });

  it("aucune tâche de fond au démarrage, aucune déprogrammation automatique", () => {
    for (const file of sources) {
      expect(file.text, file.path).not.toMatch(/compensatePendingUnschedules|startUrgentLoop/);
    }
    expect(sources.some((file) => file.path === "instrumentation.ts")).toBe(false);
  });
});
