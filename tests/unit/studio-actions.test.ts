import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Actions du Studio et approbation groupée, isolées. On vérifie les droits, le choix du bon chemin
 * pour un déplacement au calendrier, et que l'approbation groupée applique la règle à chaque publication.
 */

let role: "admin" | "client" | null = "admin";
let rpcResults: Record<string, { data: unknown; error: { code?: string; message: string } | null }> = {};
const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let post: Record<string, unknown> | null = null;
let origin: { draftId: string; revision: number } | null = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: (task: () => void) => task() }));
vi.mock("@/server/auth", () => ({
  homePath: () => "/admin",
  getSession: async () => (role ? { profile: { id: "u1", fullName: "Test", jobTitle: "", role }, organizations: [] } : null),
}));
vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === "decide_post") {
        const refusal = (rpcResults.decide_post?.data as Record<string, string> | undefined)?.[params.p_post_id as string];
        return refusal ? { data: null, error: { message: refusal } } : { data: {}, error: null };
      }
      return rpcResults[name] ?? { data: null, error: null };
    },
  }),
}));
vi.mock("@/server/data", () => ({ getPost: async () => post }));
const pushDraftToBuffer = vi.fn(async () => ({ ok: true, message: "ok", created: 0, updated: 1, failed: 0 }));
vi.mock("@/server/studio", () => ({
  pushDraftToBuffer,
  findDraftForPost: async () => origin,
  studioFailure: (message: string) => ({ ok: false, message, code: message }),
}));
const provider = { getPost: vi.fn(), rescheduleDraft: vi.fn() };
vi.mock("@/server/publishing", () => ({ getProvider: () => provider }));
const runSync = vi.fn(async () => ({ ok: true }));
vi.mock("@/server/sync", () => ({ runSync }));
const dispatchNotifications = vi.fn(async () => ({}));
vi.mock("@/server/notifications", () => ({ dispatchNotifications }));

const { moveCalendarItem, registerMedia, saveStudioDraft, setMediaArchived, setStudioDraftArchived, submitStudioDraft } = await import("@/server/studio-actions");
const { approvePosts } = await import("@/server/actions");

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const FUTURE = "2030-01-15T09:00:00.000Z";
const input = { organizationId: ORG, title: "Guji", dueAt: FUTURE, hashtags: ["café", "#Café", "lyon !"], mediaIds: [], variants: [{ channelId: CHANNEL, text: "Bonjour" }] };

beforeEach(() => {
  role = "admin";
  rpcResults = {};
  rpcCalls.length = 0;
  post = null;
  origin = null;
  vi.clearAllMocks();
});

describe("droits du Studio", () => {
  const actions: [string, () => Promise<{ ok: boolean; message: string; expired?: boolean }>][] = [
    ["enregistrer", () => saveStudioDraft(input)],
    ["envoyer en validation", () => submitStudioDraft({ id: ID })],
    ["archiver un contenu", () => setStudioDraftArchived({ id: ID, archived: true })],
    ["ajouter un média", () => registerMedia({ organizationId: ORG, path: `${ORG}/a.jpg`, fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10, width: null, height: null, durationMs: null })],
    ["retirer un média", () => setMediaArchived({ id: ID, archived: true })],
    ["déplacer au calendrier", () => moveCalendarItem({ kind: "studio", draftId: ID, dueAt: FUTURE })],
  ];

  it.each(actions)("%s : refusé à un client, sans appeler la base ni Buffer", async (_label, action) => {
    role = "client";
    expect(await action()).toMatchObject({ ok: false, message: "Réservé à l'administrateur." });
    expect(rpcCalls).toEqual([]);
    expect(pushDraftToBuffer).not.toHaveBeenCalled();
  });

  it.each(actions)("%s : sans session, renvoie vers la connexion", async (_label, action) => {
    role = null;
    expect(await action()).toMatchObject({ ok: false, expired: true });
    expect(rpcCalls).toEqual([]);
  });
});

describe("enregistrement", () => {
  it("remet les hashtags en forme côté serveur et transmet la révision attendue", async () => {
    rpcResults.studio_save_draft = { data: { id: ID, revision: 4 }, error: null };
    expect(await saveStudioDraft({ ...input, id: ID, expectedRevision: 3 })).toMatchObject({ ok: true, id: ID, revision: 4 });
    expect(rpcCalls[0].params).toMatchObject({ p_id: ID, p_expected_revision: 3 });
    expect((rpcCalls[0].params.p_payload as { hashtags: string[] }).hashtags).toEqual(["#café", "#lyon"]);
  });

  it("refuse une date mal formée ; signale un conflit de version et une base sans la migration", async () => {
    expect((await saveStudioDraft({ ...input, dueAt: "demain" })).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
    rpcResults.studio_save_draft = { data: null, error: { message: "stale_revision" } };
    expect(await saveStudioDraft(input)).toMatchObject({ ok: false, code: "stale_revision" });
    rpcResults.studio_save_draft = { data: null, error: { code: "PGRST202", message: "absente" } };
    expect((await saveStudioDraft(input)).message).toContain("migration 0008");
  });
});

describe("déplacement au calendrier", () => {
  it("refuse le passé avant tout appel", async () => {
    expect(await moveCalendarItem({ kind: "studio", draftId: ID, dueAt: "2020-01-01T09:00:00.000Z" })).toMatchObject({ ok: false, message: "Impossible de déplacer une publication dans le passé." });
    expect(rpcCalls).toEqual([]);
  });

  it("contenu du Studio pas encore envoyé : seule sa date change, Buffer n'est pas appelé", async () => {
    expect((await moveCalendarItem({ kind: "studio", draftId: ID, dueAt: FUTURE })).ok).toBe(true);
    expect(rpcCalls).toEqual([{ name: "studio_reschedule_draft", params: { p_id: ID, p_expected_revision: null, p_due_at: FUTURE } }]);
    expect(provider.rescheduleDraft).not.toHaveBeenCalled();
  });

  it("brouillon Buffer : la date change dans Buffer puis Buffer est relu ; une approbation est signalée comme à redemander", async () => {
    post = { id: ID, bufferPostId: "b1", bufferStatus: "draft", approvalStatus: "approved", removedAt: null };
    provider.getPost.mockResolvedValue({ id: "b1", status: "draft" });
    const result = await moveCalendarItem({ kind: "post", postId: ID, dueAt: FUTURE });
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain("à redemander");
    expect(provider.rescheduleDraft).toHaveBeenCalledWith({ id: "b1", status: "draft" }, FUTURE);
    expect(runSync).toHaveBeenCalledWith("calendrier");
  });

  it("publication programmée ou publiée : refusé, Buffer n'est pas appelé", async () => {
    post = { id: ID, bufferPostId: "b1", bufferStatus: "scheduled", approvalStatus: "approved", removedAt: null };
    expect((await moveCalendarItem({ kind: "post", postId: ID, dueAt: FUTURE })).ok).toBe(false);
    expect(provider.getPost).not.toHaveBeenCalled();
  });

  it("publication issue du Studio : le contenu entier change de date et est renvoyé", async () => {
    post = { id: ID, bufferPostId: "b1", bufferStatus: "draft", approvalStatus: "pending", removedAt: null };
    origin = { draftId: ORG, revision: 2 };
    expect((await moveCalendarItem({ kind: "post", postId: ID, dueAt: FUTURE })).ok).toBe(true);
    expect(rpcCalls[0]).toMatchObject({ name: "studio_reschedule_draft", params: { p_id: ORG } });
    expect(pushDraftToBuffer).toHaveBeenCalledWith(ORG);
    expect(provider.rescheduleDraft).not.toHaveBeenCalled();
  });

  it("un refus de Buffer est rapporté, sans relecture", async () => {
    post = { id: ID, bufferPostId: "b1", bufferStatus: "draft", approvalStatus: "none", removedAt: null };
    provider.getPost.mockResolvedValue({ id: "b1", status: "draft" });
    provider.rescheduleDraft.mockRejectedValue(new Error("Buffer a refusé la modification : date invalide"));
    const result = await moveCalendarItem({ kind: "post", postId: ID, dueAt: FUTURE });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("date invalide");
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe("approbation groupée", () => {
  const items = [{ postId: ID, expectedHash: "h1" }, { postId: ORG, expectedHash: "h2" }, { postId: CHANNEL, expectedHash: "h3" }];

  it("décide chaque publication séparément, avec la version affichée, sans rien programmer — lecture seule", async () => {
    const result = await approvePosts(items);
    expect(result).toMatchObject({ ok: true, approved: 3, refused: [], message: "3 publications approuvées." });
    expect(rpcCalls.map((call) => [call.name, call.params.p_decision, call.params.p_expected_hash])).toEqual([
      ["decide_post", "approved", "h1"], ["decide_post", "approved", "h2"], ["decide_post", "approved", "h3"],
    ]);
    expect(runSync).not.toHaveBeenCalled();
    expect(provider.getPost).not.toHaveBeenCalled();
    expect(provider.rescheduleDraft).not.toHaveBeenCalled();
    expect(pushDraftToBuffer).not.toHaveBeenCalled();
    expect(dispatchNotifications).toHaveBeenCalledTimes(1);
  });

  it("une publication modifiée entre-temps est refusée sans bloquer les autres", async () => {
    rpcResults.decide_post = { data: { [ORG]: "stale_version" }, error: null };
    const result = await approvePosts(items);
    expect(result).toMatchObject({ ok: true, approved: 2 });
    expect(result.refused).toEqual([{ postId: ORG, message: expect.stringContaining("modifiée depuis son affichage") }]);
  });

  it("rien d'approuvé : aucune programmation ; sélection vide ou trop grande refusée", async () => {
    rpcResults.decide_post = { data: { [ID]: "date_invalid" }, error: null };
    expect(await approvePosts([items[0]])).toMatchObject({ ok: false, approved: 0 });
    expect(runSync).not.toHaveBeenCalled();
    expect((await approvePosts([])).ok).toBe(false);
    expect((await approvePosts(Array.from({ length: 51 }, () => items[0]))).ok).toBe(false);
  });

  it("session expirée en cours de route : on s'arrête et on le dit", async () => {
    rpcResults.decide_post = { data: { [ORG]: "not_authenticated" }, error: null };
    expect(await approvePosts(items)).toMatchObject({ ok: false, expired: true, approved: 1 });
    expect(rpcCalls).toHaveLength(2);
  });
});
