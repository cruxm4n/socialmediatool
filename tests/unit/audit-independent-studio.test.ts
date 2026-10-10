import { beforeEach, describe, expect, it, vi } from "vitest";

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
  due_at: string; hashtags: string[]; media_ids: string[]; organization_id: string;
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
const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
const signedFor: number[] = [];

const variant = (channelId: string, text: string, extra: Record<string, unknown> = {}) => ({
  id: `v-${channelId}`, channel_id: channelId, text, buffer_post_id: null, push_state: "idle", push_error: null, pushed_revision: null, removed_at: null, ...extra,
});

function table(name: string) {
  const query: Record<string, unknown> = {};
  const rows = () => (name === "posts" ? (typeof postRows === "function" ? postRows(lastIn) : postRows) : mediaRows);
  const result = () => (name === "studio_drafts" ? { data: draftRow, error: null } : { data: rows(), error: null });
  for (const method of ["select", "eq", "is", "order", "limit"]) query[method] = () => query;
  query.in = (_column: string, values: string[]) => {
    lastIn = values;
    return query;
  };
  query.maybeSingle = async () => result();
  query.then = (resolve: (value: unknown) => void) => resolve(result());
  return query;
}

vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => ({
    from: table,
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === "studio_claim_push") return claimError ? { data: null, error: { message: claimError } } : { data: claimed, error: null };
      return { data: null, error: completeError ? { message: completeError } : null };
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
vi.mock("@/server/publishing", () => ({ getProvider: () => provider }));

const { pushDraftToBuffer, reconcileDraftPush } = await import("@/server/studio");

const completions = () => rpcCalls.filter((call) => call.name === "studio_complete_push").map((call) => call.params);
const claimOf = (channel: "li" | "ig", text: string, bufferPostId: string | null = null): Claimed => ({
  variant_id: `v-c-${channel}`, channel_id: `c-${channel}`, buffer_channel_id: `buf-${channel}`, service: channel === "li" ? "linkedin" : "instagram", text,
  buffer_post_id: bufferPostId, revision: 3, due_at: FUTURE, hashtags: ["#café"], media_ids: ["m1"], organization_id: ORG,
});

beforeEach(() => {
  rpcCalls.length = 0;
  signedFor.length = 0;
  claimError = null;
  completeError = null;
  signFails = false;
  mediaRows = [{ id: "m1", organization_id: ORG, storage_path: `${ORG}/a.jpg`, file_name: "a.jpg", kind: "image", mime_type: "image/jpeg", size_bytes: 1000, width: 1080, height: 1080, duration_ms: null, created_at: FUTURE, archived_at: null }];
  draftRow = { id: DRAFT, organization_id: ORG, title: "Guji", due_at: FUTURE, hashtags: ["#café"], media_ids: ["m1"], status: "draft", revision: 3, created_at: FUTURE, updated_at: FUTURE, submitted_at: null, studio_variants: [variant("c-li", "Bonjour LinkedIn"), variant("c-ig", "Bonjour Insta")] };
  claimed = [claimOf("li", "Bonjour LinkedIn"), claimOf("ig", "Bonjour Insta")];
  // Par défaut, tout brouillon créé est bien entré en validation côté client.
  postRows = (ids) => ids.map((id) => ({ buffer_post_id: id, approval_status: "pending" }));
  vi.clearAllMocks();
  provider.getPost.mockResolvedValue(null);
  provider.createDraft.mockImplementation(async (content: DraftContent) => live({ id: `nouveau-${content.channelId}`, channelId: content.channelId }));
  provider.updateDraft.mockImplementation(async (id: string) => live({ id }));
});

describe("Contre-audit indépendant Studio",()=>{
 it("une recréation avec ancienne identité supprimée doit rester incertaine après réponse perdue",async()=>{
  claimed=[claimOf("li","Texte","id-supprime")];
  provider.getPost.mockResolvedValue(null);
  provider.createDraft.mockRejectedValue(new ProviderError("réponse perdue","network",undefined,"unknown"));
  const r=await pushDraftToBuffer(DRAFT);
  expect(r.unknown).toBe(1);expect(completions()[0]).toMatchObject({p_uncertain:true});
 });
 it("le message de soumission ne peut pas confirmer une ancienne version locale après échec de sync",async()=>{
  claimed=[claimOf("li","NOUVELLE VERSION","b1")];provider.getPost.mockResolvedValue(live());
  runSync.mockResolvedValue({ok:false,error:"API indisponible"} as never);
  postRows=[{buffer_post_id:"b1",approval_status:"pending",text:"ANCIENNE VERSION"}];
  const r=await pushDraftToBuffer(DRAFT);expect(r.ok).toBe(false);expect(r.submitted).toBe(0);
 });
});
