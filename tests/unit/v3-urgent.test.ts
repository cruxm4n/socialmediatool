import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";

/*
 * (Mission V3, C03/T03) Traitement urgent : reprise des annulations à confirmer et des réservations abandonnées,
 * indépendante du poll général. La base et Buffer sont des doublures ; l'horloge est contrôlée pour la boucle.
 */

type Call = { name: string; params: Record<string, unknown> };
const calls: Call[] = [];
let toUnschedule: unknown[] = [];
let orphans: unknown[] = [];
let pause: { until: string; reason: string | null; hard?: boolean } | null = null;
let summary: Record<string, unknown> | null = { pending_unschedule: 0, orphan_claims: 0 };
let urgentLock: Record<string, unknown> | null = { acquired: true, token: "u1" };
let renewAnswer: boolean | null = true;
let completeSchedulingAnswer: string | null = "scheduled";
/** Bail de la synchronisation générale : réponse de renew_sync_run (false : expiré et repris par un autre). */
let syncLease: boolean | null = true;
let claimedForSync: unknown[] = [];

let profile: "pilot" | "standard" = "standard";
vi.mock("@/server/env", () => ({ env: { automationSecret: "secret-de-test", bufferMode: "mock", get profile() { return profile; } } }));
vi.mock("@/server/supabase/clients", () => ({
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      if (name === "begin_sync_run") return { data: { acquired: true, token: "s1" }, error: null };
      if (name === "renew_sync_run") return { data: syncLease, error: null };
      if (name.startsWith("claim_posts_for_scheduling")) return { data: claimedForSync, error: null };
      if (name === "sync_buffer_posts") return { data: { fetched: 0, created: 0, updated: 0, invalidated: 0, removed: 0 }, error: null };
      if (name === "urgent_work_summary") return { data: summary, error: null };
      if (name === "begin_urgent_run") return { data: urgentLock, error: null };
      if (name === "renew_urgent_run") return { data: renewAnswer, error: null };
      if (name === "list_posts_to_unschedule_in_mode") return { data: toUnschedule, error: null };
      if (name === "list_orphan_claims_in_mode") return { data: orphans, error: null };
      if (name === "get_sync_pause") return { data: pause, error: null };
      if (name === "complete_scheduling") return { data: completeSchedulingAnswer, error: null };
      return { data: null, error: null };
    },
  }),
}));

let provider: PublishingProvider & { schedulePost: ReturnType<typeof vi.fn>; unschedulePost: ReturnType<typeof vi.fn>; getPost: ReturnType<typeof vi.fn> };
vi.mock("@/server/publishing", () => ({ getProvider: () => provider }));

const dispatchNotifications = vi.fn(async () => ({}));
vi.mock("@/server/notifications", () => ({ dispatchNotifications }));

const { runUrgent, runUrgentCycle } = await import("@/server/urgent");
const { runSync, scheduleApprovedPosts } = await import("@/server/sync");
const { startUrgentLoop } = await import("@/server/urgent-loop");

const DUE = "2030-01-15T09:00:00.000Z";
const live = (overrides: Partial<ProviderPost> = {}): ProviderPost => ({
  id: "b1", channelId: "c1", service: "twitter", status: "draft", text: "Texte validé", dueAt: DUE, sentAt: null,
  updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [], ...overrides,
});
const pending = (id = "p1", bufferId = "b1") => ({ id, buffer_post_id: bufferId, text: "Texte validé", assets: [], due_at: DUE, service: "twitter" });
const orphan = (id = "p1", bufferId = "b1") => ({ ...pending(id, bufferId), token: `jeton-${id}`, claimed_at: "2030-01-15T08:00:00Z" });
const names = () => calls.map((call) => call.name);
const of = (name: string) => calls.filter((call) => call.name === name).map((call) => call.params);

beforeEach(() => {
  calls.length = 0;
  toUnschedule = [];
  orphans = [];
  pause = null;
  summary = { pending_unschedule: 0, orphan_claims: 0 };
  urgentLock = { acquired: true, token: "u1" };
  renewAnswer = true;
  completeSchedulingAnswer = "scheduled";
  syncLease = true;
  claimedForSync = [];
  profile = "standard";
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

describe("traitement urgent : réveil", () => {
  it("rien à faire : une lecture locale, aucun verrou, aucun appel à Buffer", async () => {
    const result = await runUrgent();
    expect(result).toMatchObject({ ok: true, skipped: "idle" });
    expect(names()).toEqual(["urgent_work_summary"]);
    expect(provider.getPost).not.toHaveBeenCalled();
  });

  it("base sans la migration 0011 : ignoré proprement, jamais une panne", async () => {
    summary = null;
    expect(await runUrgent()).toMatchObject({ ok: true, skipped: "unsupported" });
  });

  it("une annulation en attente est compensée SANS lire l'instantané général de Buffer", async () => {
    summary = { pending_unschedule: 1, orphan_claims: 0 };
    toUnschedule = [pending()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    const result = await runUrgent();
    expect(result).toMatchObject({ ok: true, compensated: 1, compensationFailures: 0 });
    expect(provider.fetchSnapshot).not.toHaveBeenCalled();
    expect(of("complete_unscheduling")).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: true, p_observed_status: "draft" })]);
    expect(of("finish_urgent_run")).toEqual([expect.objectContaining({ p_token: "u1", p_ok: true })]);
  });

  it("un autre traitement urgent est en cours : aucun appel, aucune double annulation", async () => {
    summary = { pending_unschedule: 1, orphan_claims: 0 };
    urgentLock = { acquired: false };
    expect(await runUrgent()).toMatchObject({ ok: true, skipped: "running" });
    expect(provider.getPost).not.toHaveBeenCalled();
  });
});

describe("bail de la synchronisation générale (exécution plus longue que cinq minutes)", () => {
  const claim = (id: string) => ({ id, buffer_post_id: `b-${id}`, text: "Texte validé", assets: [], due_at: DUE, service: "twitter", token: `jeton-${id}` });

  it("bail perdu : le détenteur expiré ne programme plus rien, ne confirme rien comme un nouveau détenteur", async () => {
    claimedForSync = [claim("p1"), claim("p2")];
    syncLease = false;
    provider.getPost.mockResolvedValue(live({ status: "draft" }));
    const result = await runSync("test");
    expect(provider.schedulePost).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    // Les réservations sont libérées avec un échec certain (aucun effet externe), jamais confirmées.
    expect(of("complete_scheduling").every((params) => params.p_ok === false)).toBe(true);
  });

  it("bail renouvelé avant chaque écriture externe", async () => {
    claimedForSync = [claim("p1"), claim("p2")];
    provider.getPost.mockImplementation(async (id: string) => live({ id, status: "draft" }));
    provider.schedulePost.mockImplementation(async (post: ProviderPost) => ({ ...post, status: "scheduled" as const }));
    await runSync("test");
    expect(provider.schedulePost).toHaveBeenCalledTimes(2);
    expect(of("renew_sync_run").length).toBeGreaterThanOrEqual(2);
  });
});

describe("traitement urgent : compensation et quota", () => {
  it("un refus de quota (429) en cours n'est pas contourné : aucun appel, échec durable et visible", async () => {
    toUnschedule = [pending()];
    pause = { until: "2030-01-01T00:00:00Z", reason: "Quota atteint", hard: true };
    const result = await runUrgentCycle(provider);
    expect(provider.getPost).not.toHaveBeenCalled();
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, compensated: 0, compensationFailures: 1 });
    expect(of("complete_unscheduling")).toEqual([expect.objectContaining({ p_ok: false })]);
    expect(of("complete_unscheduling").some((params) => params.p_ok === true)).toBe(false);
  });

  it("une pause préventive (rien n'a été refusé) laisse passer la compensation", async () => {
    toUnschedule = [pending()];
    pause = { until: "2030-01-01T00:00:00Z", reason: "Quota presque épuisé", hard: false };
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    expect(await runUrgentCycle(provider)).toMatchObject({ ok: true, compensated: 1 });
  });

  it("un 429 pendant la compensation pose la pause, n'insiste pas, et n'annonce rien d'annulé", async () => {
    toUnschedule = [pending("p1", "b1"), pending("p2", "b2")];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    provider.unschedulePost.mockRejectedValue(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 172_800));
    const result = await runUrgentCycle(provider);
    expect(result).toMatchObject({ ok: false, compensated: 0, compensationFailures: 2 });
    expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
    expect(of("set_sync_backoff")).toEqual([expect.objectContaining({ p_seconds: 172_800 })]);
    expect(of("complete_unscheduling").every((params) => params.p_ok === false)).toBe(true);
  });

  it("un post déjà publié est enregistré avec son vrai statut, jamais « brouillon »", async () => {
    toUnschedule = [pending()];
    provider.getPost.mockResolvedValue(live({ status: "sent" }));
    await runUrgentCycle(provider);
    expect(of("complete_unscheduling")).toEqual([expect.objectContaining({ p_ok: true, p_observed_status: "sent" })]);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("un bail perdu (expiré puis repris) : le détenteur s'arrête, sans appel externe", async () => {
    toUnschedule = [pending("p1", "b1"), pending("p2", "b2")];
    renewAnswer = false;
    const result = await runUrgentCycle(provider);
    expect(provider.getPost).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe("réservations abandonnées (crash entre l'acceptation par Buffer et la confirmation locale)", () => {
  it("programmé et conforme : confirmé avec le JETON de la tentative", async () => {
    orphans = [orphan()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    await runUrgentCycle(provider);
    expect(of("complete_scheduling")).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: true, p_token: "jeton-p1" })]);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("programmé mais le contenu de Buffer a changé : annulation demandée puis exécutée dans le même passage", async () => {
    orphans = [orphan()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled", text: "Texte retouché dans Buffer" }));
    // La base, après la demande, liste la publication à annuler.
    const original = provider.getPost;
    original.mockImplementation(async () => {
      toUnschedule = [pending()];
      return live({ status: "scheduled", text: "Texte retouché dans Buffer" });
    });
    const result = await runUrgentCycle(provider);
    expect(of("mark_unschedule_needed")).toEqual([expect.objectContaining({ p_post_id: "p1" })]);
    expect(of("complete_scheduling")).toEqual([]);
    expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ compensated: 1 });
  });

  it("confirmation refusée par la base (« stale ») : compensation immédiate", async () => {
    orphans = [orphan()];
    completeSchedulingAnswer = "stale";
    provider.getPost.mockImplementation(async () => {
      toUnschedule = [pending()];
      return live({ status: "scheduled" });
    });
    const result = await runUrgentCycle(provider);
    expect(provider.unschedulePost).toHaveBeenCalledTimes(1);
    expect(result.compensated).toBe(1);
  });

  it("brouillon constaté : échec certain enregistré pour CETTE tentative (jeton)", async () => {
    orphans = [orphan()];
    provider.getPost.mockResolvedValue(live({ status: "draft" }));
    await runUrgentCycle(provider);
    expect(of("complete_scheduling")).toEqual([expect.objectContaining({ p_ok: false, p_token: "jeton-p1" })]);
  });

  it("publié ou en cours de publication : statut enregistré tel quel, jamais « brouillon »", async () => {
    orphans = [orphan()];
    provider.getPost.mockResolvedValue(live({ status: "sending" }));
    await runUrgentCycle(provider);
    expect(String(of("complete_scheduling")[0].p_error)).toContain("sending");
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("lecture impossible : la réservation reste intacte, l'incertitude reste visible", async () => {
    orphans = [orphan()];
    provider.getPost.mockRejectedValue(new ProviderError("Buffer injoignable", "network", undefined, "unknown"));
    const result = await runUrgentCycle(provider);
    expect(of("complete_scheduling")).toEqual([]);
    expect(of("mark_unschedule_needed")).toEqual([]);
    expect(result.ok).toBe(false);
  });
});

describe("boucle de réveil, horloge contrôlée", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("premier passage 5 s après le démarrage, puis toutes les 30 s ; une erreur n'arrête rien", async () => {
    const work = vi.fn().mockRejectedValueOnce(new Error("panne")).mockResolvedValue(null);
    const onError = vi.fn();
    const loop = startUrgentLoop(work, { onError });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work).toHaveBeenCalledTimes(3);
    loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it("jamais deux passages en même temps", async () => {
    let active = 0;
    let max = 0;
    const work = vi.fn(async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 70_000));
      active -= 1;
    });
    const loop = startUrgentLoop(work);
    await vi.advanceTimersByTimeAsync(400_000);
    loop.stop();
    expect(max).toBe(1);
  });

  it("chronologie : une annulation apparue à T+10 s est tentée avant T+60 s, très en deçà du poll de 30 minutes et d'une échéance à T+11 min", async () => {
    summary = { pending_unschedule: 0, orphan_claims: 0 };
    let attemptedAtMs: number | null = null;
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    provider.unschedulePost.mockImplementation(async (post: ProviderPost) => {
      attemptedAtMs = Date.now() - start;
      return { ...post, status: "draft" as const };
    });
    const start = Date.now();
    const loop = startUrgentLoop(() => runUrgent());
    // Invalidation locale à T+10 s (par exemple un accord retiré) ; le serveur redémarre à T+0 et son poll est à T+30 min.
    await vi.advanceTimersByTimeAsync(10_000);
    summary = { pending_unschedule: 1, orphan_claims: 0 };
    toUnschedule = [pending()];
    await vi.advanceTimersByTimeAsync(60_000);
    loop.stop();
    expect(attemptedAtMs).not.toBeNull();
    expect(attemptedAtMs!).toBeLessThanOrEqual(10_000 + 60_000);
    expect(attemptedAtMs!).toBeLessThan(11 * 60_000);
    expect(provider.fetchSnapshot).not.toHaveBeenCalled();
  });
});

describe("profil pilote : échéance d'au moins 24 h, vérifiée à chaque programmation (mission V3)", () => {
  it("la règle pure : plus de 24 h → acceptée ; moins → refusée ; sans date → refusée", async () => {
    const { pilotLeadSatisfied, PILOT_MIN_LEAD_MS } = await import("@/lib/domain/schedule-margins");
    const now = Date.parse("2030-01-01T00:00:00Z");
    expect(pilotLeadSatisfied("2030-01-02T00:00:01Z", now)).toBe(true);
    expect(pilotLeadSatisfied(new Date(now + PILOT_MIN_LEAD_MS).toISOString(), now)).toBe(true);
    expect(pilotLeadSatisfied("2030-01-01T23:59:59Z", now)).toBe(false);
    expect(pilotLeadSatisfied(null, now)).toBe(false);
  });
});

describe("profil pilote : programmation refusée sous 24 h, sans appel à Buffer", () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const claim = (id: string, dueAt: string) => ({ id, buffer_post_id: `b-${id}`, text: "Texte validé", assets: [], due_at: dueAt, service: "twitter", token: `jeton-${id}` });

  it("un accord ancien repris tardivement ne contourne pas la règle", async () => {
    profile = "pilot";
    claimedForSync = [claim("proche", soon), claim("loin", later)];
    provider.getPost.mockImplementation(async (id: string) => live({ id, dueAt: id === "b-proche" ? soon : later }));
    const result = await scheduleApprovedPosts();
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
    expect(provider.getPost).not.toHaveBeenCalledWith("b-proche");
    expect(of("complete_scheduling")).toEqual(expect.arrayContaining([
      expect.objectContaining({ p_post_id: "proche", p_ok: false, p_token: "jeton-proche" }),
    ]));
    expect(result.failures).toBe(1);
  });

  it("profil standard : la marge de 5 minutes de la base reste la seule règle", async () => {
    claimedForSync = [claim("proche", soon)];
    provider.getPost.mockResolvedValue(live({ id: "b-proche", dueAt: soon }));
    await scheduleApprovedPosts();
    expect(provider.schedulePost).toHaveBeenCalledTimes(1);
  });
});
