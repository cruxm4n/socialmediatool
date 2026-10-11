import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError, type DraftContent, type ProviderPost } from "@/server/publishing/provider";

/*
 * Envoi d'un contenu du Studio vers Buffer, isolé : la base et Buffer sont remplacés par des doublures.
 * Règles vérifiées : seuls des brouillons sont créés, jamais deux fois ; un contenu incomplet ne part
 * pas ; un échec n'entraîne ni doublon ni perte de l'identifiant Buffer.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const FUTURE = "2030-01-15T09:00:00.000Z";

interface Claimed {
  variant_id: string; channel_id: string; buffer_channel_id: string; service: string; text: string; buffer_post_id: string | null; revision: number;
  due_at: string; hashtags: string[]; media_ids: string[]; organization_id: string; attempt_id?: string | null;
}
let draftRow: Record<string, unknown> | null;
let mediaRows: Record<string, unknown>[];
/** Lecture de la table posts après la relecture de Buffer : ce qui est réellement entré dans le circuit de validation. */
let postRows: Record<string, unknown>[] | ((ids: string[]) => Record<string, unknown>[]) = [];
let lastIn: string[] = [];
let claimed: Claimed[];
let claimError: string | null;
let completeError: string | null;
let signFails: boolean;
/** Erreur de lecture des identifiants déjà rattachés (réconciliation). */
let knownError: string | null = null;
let lastInColumn = "";
/** Réponse de studio_complete_push : « applied », « orphan »… null : comportement par défaut. */
let completeAnswer: string | null = null;
/** Pause de quota renvoyée par get_sync_pause (null : aucune). */
let pause: { until: string; reason: string | null } | null = null;
const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
const signedFor: number[] = [];

const variant = (channelId: string, text: string, extra: Record<string, unknown> = {}) => ({
  id: `v-${channelId}`, channel_id: channelId, text, buffer_post_id: null, push_state: "idle", push_error: null, pushed_revision: null, removed_at: null, ...extra,
});

function table(name: string) {
  const query: Record<string, unknown> = {};
  const rows = () => (name === "posts" ? (typeof postRows === "function" ? postRows(lastIn) : postRows) : mediaRows);
  const result = () => {
    if (name === "studio_variants" && lastInColumn === "buffer_post_id" && knownError) return { data: null, error: { message: knownError } };
    return name === "studio_drafts" ? { data: draftRow, error: null } : { data: rows(), error: null };
  };
  for (const method of ["select", "eq", "is", "order", "limit"]) query[method] = () => query;
  query.in = (column: string, values: string[]) => {
    lastIn = values;
    lastInColumn = column;
    return query;
  };
  query.maybeSingle = async () => result();
  query.then = (resolve: (value: unknown) => void) => resolve(result());
  return query;
}

let connectionStatus: "active" | "revoking" | "revoked" | "missing" = "active";
vi.mock("@/server/supabase/clients", () => ({
  // Le vrai contrôle emissionProblem lit des routes et états cohérents, sans base externe.
  getAutomationClient: () => ({ rpc: async (name: string) => {
    if (name === "provider_routes") return { data: { channels: connectionStatus === "missing" ? {} : { "buf-li": "unit-connection", "buf-ig": "unit-connection" } }, error: null };
    if (name === "provider_connection_states") return { data: { "unit-connection": { status: connectionStatus } }, error: null };
    throw new Error(`RPC d'automatisation inattendue : ${name}`);
  } }),
  createSessionClient: async () => ({
    from: table,
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === "get_sync_pause") return { data: pause, error: null };
      if (name === "studio_claim_push") return claimError ? { data: null, error: { message: claimError } } : { data: claimed, error: null };
      return { data: name === "studio_complete_push" ? completeAnswer : null, error: completeError ? { message: completeError } : null };
    },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[], seconds: number) => {
          signedFor.push(seconds);
          return signFails ? { data: null, error: { message: "indisponible" } } : { data: paths.map((path) => ({ path, signedUrl: `https://stockage/${path}?jeton` })), error: null };
        },
      }),
    },
  }),
}));
vi.mock("@/server/data", () => ({
  listChannels: async () => [
    { id: "c-li", bufferChannelId: "buf-li", service: "linkedin", name: "Colibri", displayName: null, isDisconnected: false, organizationId: ORG },
    { id: "c-ig", bufferChannelId: "buf-ig", service: "instagram", name: "colibri", displayName: null, isDisconnected: false, organizationId: ORG },
  ],
}));
const runSync = vi.fn(async () => ({ ok: true }));
const recordRateLimit = vi.fn(async () => undefined);
vi.mock("@/server/sync", () => ({ runSync, recordRateLimit }));
// La pause de quota est pilotée par le test (jamais lue en base ici).
vi.mock("@/server/quota", () => ({
  activeRateLimitPause: async () => pause,
  pauseMessage: () => "Quota Buffer atteint : les écritures sont suspendues.",
  recordRateLimit,
}));

const live = (overrides: Partial<ProviderPost> = {}): ProviderPost => ({
  id: "b1", channelId: "buf-li", service: "linkedin", status: "draft", text: "", dueAt: FUTURE, sentAt: null, updatedAt: null, externalLink: null, error: null,
  hasReviewTag: true, schedulingType: "automatic", assets: [], ...overrides,
});
const provider = {
  mode: "mock" as const,
  getPost: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  schedulePost: vi.fn(),
  unschedulePost: vi.fn(),
  rescheduleDraft: vi.fn(),
  fetchSnapshot: vi.fn(),
  findDraftCandidates: vi.fn(),
};
vi.mock("@/server/publishing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/publishing")>(),
  getProvider: () => provider,
}));

const { confirmDraftAbsent, pushDraftToBuffer, reconcileDraftPush } = await import("@/server/studio");

/** Ligne locale d'une publication réellement entrée en validation pour CE contenu (propriétaire, date, tag, statut). */
const observed = (id: string, overrides: Record<string, unknown> = {}) => ({
  buffer_post_id: id, approval_status: "pending", ownership: "assigned", owner_organization_id: ORG, removed_at: null,
  has_review_tag: true, buffer_status: "draft", due_at: FUTURE, ...overrides,
});
const completions = () => rpcCalls.filter((call) => call.name === "studio_complete_push").map((call) => call.params);
const claimOf = (channel: "li" | "ig", text: string, bufferPostId: string | null = null): Claimed => ({
  variant_id: `v-c-${channel}`, channel_id: `c-${channel}`, buffer_channel_id: `buf-${channel}`, service: channel === "li" ? "linkedin" : "instagram", text,
  buffer_post_id: bufferPostId, revision: 3, due_at: FUTURE, hashtags: ["#café"], media_ids: ["m1"], organization_id: ORG,
});

beforeEach(() => {
  vi.stubEnv("AUTOMATION_SECRET", "secret-studio-unit-test");
  connectionStatus = "active";
  rpcCalls.length = 0;
  signedFor.length = 0;
  claimError = null;
  completeError = null;
  completeAnswer = null;
  knownError = null;
  lastInColumn = "";
  signFails = false;
  mediaRows = [{ id: "m1", organization_id: ORG, storage_path: `${ORG}/a.jpg`, file_name: "a.jpg", kind: "image", mime_type: "image/jpeg", size_bytes: 1000, width: 1080, height: 1080, duration_ms: null, created_at: FUTURE, archived_at: null }];
  draftRow = { id: DRAFT, organization_id: ORG, title: "Guji", due_at: FUTURE, hashtags: ["#café"], media_ids: ["m1"], status: "draft", revision: 3, created_at: FUTURE, updated_at: FUTURE, submitted_at: null, studio_variants: [variant("c-li", "Bonjour LinkedIn"), variant("c-ig", "Bonjour Insta")] };
  claimed = [claimOf("li", "Bonjour LinkedIn"), claimOf("ig", "Bonjour Insta")];
  // Par défaut, tout brouillon créé est bien entré en validation côté client.
  postRows = (ids) => ids.map((id) => observed(id));
  vi.clearAllMocks();
  provider.getPost.mockResolvedValue(null);
  provider.createDraft.mockImplementation(async (content: DraftContent) => live({ id: `nouveau-${content.channelId}`, channelId: content.channelId }));
  provider.updateDraft.mockImplementation(async (id: string) => live({ id }));
});

afterEach(() => vi.unstubAllEnvs());

describe("contrôle réel des connexions avant envoi", () => {
  it.each(["revoking", "revoked", "missing"] as const)("refuse une connexion %s avant toute réservation ou création", async (status) => {
    connectionStatus = status;
    expect(await pushDraftToBuffer(DRAFT)).toMatchObject({ ok: false, code: "connection_unavailable" });
    expect(rpcCalls.some((call) => call.name === "studio_claim_push")).toBe(false);
    expect(provider.createDraft).not.toHaveBeenCalled();
    expect(provider.updateDraft).not.toHaveBeenCalled();
  });
});

describe("envoi en validation", () => {
  it("crée un brouillon par canal, avec son texte, les hashtags communs, la date et les médias, puis relit Buffer", async () => {
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ ok: true, created: 2, updated: 0, failed: 0 });
    expect(provider.createDraft).toHaveBeenCalledTimes(2);
    expect(provider.createDraft.mock.calls[0][0]).toEqual({
      channelId: "buf-li", service: "linkedin", text: "Bonjour LinkedIn\n\n#café", dueAt: FUTURE, assets: [{ type: "image", url: `https://stockage/${ORG}/a.jpg?jeton` }],
    });
    expect(completions()).toEqual([
      { p_variant_id: "v-c-li", p_ok: true, p_buffer_post_id: "nouveau-buf-li", p_error: null, p_revision: 3 },
      { p_variant_id: "v-c-ig", p_ok: true, p_buffer_post_id: "nouveau-buf-ig", p_error: null, p_revision: 3 },
    ]);
    expect(runSync).toHaveBeenCalledWith("studio");
    // Ne programme et ne publie jamais.
    expect(provider.schedulePost).not.toHaveBeenCalled();
    // L'adresse remise à Buffer vit plus longtemps que celle affichée dans Cadence.
    expect(Math.max(...signedFor)).toBe(7 * 24 * 60 * 60);
  });

  it("un contenu déjà dans Buffer est mis à jour, jamais recréé", async () => {
    claimed = [claimOf("li", "Corrigé", "b1")];
    provider.getPost.mockResolvedValue(live());
    expect(await pushDraftToBuffer(DRAFT)).toMatchObject({ ok: true, created: 0, updated: 1 });
    expect(provider.createDraft).not.toHaveBeenCalled();
    expect(provider.updateDraft).toHaveBeenCalledWith("b1", expect.objectContaining({ text: "Corrigé\n\n#café" }));
  });

  it("un brouillon supprimé à la main dans Buffer est recréé", async () => {
    claimed = [claimOf("li", "Texte", "disparu")];
    expect(await pushDraftToBuffer(DRAFT)).toMatchObject({ created: 1, updated: 0 });
    expect(completions()[0]).toMatchObject({ p_buffer_post_id: "nouveau-buf-li" });
  });

  it("ne touche pas à une publication déjà publiée", async () => {
    claimed = [claimOf("li", "Trop tard", "b1")];
    provider.getPost.mockResolvedValue(live({ status: "sent" }));
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ ok: false, failed: 1 });
    expect(provider.updateDraft).not.toHaveBeenCalled();
    expect(completions()[0]).toMatchObject({ p_ok: false, p_error: "Cette publication est déjà publiée : elle ne peut plus être modifiée." });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("rien à faire quand tout est déjà à jour", async () => {
    claimed = [];
    expect(await pushDraftToBuffer(DRAFT)).toMatchObject({ ok: true, message: "Ce contenu est déjà à jour dans Buffer." });
    expect(provider.createDraft).not.toHaveBeenCalled();
  });
});

describe("refus avant tout appel à Buffer", () => {
  it("contenu incomplet : les règles du réseau sont revérifiées côté serveur", async () => {
    draftRow = { ...draftRow!, media_ids: [] };
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ ok: false, message: "Instagram : un média est obligatoire." });
    expect(rpcCalls).toEqual([]);
    expect(provider.createDraft).not.toHaveBeenCalled();
  });

  it("date passée, contenu introuvable, média manquant", async () => {
    draftRow = { ...draftRow!, due_at: "2020-01-01T09:00:00.000Z" };
    expect((await pushDraftToBuffer(DRAFT)).message).toBe("La date de publication est passée ou trop proche.");
    draftRow = { ...draftRow!, due_at: FUTURE, media_ids: ["m1", "absent"] };
    expect((await pushDraftToBuffer(DRAFT)).message).toBe("Un média de ce contenu est introuvable.");
    draftRow = null;
    expect((await pushDraftToBuffer(DRAFT)).message).toBe("Ce contenu est introuvable.");
    expect(rpcCalls).toEqual([]);
  });

  it("un envoi déjà en cours ou interrompu est refusé par la base, avec un code exploitable par l'écran", async () => {
    claimError = "push_in_progress";
    expect(await pushDraftToBuffer(DRAFT)).toMatchObject({ ok: false, code: "push_in_progress" });
    claimError = "push_unknown";
    expect(await pushDraftToBuffer(DRAFT)).toMatchObject({ ok: false, code: "push_unknown" });
    expect(provider.createDraft).not.toHaveBeenCalled();
    // Aucune voie de renvoi forcé : la base reçoit toujours p_force = false.
    claimError = null;
    await pushDraftToBuffer(DRAFT);
    expect(rpcCalls.filter((call) => call.name === "studio_claim_push").every((call) => call.params.p_force === false)).toBe(true);
  });
});

describe("échecs", () => {
  it("un refus de Buffer sur un canal n'empêche pas les autres, et rien n'est créé en double", async () => {
    provider.createDraft.mockRejectedValueOnce(new ProviderError("Buffer a refusé la création : limite atteinte"));
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ ok: false, created: 1, failed: 1 });
    expect(completions().map((item) => [item.p_ok, item.p_buffer_post_id])).toEqual([[false, null], [true, "nouveau-buf-ig"]]);
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it("quota ou panne : arrêt immédiat, les canaux restants sont libérés sans appel", async () => {
    provider.createDraft.mockRejectedValueOnce(new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit"));
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ ok: false, created: 0, failed: 2 });
    expect(provider.createDraft).toHaveBeenCalledTimes(1);
    expect(completions().every((item) => item.p_ok === false)).toBe(true);
    // Le quota atteint est enregistré comme pause : les synchronisations planifiées l'appliquent.
    expect(recordRateLimit).toHaveBeenCalledTimes(1);
  });

  it("brouillon créé mais non enregistré ici : son identifiant Buffer est conservé pour ne pas le recréer", async () => {
    claimed = [claimOf("li", "Texte")];
    completeError = "connexion perdue";
    const result = await pushDraftToBuffer(DRAFT);
    expect(result.failed).toBe(1);
    expect(completions().at(-1)).toMatchObject({ p_ok: false, p_buffer_post_id: "nouveau-buf-li" });
    expect(String(completions().at(-1)!.p_error)).toContain("existe dans Buffer");
  });

  it("médias impossibles à préparer : aucun brouillon n'est créé", async () => {
    signFails = true;
    // La bibliothèque elle-même reste lisible (première signature), c'est la préparation pour Buffer qui échoue.
    const result = await pushDraftToBuffer(DRAFT);
    expect(result.ok).toBe(false);
    expect(provider.createDraft).not.toHaveBeenCalled();
  });
});

describe("résultat Buffer incertain (audit B6)", () => {
  it("une création sans réponse n'est ni un succès ni un échec : état « unknown », aucun nouvel essai", async () => {
    claimed = [claimOf("li", "Texte")];
    provider.createDraft.mockRejectedValueOnce(new ProviderError("Buffer ne répond pas (délai dépassé).", "network", undefined, "unknown"));
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ ok: false, code: "push_unknown", created: 0, failed: 0, unknown: 1 });
    expect(provider.createDraft).toHaveBeenCalledTimes(1);
    expect(completions().at(-1)).toMatchObject({ p_ok: false, p_buffer_post_id: null, p_uncertain: true });
    expect(result.message).toContain("Vérifier dans Buffer");
    // Aucune relecture ni annonce de soumission pour ce canal.
    expect(runSync).not.toHaveBeenCalled();
  });

  it("un refus certain de Buffer n'est pas marqué incertain", async () => {
    claimed = [claimOf("li", "Texte")];
    provider.createDraft.mockRejectedValueOnce(new ProviderError("Buffer a refusé la création : texte vide"));
    await pushDraftToBuffer(DRAFT);
    expect(completions().at(-1)).not.toHaveProperty("p_uncertain");
  });

  it("un brouillon créé puis une étape suivante en échec garde son identifiant et reste un échec certain", async () => {
    claimed = [claimOf("li", "Texte")];
    provider.createDraft.mockRejectedValueOnce(new ProviderError("Buffer n'a pas répondu à la remise en brouillon.", "network", undefined, "unknown").withCreatedPost("cree-1"));
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ failed: 1, unknown: 0 });
    expect(completions().at(-1)).toMatchObject({ p_ok: false, p_buffer_post_id: "cree-1" });
    expect(completions().at(-1)).not.toHaveProperty("p_uncertain");
  });

  it("une mise à jour dont la réponse est perdue peut être renvoyée : c'est un échec, pas un résultat inconnu", async () => {
    claimed = [claimOf("li", "Texte", "b1")];
    provider.getPost.mockResolvedValue(live());
    provider.updateDraft.mockRejectedValueOnce(new ProviderError("Buffer ne répond pas.", "network", undefined, "unknown"));
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ failed: 1, unknown: 0 });
    expect(completions().at(-1)).toMatchObject({ p_ok: false, p_buffer_post_id: "b1" });
  });
});

describe("photographie cohérente et messages véridiques (audit P2)", () => {
  it("l'envoi utilise le contenu réservé, pas une relecture : une révision plus récente ne se mélange pas à l'ancienne", async () => {
    // L'écran a lu la révision 3 ; la base réserve la révision 4 avec d'autres hashtags et une autre date.
    claimed = [{ ...claimOf("li", "Texte révisé"), revision: 4, hashtags: ["#nouveau"], due_at: "2030-02-01T10:00:00.000Z" }];
    await pushDraftToBuffer(DRAFT);
    expect(provider.createDraft.mock.calls[0][0]).toMatchObject({ text: "Texte révisé\n\n#nouveau", dueAt: "2030-02-01T10:00:00.000Z" });
    expect(completions().at(-1)).toMatchObject({ p_ok: true, p_revision: 4 });
  });

  it("« soumis au client » n'est affirmé que si la publication est réellement en attente de décision", async () => {
    claimed = [claimOf("li", "Texte")];
    postRows = [];
    const result = await pushDraftToBuffer(DRAFT);
    expect(result).toMatchObject({ ok: false, code: "submission_unconfirmed", created: 1, submitted: 0 });
    expect(result.message).toContain("dans Buffer");
    expect(result.message).not.toContain("et soumis au client");
  });

  it("une synchronisation en échec n'est pas masquée", async () => {
    claimed = [claimOf("li", "Texte")];
    runSync.mockResolvedValueOnce({ ok: false, error: "Buffer injoignable" } as never);
    postRows = [];
    const result = await pushDraftToBuffer(DRAFT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Buffer injoignable");
  });

  it("le contenu réservé est contrôlé à nouveau : un canal incomplet libère la réservation sans appeler Buffer", async () => {
    claimed = [claimOf("li", "x".repeat(4000))];
    const result = await pushDraftToBuffer(DRAFT);
    expect(result.ok).toBe(false);
    expect(provider.createDraft).not.toHaveBeenCalled();
    expect(completions().at(-1)).toMatchObject({ p_ok: false });
  });
});

describe("réconciliation (audit B6)", () => {
  const unknownDraft = () => {
    draftRow = { ...(draftRow as object), studio_variants: [variant("c-li", "Bonjour LinkedIn", { push_state: "unknown", push_unknown_at: FUTURE })] };
  };
  const attempts = [{ id: "v-c-li", push_attempt: { text: "Bonjour LinkedIn", dueAt: FUTURE, hashtags: ["#café"] } }];

  beforeEach(() => {
    unknownDraft();
    mediaRows = attempts;
  });

  it("retrouve un brouillon créé malgré la réponse perdue et l'adopte au lieu de le recréer", async () => {
    provider.findDraftCandidates.mockResolvedValue({ candidates: [live({ id: "retrouve-1", channelId: "buf-li", text: "Bonjour LinkedIn\n\n#café" })], complete: true });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result.ok).toBe(true);
    expect(provider.findDraftCandidates).toHaveBeenCalledWith({ channelId: "buf-li", text: "Bonjour LinkedIn\n\n#café", dueAt: FUTURE });
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")?.params).toMatchObject({ p_buffer_post_id: "retrouve-1" });
    expect(provider.createDraft).not.toHaveBeenCalled();
  });

  it("médias : une correspondance exacte dont l'identité des médias ne se prouve pas n'est PAS adoptée seule (mission V3, C02)", async () => {
    mediaRows = [{ id: "v-c-li", push_attempt: { text: "Bonjour LinkedIn", dueAt: FUTURE, hashtags: ["#café"], assetKinds: ["image"] } }];
    provider.findDraftCandidates.mockResolvedValue({ candidates: [live({ id: "meme-texte", channelId: "buf-li", text: "Bonjour LinkedIn\n\n#café" })], complete: true });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result).toMatchObject({ ok: false, code: "push_unknown" });
    expect(result.message).toContain("médias");
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
  });

  it.each(["error", "sent", "sending", "scheduled"] as const)("un candidat au statut « %s » n'est pas rattaché automatiquement", async (status) => {
    provider.findDraftCandidates.mockResolvedValue({ candidates: [live({ id: "autre-statut", channelId: "buf-li", status })], complete: true });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result.ok).toBe(false);
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
  });

  it("lecture impossible des identifiants déjà rattachés : aucune adoption, rien n'est libéré", async () => {
    knownError = "base injoignable";
    provider.findDraftCandidates.mockResolvedValue({ candidates: [live({ id: "retrouve-2", channelId: "buf-li", text: "Bonjour LinkedIn\n\n#café" })], complete: true });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("n'ont pas pu être lus");
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
  });

  it("une pause de quota (refus de Buffer) suspend aussi la réconciliation : aucune lecture de Buffer", async () => {
    pause = { until: "2031-01-01T00:00:00Z", reason: "Quota atteint" };
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    pause = null;
    expect(result).toMatchObject({ ok: false, code: "quota_paused" });
    expect(provider.findDraftCandidates).not.toHaveBeenCalled();
  });

  it("plusieurs correspondances : aucune décision automatique", async () => {
    provider.findDraftCandidates.mockResolvedValue({ candidates: [live({ id: "a" }), live({ id: "b" })], complete: true });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result).toMatchObject({ ok: false, code: "push_unknown" });
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
  });

  it("rien trouvé mais lecture incomplète : on ne conclut pas à l'absence", async () => {
    provider.findDraftCandidates.mockResolvedValue({ candidates: [], complete: false });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result.ok).toBe(false);
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
  });

  it("rien trouvé, même lecture complète : Cadence ne conclut jamais à l'absence (contre-audit B6)", async () => {
    provider.findDraftCandidates.mockResolvedValue({ candidates: [], possible: [], complete: true });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result).toMatchObject({ ok: false, code: "push_absent_unproven" });
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
    expect(provider.createDraft).not.toHaveBeenCalled();
  });

  it("une ressemblance (texte ou date identique, médias différents) est à trancher par une personne", async () => {
    provider.findDraftCandidates.mockResolvedValue({ candidates: [], possible: [live({ id: "proche", channelId: "buf-li" })], complete: true });
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result).toMatchObject({ ok: false, code: "push_unknown" });
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
  });

  it("la confirmation d'absence vient d'une personne et le dit à la base", async () => {
    postRows = [];
    const result = await confirmDraftAbsent(DRAFT, "Vérifié dans Buffer : aucun brouillon sur ce canal.");
    expect(result.ok).toBe(true);
    // La preuve (ce qui a été vérifié) est transmise et consignée avec la tentative.
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")?.params).toMatchObject({
      p_confirmed_absent: true, p_operator_confirmed: true, p_buffer_post_id: null, p_evidence: "Vérifié dans Buffer : aucun brouillon sur ce canal.",
    });
  });

  it("Buffer injoignable : l'état reste inconnu", async () => {
    provider.findDraftCandidates.mockRejectedValue(new ProviderError("Buffer injoignable", "network", undefined, "unknown"));
    postRows = [];
    const result = await reconcileDraftPush(DRAFT);
    expect(result.ok).toBe(false);
    expect(rpcCalls.find((call) => call.name === "studio_resolve_unknown")).toBeUndefined();
  });
});

describe("« soumis au client » : observation fraîche de la version exacte (mission V3, C06)", () => {
  const submittedFor = async (rows: (id: string) => Record<string, unknown>) => {
    claimed = [claimOf("li", "Bonjour LinkedIn")];
    draftRow = { ...draftRow!, studio_variants: [variant("c-li", "Bonjour LinkedIn")] };
    postRows = (ids) => ids.map(rows);
    return pushDraftToBuffer(DRAFT);
  };

  it("une ligne observée d'un autre propriétaire, d'une autre date ou sans tag ne vaut pas soumission", async () => {
    for (const bad of [
      { owner_organization_id: "33333333-3333-4333-8333-333333333333" },
      { ownership: "ambiguous" },
      { due_at: "2030-02-01T09:00:00.000Z" },
      { has_review_tag: false },
      { removed_at: "2030-01-01T00:00:00Z" },
      { buffer_status: "scheduled" },
    ]) {
      const result = await submittedFor((id) => observed(id, bad));
      expect(result.submitted, JSON.stringify(bad)).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("n'est pas confirmée");
    }
  });

  it("la ligne conforme est comptée ; la confirmation vaut pour ce texte exact", async () => {
    const result = await submittedFor((id) => observed(id));
    expect(result).toMatchObject({ ok: true, submitted: 1 });
  });

  it("une création d'une tentative qui n'est plus la courante (« orphan ») n'est jamais comptée comme réussie ni rattachée", async () => {
    claimed = [{ ...claimOf("li", "Bonjour LinkedIn"), attempt_id: "tentative-1" }];
    draftRow = { ...draftRow!, studio_variants: [variant("c-li", "Bonjour LinkedIn")] };
    completeAnswer = "orphan";
    const result = await pushDraftToBuffer(DRAFT);
    completeAnswer = null;
    // Chaque confirmation représente l'identité de la tentative réservée.
    expect(completions().every((params) => params.p_attempt_id === "tentative-1")).toBe(true);
    expect(result).toMatchObject({ ok: false, created: 0, failed: 1 });
    expect(result.message).toContain("orphelin");
  });
});
