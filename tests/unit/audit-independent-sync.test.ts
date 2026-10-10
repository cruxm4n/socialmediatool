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
/** true : la base n'a pas reçu la migration 0003 (fonctions « _in_mode » absentes). */
let outdatedDatabase = false;
let unresolved: string[] = [];
/** Réponse de la base à une confirmation de programmation : « scheduled », « stale »… */
let completeOutcome: string | null = null;
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
const completions = () => rpcCalls.filter((call) => call.name === "complete_scheduling").map((call) => [call.params.p_post_id, call.params.p_ok]);

beforeEach(() => {
  rpcCalls.length = 0;
  claimed = [];
  toUnschedule = [];
  outdatedDatabase = false;
  unresolved = [];
  completeOutcome = null;
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

describe("Contre-audit indépendant orchestration",()=>{
 it("une réservation périmée acceptée par Buffer doit être compensée avant la fin de la synchronisation",async()=>{
  claimed=[claim()];completeOutcome="stale";
  provider.schedulePost.mockImplementation(async(post:ProviderPost)=>{
    toUnschedule=[claim()];provider.getPost.mockResolvedValue(live({status:"scheduled"}));return {...post,status:"scheduled" as const};
  });
  const r=await runSync("contre-audit");expect(r.ok).toBe(false);
  expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
 });
});
