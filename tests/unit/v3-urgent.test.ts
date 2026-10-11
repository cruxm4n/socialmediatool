import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";

/*
 * (Mission V3, C03/T03) Traitement urgent : constat des annulations à confirmer et des réservations abandonnées,
 * indépendant du poll général. Lecture seule vis-à-vis de Buffer. La base et Buffer sont des doublures ; l'horloge
 * est contrôlée pour la boucle.
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
const { runSync } = await import("@/server/sync");
const { STILL_SCHEDULED } = await import("@/server/compensation");

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

  it("une annulation en attente est constatée SANS lire l'instantané général de Buffer : déjà brouillon, elle est enregistrée — lecture seule", async () => {
    summary = { pending_unschedule: 1, orphan_claims: 0 };
    toUnschedule = [pending()];
    provider.getPost.mockResolvedValue(live({ status: "draft" }));
    const result = await runUrgent();
    expect(result).toMatchObject({ ok: true, compensated: 1, compensationFailures: 0 });
    expect(provider.fetchSnapshot).not.toHaveBeenCalled();
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(of("complete_unscheduling")).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: true, p_observed_status: "draft" })]);
    expect(of("finish_urgent_run")).toEqual([expect.objectContaining({ p_token: "u1", p_ok: true })]);
  });

  it("une annulation encore programmée n'est jamais déprogrammée : elle reste « à confirmer » — lecture seule", async () => {
    summary = { pending_unschedule: 1, orphan_claims: 0 };
    toUnschedule = [pending()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled" }));
    const result = await runUrgent();
    expect(result).toMatchObject({ ok: false, compensated: 0, compensationFailures: 1 });
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(of("complete_unscheduling")).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: false, p_error: STILL_SCHEDULED })]);
  });

  it("un autre traitement urgent est en cours : aucun appel, aucune double annulation", async () => {
    summary = { pending_unschedule: 1, orphan_claims: 0 };
    urgentLock = { acquired: false };
    expect(await runUrgent()).toMatchObject({ ok: true, skipped: "running" });
    expect(provider.getPost).not.toHaveBeenCalled();
  });
});

describe("bail de la synchronisation générale (exécution plus longue que cinq minutes)", () => {
  it("bail perdu : le détenteur expiré ne constate rien, n'écrit rien, et ne consigne aucune annulation comme faite — lecture seule", async () => {
    toUnschedule = [pending("p1", "b-p1"), pending("p2", "b-p2")];
    syncLease = false;
    const result = await runSync("test");
    expect(provider.getPost).not.toHaveBeenCalled();
    expect(provider.schedulePost).not.toHaveBeenCalled();
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(of("complete_unscheduling")).toEqual([]);
    expect(result).toMatchObject({ ok: false, unscheduled: 0, unscheduleFailures: 2 });
  });

  it("bail renouvelé avant chaque lecture externe — lecture seule", async () => {
    toUnschedule = [pending("p1", "b-p1"), pending("p2", "b-p2")];
    provider.getPost.mockImplementation(async (id: string) => live({ id, status: "scheduled" }));
    await runSync("test");
    expect(provider.getPost).toHaveBeenCalledTimes(2);
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

  it("une pause préventive (rien n'a été refusé) laisse passer le constat — lecture seule", async () => {
    toUnschedule = [pending()];
    pause = { until: "2030-01-01T00:00:00Z", reason: "Quota presque épuisé", hard: false };
    provider.getPost.mockResolvedValue(live({ status: "draft" }));
    expect(await runUrgentCycle(provider)).toMatchObject({ ok: true, compensated: 1 });
    expect(provider.getPost).toHaveBeenCalledTimes(1);
  });

  it("un 429 pendant le constat pose la pause, n'insiste pas, et n'annonce rien de constaté", async () => {
    toUnschedule = [pending("p1", "b1"), pending("p2", "b2")];
    provider.getPost.mockRejectedValue(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 172_800));
    const result = await runUrgentCycle(provider);
    expect(result).toMatchObject({ ok: false, compensated: 0, compensationFailures: 2 });
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
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

  it("programmé mais le contenu de Buffer a changé : annulation demandée, puis constatée dans le même passage sans déprogrammation — lecture seule", async () => {
    orphans = [orphan()];
    // La lecture de la réservation révèle le contenu modifié ; la base liste ensuite la publication à confirmer.
    provider.getPost.mockImplementation(async () => {
      toUnschedule = [pending()];
      return live({ status: "scheduled", text: "Texte retouché dans Buffer" });
    });
    const result = await runUrgentCycle(provider);
    expect(of("mark_unschedule_needed")).toEqual([expect.objectContaining({ p_post_id: "p1" })]);
    expect(of("complete_scheduling")).toEqual([]);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(of("complete_unscheduling")).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: false, p_error: STILL_SCHEDULED })]);
    expect(result).toMatchObject({ ok: false, compensated: 0, compensationFailures: 1 });
  });

  // Toute différence avec ce que le client a validé invalide une programmation constatée : tag retiré, texte, date
  // (jusqu'à la seconde) ou médias. Aucune n'est confirmée, et rien n'est écrit dans Buffer.
  it.each<[string, Partial<ProviderPost>]>([
    ["le tag de validation a été retiré", { hasReviewTag: false }],
    ["la date diffère de quelques secondes", { dueAt: "2030-01-15T09:00:30.000Z" }],
    ["le texte a changé", { text: "Texte retouché dans Buffer" }],
    ["la date a changé", { dueAt: "2030-01-16T09:00:00.000Z" }],
    ["les médias ont changé", { assets: [{ type: "image", source: "https://img/autre.jpg", thumbnail: "https://img/autre-t.jpg" }] }],
  ])("programmé mais %s : jamais confirmé, annulation demandée, aucune écriture — lecture seule", async (_what, difference) => {
    orphans = [orphan()];
    provider.getPost.mockResolvedValue(live({ status: "scheduled", ...difference }));
    await runUrgentCycle(provider);
    expect(of("mark_unschedule_needed")).toEqual([expect.objectContaining({ p_post_id: "p1" })]);
    expect(of("complete_scheduling")).toEqual([]);
    expect(provider.schedulePost).not.toHaveBeenCalled();
    expect(provider.unschedulePost).not.toHaveBeenCalled();
  });

  it("confirmation refusée par la base (« stale ») : aucune déprogrammation, constat immédiat — lecture seule", async () => {
    orphans = [orphan()];
    completeSchedulingAnswer = "stale";
    provider.getPost.mockImplementation(async () => {
      toUnschedule = [pending()];
      return live({ status: "scheduled" });
    });
    const result = await runUrgentCycle(provider);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(of("complete_unscheduling")).toEqual([expect.objectContaining({ p_post_id: "p1", p_ok: false, p_error: STILL_SCHEDULED })]);
    expect(result).toMatchObject({ compensated: 0, compensationFailures: 1 });
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

describe("programmation après accord : toute échéance réservée par la base, quel que soit le profil", () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const claim = (id: string, dueAt: string) => ({ id, buffer_post_id: `b-${id}`, text: "Texte validé", assets: [], due_at: dueAt, service: "twitter", token: `jeton-${id}` });

  it("runSync programme les publications approuvées que la base réserve, proches ou lointaines, et ne déprogramme rien", async () => {
    profile = "pilot";
    claimedForSync = [claim("proche", soon), claim("loin", later)];
    provider.getPost.mockImplementation(async (id: string) => live({ id, dueAt: id === "b-proche" ? soon : later }));
    const result = await runSync("test");
    expect(names().filter((name) => name.startsWith("claim_posts_for_scheduling"))).toHaveLength(1);
    expect(provider.schedulePost).toHaveBeenCalledTimes(2);
    expect(provider.unschedulePost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scheduled: 2, scheduleFailures: 0 });
  });
});
