import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";

/*
 * La couche de service, isolée : la base et Buffer sont remplacés par des doublures.
 * On vérifie la règle centrale du produit : rien n'est programmé si le contenu présent
 * dans Buffer n'est pas exactement celui que le client a validé.
 */

const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let claimed: unknown[] = [];
let toUnschedule: unknown[] = [];

vi.mock("@/server/env", () => ({ env: { automationSecret: "secret-de-test", bufferMode: "mock" } }));
vi.mock("@/server/supabase/clients", () => ({
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === "claim_posts_for_scheduling") return { data: claimed, error: null };
      if (name === "list_posts_to_unschedule") return { data: toUnschedule, error: null };
      if (name === "sync_buffer_posts") return { data: { fetched: 1, created: 0, updated: 1, invalidated: 0, removed: 0 }, error: null };
      return { data: null, error: null };
    },
  }),
}));

let provider: PublishingProvider & { schedulePost: ReturnType<typeof vi.fn>; unschedulePost: ReturnType<typeof vi.fn>; getPost: ReturnType<typeof vi.fn> };
vi.mock("@/server/publishing", () => ({ getProvider: () => provider }));

const { runSync, scheduleApprovedPosts } = await import("@/server/sync");

const DUE = "2030-01-15T09:00:00.000Z";
const live = (overrides: Partial<ProviderPost> = {}): ProviderPost => ({
  id: "b1", channelId: "c1", service: "twitter", status: "draft", text: "Texte validé", dueAt: DUE, sentAt: null,
  updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [], ...overrides,
});
const claim = (id = "p1", bufferId = "b1") => ({ id, buffer_post_id: bufferId, text: "Texte validé", assets: [], due_at: "2030-01-15T09:00:00+00:00", service: "twitter" });
const completions = () => rpcCalls.filter((call) => call.name === "complete_scheduling").map((call) => [call.params.p_post_id, call.params.p_ok]);

beforeEach(() => {
  rpcCalls.length = 0;
  claimed = [];
  toUnschedule = [];
  provider = {
    mode: "mock",
    fetchSnapshot: vi.fn(async () => ({ channels: [], posts: [], complete: true, rateLimit: null })),
    getPost: vi.fn(async () => live()),
    schedulePost: vi.fn(async (post: ProviderPost) => ({ ...post, status: "scheduled" as const })),
    unschedulePost: vi.fn(async (post: ProviderPost) => ({ ...post, status: "draft" as const })),
  };
});

describe("programmation des posts approuvés", () => {
  it("programme un post dont le contenu Buffer est identique au contenu validé", async () => {
    claimed = [claim()];
    const result = await scheduleApprovedPosts("p1");
    expect(result).toEqual({ scheduled: 1, failures: 0, stale: false });
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
    expect(completions()).toEqual([["p1", true]]);
    expect(rpcCalls[0].params).toMatchObject({ p_secret: "secret-de-test", p_post_id: "p1" });
  });

  it.each([
    ["le texte", { text: "Texte changé dans Buffer" }],
    ["la date", { dueAt: "2030-01-16T09:00:00.000Z" }],
    ["les médias", { assets: [{ type: "image" as const, source: "https://img/nouveau.jpg", thumbnail: "" }] }],
  ])("ne programme rien si %s a changé dans Buffer depuis la validation", async (_label, change) => {
    claimed = [claim()];
    provider.getPost.mockResolvedValue(live(change));
    const result = await scheduleApprovedPosts("p1");
    expect(provider.schedulePost).not.toHaveBeenCalled();
    expect(result).toEqual({ scheduled: 0, failures: 1, stale: true });
    expect(completions()).toEqual([["p1", false]]);
  });

  it("ne programme rien si le post a disparu de Buffer ou n'est plus un brouillon", async () => {
    claimed = [claim("p1"), claim("p2", "b2")];
    provider.getPost.mockResolvedValueOnce(null).mockResolvedValueOnce(live({ id: "b2", status: "sent" }));
    const result = await scheduleApprovedPosts();
    expect(provider.schedulePost).not.toHaveBeenCalled();
    expect(result.failures).toBe(2);
  });

  it("ne reprogramme pas un post déjà programmé dans Buffer avec le bon contenu", async () => {
    claimed = [claim()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    expect(await scheduleApprovedPosts("p1")).toMatchObject({ scheduled: 1, failures: 0 });
    expect(provider.schedulePost).not.toHaveBeenCalled();
  });

  it("ne fait rien quand la base ne réserve aucun post (non approuvé, déjà réservé…)", async () => {
    claimed = [];
    expect(await scheduleApprovedPosts("p1")).toEqual({ scheduled: 0, failures: 0, stale: false });
    expect(provider.getPost).not.toHaveBeenCalled();
  });

  it("cesse d'appeler Buffer dès que le quota est atteint, et libère les posts restants", async () => {
    claimed = [claim("p1"), claim("p2", "b2"), claim("p3", "b3")];
    provider.getPost.mockRejectedValue(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 600));
    const result = await scheduleApprovedPosts();
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(result.failures).toBe(3);
    expect(completions()).toEqual([["p1", false], ["p2", false], ["p3", false]]);
  });

  it("un refus de Buffer sur un post n'empêche pas de traiter les suivants", async () => {
    claimed = [claim("p1"), claim("p2", "b2")];
    provider.getPost.mockImplementation(async (id: string) => live({ id }));
    provider.schedulePost.mockRejectedValueOnce(new ProviderError("Buffer a refusé la modification")).mockImplementation(async (post: ProviderPost) => ({ ...post, status: "scheduled" as const }));
    const result = await scheduleApprovedPosts();
    expect(result).toMatchObject({ scheduled: 1, failures: 1 });
    expect(completions()).toEqual([["p1", false], ["p2", true]]);
  });
});

describe("synchronisation complète", () => {
  it("enchaîne lecture, déprogrammation puis programmation", async () => {
    toUnschedule = [claim("p9", "b9")];
    claimed = [claim()];
    provider.getPost.mockImplementation(async (id: string) => live({ id, status: id === "b9" ? "scheduled" : "draft" }));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: true, fetched: 1, unscheduled: 1, scheduled: 1 });
    expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "sync_buffer_posts", "list_posts_to_unschedule", "complete_unscheduling", "claim_posts_for_scheduling", "complete_scheduling",
    ]);
  });

  it("relit Buffer quand un contenu modifié est détecté au moment de programmer", async () => {
    claimed = [claim()];
    provider.getPost.mockResolvedValue(live({ text: "Changé" }));
    await runSync("test");
    expect(rpcCalls.filter((call) => call.name === "sync_buffer_posts")).toHaveLength(2);
  });

  it("enregistre l'échec et ne programme rien si Buffer est injoignable", async () => {
    (provider.fetchSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(new ProviderError("Buffer injoignable : ECONNRESET", "network"));
    const result = await runSync("test");
    expect(result).toMatchObject({ ok: false, error: "Buffer injoignable : ECONNRESET", scheduled: 0 });
    expect(rpcCalls.map((call) => call.name)).toEqual(["record_sync_failure"]);
  });
});
