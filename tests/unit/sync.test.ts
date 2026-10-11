import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";

/*
 * La couche de service, isolée : la base et Buffer sont remplacés par des doublures.
 * La synchronisation lit, constate et met la base à jour. Sa seule écriture vers Buffer est la programmation d'un
 * brouillon approuvé ; elle ne déprogramme, ne crée et ne modifie rien.
 */

const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let claimed: unknown[] = [];
let toUnschedule: unknown[] = [];
/** true : la base n'a pas reçu la migration 0003 (fonctions « _in_mode » absentes). */
let outdatedDatabase = false;
let unresolved: string[] = [];
/** Réponse de la base à une confirmation de programmation. */
let completeOutcome: string | null = null;
/** Pause de quota renvoyée par get_sync_pause (migration 0010). null : aucune. */
let pause: { until: string; reason: string | null } | null = null;
/** Réponse de la base à la demande de verrou (migration 0006). null : fonction absente. */
let lock: Record<string, unknown> | null = null;
const lockCalls: { name: string; params: Record<string, unknown> }[] = [];

let writesEnabled = true;
vi.mock("@/server/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/env")>(),
  env: { automationSecret: "secret-de-test", bufferMode: "mock", get bufferWritesEnabled() { return writesEnabled; } },
}));
vi.mock("@/server/supabase/clients", () => ({
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name === "begin_sync_run" || name === "finish_sync_run") {
        lockCalls.push({ name, params });
        if (!lock) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } };
        return { data: name === "begin_sync_run" ? lock : true, error: null };
      }
      rpcCalls.push({ name, params });
      if (outdatedDatabase && name.endsWith("_in_mode")) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } };
      if (name.startsWith("claim_posts_for_scheduling")) return { data: claimed, error: null };
      if (name.startsWith("list_posts_to_unschedule")) return { data: toUnschedule, error: null };
      if (name === "get_sync_pause") return { data: pause, error: null };
      if (name === "complete_scheduling") return { data: completeOutcome, error: null };
      if (name === "sync_buffer_posts") {
        const first = (params.p_payload as { complete: boolean }).complete;
        return { data: { fetched: 1, created: 0, updated: 1, invalidated: 0, removed: first ? 0 : 1, ...(first ? { unresolved } : {}) }, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

let provider: PublishingProvider & { schedulePost: ReturnType<typeof vi.fn>; unschedulePost: ReturnType<typeof vi.fn>; getPost: ReturnType<typeof vi.fn> };
vi.mock("@/server/publishing", () => ({ getProvider: () => provider }));
const dispatchNotifications = vi.fn(async () => ({}));
vi.mock("@/server/notifications", () => ({ dispatchNotifications }));

/** Appels de la logique métier : le suivi du traitement urgent (verrou, bail, lecture de pause) n'est pas ordonné ici. */
const BOOKKEEPING = new Set(["begin_urgent_run", "finish_urgent_run", "renew_urgent_run", "renew_sync_run", "list_orphan_claims_in_mode", "get_sync_pause"]);
const businessCalls = () => rpcCalls.map((call) => call.name).filter((name) => !BOOKKEEPING.has(name));

const { runSync } = await import("@/server/sync");
const { STILL_SCHEDULED } = await import("@/server/compensation");

const DUE = "2030-01-15T09:00:00.000Z";
const live = (overrides: Partial<ProviderPost> = {}): ProviderPost => ({
  id: "b1", channelId: "c1", service: "twitter", status: "draft", text: "Texte validé", dueAt: DUE, sentAt: null,
  updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [], ...overrides,
});
const claim = (id = "p1", bufferId = "b1") => ({ id, buffer_post_id: bufferId, text: "Texte validé", assets: [], due_at: "2030-01-15T09:00:00+00:00", service: "twitter", token: `jeton-${id}` });
const claimCalls = () => rpcCalls.filter((call) => call.name.startsWith("claim_posts_for_scheduling"));
const unscheduleCompletions = () => rpcCalls.filter((call) => call.name === "complete_unscheduling").map((call) => call.params);

beforeEach(() => {
  writesEnabled = true;
  rpcCalls.length = 0;
  claimed = [];
  toUnschedule = [];
  outdatedDatabase = false;
  unresolved = [];
  completeOutcome = null;
  pause = null;
  lock = null;
  lockCalls.length = 0;
  provider = {
    mode: "mock",
    fetchSnapshot: vi.fn(async () => ({ channels: [], posts: [], complete: true, rateLimit: null })),
    getPost: vi.fn(async () => live()),
    schedulePost: vi.fn(async (post: ProviderPost) => ({ ...post, status: "scheduled" as const })),
    unschedulePost: vi.fn(async (post: ProviderPost) => ({ ...post, status: "draft" as const })),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    rescheduleDraft: vi.fn(),
    findDraftCandidates: vi.fn(async () => ({ candidates: [], complete: true })),
  };
});

describe("programmation des publications approuvées, constat du reste", () => {
  it("programmation coupée sur le serveur : en mode réel, la synchronisation ne réserve rien et n'écrit rien", async () => {
    writesEnabled = false;
    provider = { ...provider, mode: "real" };
    claimed = [claim()];
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: true, scheduled: 0, scheduleFailures: 0, unscheduled: 0, unscheduleFailures: 0 });
    expect(claimCalls()).toHaveLength(0);
    expect(provider.getPost).not.toHaveBeenCalled();
    expect(provider.schedulePost).not.toHaveBeenCalled();
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("une publication approuvée en attente est relue puis programmée ; rien n'est jamais déprogrammé", async () => {
    claimed = [claim()];
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: true, scheduled: 1, scheduleFailures: 0, unscheduled: 0, unscheduleFailures: 0 });
    expect(claimCalls()).toHaveLength(1);
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("cesse de lire Buffer dès que le quota est atteint, et ne tente pas les posts restants — lecture seule", async () => {
    toUnschedule = [claim("p1", "b1"), claim("p2", "b2"), claim("p3", "b3")];
    provider.getPost.mockRejectedValue(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 600));
    const result = await runSync("test");
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, unscheduled: 0, unscheduleFailures: 3 });
    expect(unscheduleCompletions().map((params) => [params.p_post_id, params.p_ok])).toEqual([["p1", false], ["p2", false], ["p3", false]]);
  });

  it("un refus de Buffer sur un post n'empêche pas de constater les suivants — lecture seule", async () => {
    toUnschedule = [claim("p1", "b1"), claim("p2", "b2")];
    provider.getPost.mockImplementation(async (id: string) => {
      if (id === "b1") throw new ProviderError("Buffer a refusé la lecture");
      return live({ id, status: "draft" });
    });
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: false, unscheduled: 1, unscheduleFailures: 1 });
    expect(unscheduleCompletions().map((params) => [params.p_post_id, params.p_ok])).toEqual([["p1", false], ["p2", true]]);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });
});

describe("synchronisation complète", () => {
  it("la synchronisation lit, constate, puis programme l'approuvé : une publication programmée sans accord reste signalée, jamais déprogrammée", async () => {
    toUnschedule = [claim("p9", "b9")];
    claimed = [claim()];
    provider.getPost.mockImplementation(async (id: string) => live({ id, status: id === "b9" ? "scheduled" : "draft" }));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: false, fetched: 1, unscheduled: 0, unscheduleFailures: 1, scheduled: 1, scheduleFailures: 0 });
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
    expect(provider.schedulePost.mock.calls[0][0]).toMatchObject({ id: "b1", status: "draft" });
    // Le constat précède toujours la programmation.
    expect(businessCalls()).toEqual([
      "sync_buffer_posts", "list_posts_to_unschedule_in_mode", "complete_unscheduling",
      "claim_posts_for_scheduling_in_mode", "complete_scheduling", "record_sync_failure",
    ]);
    expect(rpcCalls.find((call) => call.name === "complete_unscheduling")?.params).toMatchObject({ p_post_id: "p9", p_ok: false, p_error: STILL_SCHEDULED });
  });

  it("signale les échecs de déprogrammation et stoppe les appels après un quota", async () => {
    toUnschedule = [claim("p9", "b9"), claim("p8", "b8")];
    claimed = [claim()];
    provider.getPost.mockRejectedValue(new ProviderError("Quota", "rate_limit"));
    expect(await runSync("test")).toMatchObject({ ok: false, unscheduleFailures: 2, unscheduled: 0, scheduled: 0 });
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(provider.schedulePost).not.toHaveBeenCalled();
    expect(rpcCalls.some((call) => call.name === "claim_posts_for_scheduling_in_mode")).toBe(false);
  });

  it("ne perd pas les compteurs du premier passage après une relecture des posts absents", async () => {
    unresolved = ["b1"];
    provider.getPost.mockResolvedValue(live({ status: "sent" }));
    expect(await runSync("test")).toMatchObject({ ok: true, fetched: 1, updated: 2, removed: 1 });
  });

  it("conserve les constats réussis si une lecture échoue ensuite — lecture seule", async () => {
    toUnschedule = [claim("p1", "b1"), claim("p2", "b2")];
    provider.getPost
      .mockResolvedValueOnce(live({ status: "draft" }))
      .mockRejectedValueOnce(new ProviderError("Buffer injoignable", "network"));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: false, fetched: 1, updated: 1, unscheduled: 1, unscheduleFailures: 1 });
    expect(unscheduleCompletions().map((params) => [params.p_post_id, params.p_ok])).toEqual([["p1", true], ["p2", false]]);
  });

  it("mutualise les synchronisations simultanées", async () => {
    const first = runSync("test1");
    const second = runSync("test2");
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("enregistre l'échec et ne programme rien si Buffer est injoignable", async () => {
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(new ProviderError("Buffer injoignable : ECONNRESET", "network"));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: false, error: "Buffer injoignable : ECONNRESET", scheduled: 0 });
    // La reprise des annulations en attente ne dépend pas de la lecture : elle est tentée, rien n'est programmé.
    expect(businessCalls()).toEqual(["list_posts_to_unschedule_in_mode", "record_sync_failure"]);
  });
});

describe("exécutions concurrentes et pauses (migration 0006)", () => {
  const finish = () => lockCalls.find((call) => call.name === "finish_sync_run")?.params;

  it("prend le verrou, synchronise, puis le rend avec le résultat", async () => {
    lock = { acquired: true, token: "jeton" };
    expect(await runSync("planifié", { scheduled: true })).toMatchObject({ ok: true, anomalies: [] });
    expect(lockCalls[0].params).toMatchObject({ p_mode: "mock", p_triggered_by: "planifié", p_scheduled: true });
    expect(finish()).toMatchObject({ p_token: "jeton", p_ok: true, p_error: null, p_backoff_seconds: 0, p_anomalies: [] });
  });

  it("ne fait rien si une autre synchronisation tient le verrou", async () => {
    lock = { acquired: false, reason: "running" };
    const result = await runSync("planifié", { scheduled: true });
    expect(result).toMatchObject({ ok: true, skipped: "running", fetched: 0 });
    expect(provider.fetchSnapshot).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(finish()).toBeUndefined();
  });

  it("ne fait rien pendant une pause, et dit pourquoi", async () => {
    lock = { acquired: false, reason: "backoff", detail: "Quota de requêtes Buffer atteint." };
    expect(await runSync("planifié", { scheduled: true })).toMatchObject({ skipped: "backoff", error: "Quota de requêtes Buffer atteint." });
    expect(provider.fetchSnapshot).not.toHaveBeenCalled();
  });

  it("quota atteint : l'échec est enregistré et les exécutions planifiées sont suspendues le temps demandé par Buffer", async () => {
    lock = { acquired: true, token: "jeton" };
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 1200));
    expect((await runSync("planifié", { scheduled: true })).ok).toBe(false);
    expect(finish()).toMatchObject({ p_ok: false, p_backoff_seconds: 1200 });
    expect(String(finish()?.p_error)).toContain("Quota");
  });

  it("quota presque épuisé : pause préventive, sans échec", async () => {
    lock = { acquired: true, token: "jeton" };
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: [], posts: [], complete: true, rateLimit: { "100-in-15min": 80, "3000-in-30days": 120 } });
    expect((await runSync("planifié", { scheduled: true })).ok).toBe(true);
    expect(finish()).toMatchObject({ p_ok: true, p_backoff_seconds: 21600 });
  });

  it("une panne réseau n'entraîne aucune pause : nouvel essai au passage suivant", async () => {
    lock = { acquired: true, token: "jeton" };
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(new ProviderError("Buffer ne répond pas (délai dépassé).", "network"));
    expect(await runSync("planifié", { scheduled: true })).toMatchObject({ ok: false, error: "Buffer ne répond pas (délai dépassé)." });
    expect(finish()).toMatchObject({ p_ok: false, p_backoff_seconds: 0 });
  });

  it("consigne les anomalies : lecture incomplète et publications programmées sans accord", async () => {
    lock = { acquired: true, token: "jeton" };
    toUnschedule = [claim()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({ channels: [], posts: [], complete: false, rateLimit: null });
    const result = await runSync("planifié", { scheduled: true });
    expect(result.anomalies).toHaveLength(2);
    expect(finish()?.p_anomalies).toEqual(result.anomalies);
  });

  it("remet les notifications en attente à la fin de chaque exécution, même en échec, jamais quand elle est sautée", async () => {
    dispatchNotifications.mockClear();
    lock = { acquired: true, token: "jeton" };
    await runSync("planifié", { scheduled: true });
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ProviderError("Panne", "network"));
    await runSync("planifié", { scheduled: true });
    expect(dispatchNotifications).toHaveBeenCalledTimes(2);
    lock = { acquired: false, reason: "running" };
    await runSync("planifié", { scheduled: true });
    expect(dispatchNotifications).toHaveBeenCalledTimes(2);
  });

  it("base sans la migration 0006 : la synchronisation aboutit avec le seul verrou interne", async () => {
    lock = null;
    expect(await runSync("manuel")).toMatchObject({ ok: true, fetched: 1 });
    expect(lockCalls.map((call) => call.name)).toEqual(["begin_sync_run"]);
  });
});

describe("base sans la migration 0003", () => {
  it("le mode réel se rabat sur les anciennes fonctions pour le constat comme pour la programmation", async () => {
    outdatedDatabase = true;
    provider = { ...provider, mode: "real" };
    claimed = [claim()];
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: true, scheduled: 1, scheduleFailures: 0 });
    expect(businessCalls()).toEqual([
      "sync_buffer_posts", "list_posts_to_unschedule_in_mode", "list_posts_to_unschedule",
      "claim_posts_for_scheduling_in_mode", "claim_posts_for_scheduling", "complete_scheduling",
    ]);
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("le mode réel n'envoie jamais un post simulé à Buffer, ni en lecture ni en écriture — lecture seule", async () => {
    outdatedDatabase = true;
    provider = { ...provider, mode: "real" };
    toUnschedule = [claim("p1", "mock-dev-1"), claim("p2", "b2")];
    provider.getPost.mockImplementation(async (id: string) => live({ id, status: "draft" }));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: true, unscheduled: 1, unscheduleFailures: 0 });
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(provider.getPost).toHaveBeenCalledWith("b2");
    expect(unscheduleCompletions().map((params) => [params.p_post_id, params.p_ok])).toEqual([["p2", true]]);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("le mode simulé refuse de continuer avec un message clair, sans rien réserver", async () => {
    outdatedDatabase = true;
    claimed = [claim()];
    const result = await runSync("test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("La base de données n'est pas à jour");
    expect(rpcCalls.some((call) => call.name === "claim_posts_for_scheduling")).toBe(false);
    expect(provider.schedulePost).not.toHaveBeenCalled();
  });
});

describe("posts programmés absents de la lecture de Buffer", () => {
  const payloads = () => rpcCalls.filter((call) => call.name === "sync_buffer_posts").map((call) => call.params.p_payload as Record<string, unknown>);

  it("relit chaque post : publié, il est mis à jour ; inconnu de Buffer, sa disparition est confirmée", async () => {
    unresolved = ["b-publie", "b-disparu"];
    provider.getPost.mockImplementation(async (id: string) => (id === "b-publie" ? live({ id, status: "sent" }) : null));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: true, updated: 2, removed: 1 });
    expect(payloads()).toHaveLength(2);
    expect(payloads()[1]).toMatchObject({ complete: false, confirmedGone: ["b-disparu"], triggeredBy: "test:contrôle" });
    expect((payloads()[1].posts as ProviderPost[]).map((post) => [post.id, post.status])).toEqual([["b-publie", "sent"]]);
  });

  it("ne conclut rien si Buffer est injoignable pendant la relecture", async () => {
    unresolved = ["b1", "b2"];
    provider.getPost.mockRejectedValue(new ProviderError("Buffer injoignable", "network"));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: true, removed: 0 });
    expect(payloads()).toHaveLength(1);
  });
});

describe("constat, compensation et quotas (audit B4)", () => {
  it("un quota atteint pendant la constatation est propagé avec son délai et enregistré comme pause — lecture seule", async () => {
    toUnschedule = [claim("p1", "b1")];
    provider.getPost.mockRejectedValue(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 900));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: false, unscheduled: 0, unscheduleFailures: 1 });
    expect(rpcCalls.find((call) => call.name === "set_sync_backoff")?.params).toMatchObject({ p_seconds: 900 });
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("la pause demandée par Buffer pendant la constatation est appliquée à la fin de la synchronisation — lecture seule", async () => {
    lock = { acquired: true, token: "t1" };
    toUnschedule = [claim("p1")];
    provider.getPost.mockRejectedValueOnce(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 1200));
    const result = await runSync("test");
    expect(result.ok).toBe(false);
    const finish = lockCalls.find((call) => call.name === "finish_sync_run");
    expect(finish?.params).toMatchObject({ p_backoff_seconds: 1200 });
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("une publication encore programmée n'est jamais déprogrammée par Cadence : elle reste signalée — lecture seule", async () => {
    toUnschedule = [{ id: "p1", buffer_post_id: "b1", text: "", assets: [], due_at: DUE, service: "twitter" }];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    await runSync("test");
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(rpcCalls.find((entry) => entry.name === "complete_unscheduling")?.params).toMatchObject({ p_post_id: "p1", p_ok: false, p_error: STILL_SCHEDULED });
  });

  it("une publication repassée en brouillon à la main est enregistrée d'après le statut constaté — lecture seule", async () => {
    toUnschedule = [{ id: "p1", buffer_post_id: "b1", text: "", assets: [], due_at: DUE, service: "twitter" }];
    provider.getPost.mockResolvedValue(live({ status: "draft" }));
    await runSync("test");
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(rpcCalls.find((entry) => entry.name === "complete_unscheduling")?.params).toMatchObject({ p_ok: true, p_observed_status: "draft" });
  });

  it("une déprogrammation d'un post déjà publié enregistre le statut réel, pas « brouillon »", async () => {
    toUnschedule = [{ id: "p1", buffer_post_id: "b1", text: "", assets: [], due_at: DUE, service: "twitter" }];
    provider.getPost.mockResolvedValue(live({ status: "sent" }));
    await runSync("test");
    const call = rpcCalls.find((entry) => entry.name === "complete_unscheduling");
    expect(call?.params).toMatchObject({ p_post_id: "p1", p_ok: true, p_observed_status: "sent" });
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });
});
