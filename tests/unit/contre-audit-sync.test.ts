import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";

/*
 * (Deuxième stabilisation) Orchestration de la compensation. La couche de service, isolée : la base et Buffer sont remplacés par des doublures.
 * On vérifie la règle centrale du produit : rien n'est programmé si le contenu présent
 * dans Buffer n'est pas exactement celui que le client a validé.
 */

const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let claimed: unknown[] = [];
let toUnschedule: unknown[] = [];
/** true : la base n'a pas reçu la migration 0003 (fonctions « _in_mode » absentes). */
let outdatedDatabase = false;
let unresolved: string[] = [];
/** Réponse de la base à une confirmation de programmation : « scheduled », « stale »… */
let completeOutcome: string | null = null;
/** Pause de quota renvoyée par get_sync_pause (migration 0010). null : aucune. */
let pause: { until: string; reason: string | null } | null = null;
/** Réponse de la base à la demande de verrou (migration 0006). null : fonction absente. */
let lock: Record<string, unknown> | null = null;
const lockCalls: { name: string; params: Record<string, unknown> }[] = [];

vi.mock("@/server/env", () => ({ env: { automationSecret: "secret-de-test", bufferMode: "mock" } }));
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

const { runSync, scheduleApprovedPosts } = await import("@/server/sync");

const DUE = "2030-01-15T09:00:00.000Z";
const live = (overrides: Partial<ProviderPost> = {}): ProviderPost => ({
  id: "b1", channelId: "c1", service: "twitter", status: "draft", text: "Texte validé", dueAt: DUE, sentAt: null,
  updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [], ...overrides,
});
const claim = (id = "p1", bufferId = "b1") => ({ id, buffer_post_id: bufferId, text: "Texte validé", assets: [], due_at: "2030-01-15T09:00:00+00:00", service: "twitter", token: `jeton-${id}` });

beforeEach(() => {
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


const DUE_SOON = "2030-01-15T09:00:00.000Z";
const unscheduleCalls = () => rpcCalls.filter((call) => call.name === "complete_unscheduling").map((call) => call.params);

describe("compensation d'une programmation devenue illégitime (contre-audit B4)", () => {
  /** Buffer a accepté la programmation, mais la base la déclare périmée : la compensation doit partir tout de suite. */
  const staleClaim = () => {
    claimed = [claim()];
    completeOutcome = "stale";
    provider.schedulePost.mockImplementation(async (post: ProviderPost) => {
      toUnschedule = [claim()];
      provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
      return { ...post, status: "scheduled" as const };
    });
  };

  it("déprogramme immédiatement, dans le même passage, et n'enregistre l'annulation que d'après le statut constaté", async () => {
    staleClaim();
    const result = await runSync("test");
    expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
    expect(unscheduleCalls()).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: true, p_observed_status: "draft" })]);
    expect(result).toMatchObject({ ok: false, unscheduled: 1, unscheduleFailures: 0 });
  });

  it("une compensation refusée par Buffer reste « à confirmer » : rien n'est annoncé annulé, l'échec est visible", async () => {
    staleClaim();
    provider.unschedulePost.mockRejectedValue(new ProviderError("Buffer a refusé la modification : maintenance"));
    const result = await runSync("test");
    expect(unscheduleCalls()).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: false })]);
    expect(unscheduleCalls().some((call) => call.p_ok === true)).toBe(false);
    expect(result).toMatchObject({ ok: false, unscheduled: 0, unscheduleFailures: 1 });
    expect(result.anomalies?.join(" ")).toContain("encore programmée");
  });

  it("reprise durable : l'annulation en attente est tentée AVANT toute programmation au cycle suivant", async () => {
    toUnschedule = [claim()];
    claimed = [claim("p2", "b2")];
    provider.getPost.mockImplementation(async (id: string) => live({ id, status: id === "b1" ? "scheduled" : "draft" }));
    const order: string[] = [];
    provider.unschedulePost.mockImplementation(async (post: ProviderPost) => {
      order.push("unschedule");
      return { ...post, status: "draft" as const };
    });
    provider.schedulePost.mockImplementation(async (post: ProviderPost) => {
      order.push("schedule");
      return { ...post, status: "scheduled" as const };
    });
    await runSync("test");
    expect(order).toEqual(["unschedule", "schedule"]);
  });

  it("la reprise a lieu même quand la lecture de Buffer échoue", async () => {
    toUnschedule = [claim()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(new ProviderError("Buffer injoignable", "network"));
    const result = await runSync("test");
    expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, unscheduled: 1 });
  });

  it("un post déjà publié par Buffer est enregistré « publié », jamais « repassé en brouillon »", async () => {
    toUnschedule = [claim()];
    provider.getPost.mockResolvedValue(live({ status: "sent" }));
    await runSync("test");
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(unscheduleCalls()).toEqual([expect.objectContaining({ p_ok: true, p_observed_status: "sent" })]);
  });

  it("un statut inattendu après la déprogrammation n'est pas une annulation confirmée", async () => {
    toUnschedule = [claim()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    provider.unschedulePost.mockResolvedValue(live({ status: "needs_approval" }));
    const result = await runSync("test");
    expect(unscheduleCalls()).toEqual([expect.objectContaining({ p_ok: false })]);
    expect(result.unscheduleFailures).toBe(1);
  });

  it("un quota atteint pendant la compensation pose la pause, sans insister sur les autres posts", async () => {
    toUnschedule = [claim(), claim("p2", "b2")];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    provider.unschedulePost.mockRejectedValue(new ProviderError("Quota", "rate_limit", 172800));
    await runSync("test");
    expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
    expect(rpcCalls.find((call) => call.name === "set_sync_backoff")?.params).toMatchObject({ p_seconds: 172800 });
  });

  it("une confirmation « remplacée » ou « ignorée » ne compte pas comme une programmation", async () => {
    for (const outcome of ["superseded", "ignored"]) {
      rpcCalls.length = 0;
      claimed = [claim()];
      completeOutcome = outcome;
      const result = await scheduleApprovedPosts("p1");
      expect(result).toMatchObject({ scheduled: 0, failures: 0, stale: false });
    }
  });

  it("une action isolée (approbation) ne programme rien pendant une pause de quota", async () => {
    pause = { until: DUE_SOON, reason: "Quota atteint" };
    claimed = [claim()];
    const result = await scheduleApprovedPosts();
    expect(result.paused).toBeDefined();
    expect(provider.getPost).not.toHaveBeenCalled();
  });
});
