import { describe, expect, it, vi } from "vitest";

import { BufferProvider } from "@/server/publishing/buffer-provider";
import type { DraftContent } from "@/server/publishing/provider";

/*
 * Contre-audit B6 : classement des réponses GraphQL de Buffer et réconciliation prudente.
 * Aucun appel réseau : fetch est remplacé. Les écritures ne sont jamais envoyées au vrai Buffer.
 */

const DUE = "2030-01-15T09:00:00.000Z";
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: "created-1", channelId: "c1", channelService: "linkedin", text: "Audit", dueAt: DUE, status: "draft", sentAt: null, updatedAt: null,
  externalLink: null, schedulingType: "automatic", error: null, tags: [{ name: "À valider" }], assets: [], ...overrides,
});
const content: DraftContent = { channelId: "c1", service: "linkedin", text: "Audit", dueAt: DUE, assets: [] };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

/** Fournisseur dont les lectures d'organisation/tag réussissent et dont l'écriture est fournie par le test. */
function withWrite(write: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (query.trimStart().startsWith("mutation")) {
      calls.push("mutation");
      return write();
    }
    if (query.includes("query Channel")) return json({ data: { channel: { organizationId: "org1" } } });
    return json({ data: { tagsV2: { edges: [{ node: { id: "tag1", name: "À valider" } }] } } });
  });
  return { provider: new BufferProvider("cle-factice", "À valider", fetchImpl as unknown as typeof fetch), calls };
}

describe("erreurs GraphQL d'une écriture (HTTP 200)", () => {
  it("UNEXPECTED : l'effet est inconnu", async () => {
    const { provider } = withWrite(() => json({ data: null, errors: [{ message: "Internal", extensions: { code: "UNEXPECTED" } }] }));
    expect(await provider.createDraft(content).catch((e) => e)).toMatchObject({ outcome: "unknown", kind: "api" });
  });

  it("une erreur sans code ne prouve pas l'absence d'effet", async () => {
    const { provider } = withWrite(() => json({ data: null, errors: [{ message: "???" }] }));
    expect(await provider.createDraft(content).catch((e) => e)).toMatchObject({ outcome: "unknown" });
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])("%s : refus documenté, échec certain", async (code) => {
    const { provider } = withWrite(() => json({ data: null, errors: [{ message: "Refus", extensions: { code } }] }));
    expect(await provider.createDraft(content).catch((e) => e)).toMatchObject({ outcome: "failed" });
  });

  it("RATE_LIMIT_EXCEEDED : quota, avec le délai demandé conservé intégralement", async () => {
    const { provider } = withWrite(() => json({ data: null, errors: [{ message: "Trop", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] }, 200, { "retry-after": "259200" }));
    expect(await provider.createDraft(content).catch((e) => e)).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 259200, outcome: "failed" });
  });

  it("un refus typé (MutationError) est un échec certain", async () => {
    const { provider } = withWrite(() => json({ data: { createPost: { __typename: "InvalidInputError", message: "Text is required" } } }));
    expect(await provider.createDraft(content).catch((e) => e)).toMatchObject({ outcome: "failed" });
  });

  it("un résultat nul ou sans post ni message est inconnu, jamais un échec certain", async () => {
    for (const data of [{ createPost: null }, { createPost: { __typename: "PostActionSuccess" } }]) {
      const { provider } = withWrite(() => json({ data }));
      expect(await provider.createDraft(content).catch((e) => e), JSON.stringify(data)).toMatchObject({ outcome: "unknown" });
    }
  });

  it("un succès accompagné d'avertissements conserve l'identifiant du post créé", async () => {
    const { provider } = withWrite(() => json({ data: { createPost: { __typename: "PostActionSuccess", post: raw() } }, errors: [{ message: "Avertissement" }] }));
    expect((await provider.createDraft(content)).id).toBe("created-1");
  });

  it("HTTP 5xx et coupure : inconnus ; 2xx illisible : inconnu", async () => {
    const five = withWrite(() => new Response("oops", { status: 502 }));
    expect(await five.provider.createDraft(content).catch((e) => e)).toMatchObject({ outcome: "unknown", kind: "network" });
    const garbled = withWrite(() => new Response("<html>", { status: 200 }));
    expect(await garbled.provider.createDraft(content).catch((e) => e)).toMatchObject({ outcome: "unknown" });
    const cut = withWrite(() => { throw new TypeError("fetch failed"); });
    expect(await cut.provider.createDraft(content).catch((e) => e)).toMatchObject({ outcome: "unknown", kind: "network" });
  });

  it("une écriture n'est jamais rejouée par le client", async () => {
    const { provider, calls } = withWrite(() => new Response("oops", { status: 503 }));
    await provider.createDraft(content).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it("une création réussie mais dont le garde-fou échoue garde l'identifiant créé", async () => {
    const { provider } = withWrite(() => json({ data: { createPost: { __typename: "PostActionSuccess", post: raw({ status: "scheduled" }) } } }));
    const error = await provider.createDraft(content).catch((e) => e);
    expect(error.createdPostId).toBe("created-1");
  });
});

describe("lecture : erreurs GraphQL", () => {
  it("une lecture en erreur sans donnée est un échec certain (aucun effet possible)", async () => {
    const fetchImpl = vi.fn(async () => json({ data: null, errors: [{ message: "Internal", extensions: { code: "UNEXPECTED" } }] }));
    const provider = new BufferProvider("cle-factice", "À valider", fetchImpl as unknown as typeof fetch);
    expect(await provider.getPost("x").catch((e) => e)).toMatchObject({ outcome: "failed" });
  });
});

describe("réconciliation (findDraftCandidates)", () => {
  const snapshotWith = (active: unknown[], sent: unknown[] = [], extra: { sentNext?: boolean; errors?: unknown[] } = {}) => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("account")) return json({ data: { account: { organizations: [{ id: "org1" }] } } });
      return json({
        data: {
          channels: [{ id: "c1", service: "linkedin", name: "Colibri", displayName: null, avatar: null, isDisconnected: false }],
          active: { edges: active.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } },
          sent: { edges: sent.map((node) => ({ node })), pageInfo: { hasNextPage: !!extra.sentNext, endCursor: null } },
        },
        ...(extra.errors ? { errors: extra.errors } : {}),
      });
    });
    return new BufferProvider("cle-factice", "À valider", fetchImpl as unknown as typeof fetch);
  };
  const lookup = { channelId: "c1", text: "Audit", dueAt: DUE };

  it.each(["error", "sent", "scheduled", "needs_approval"])("retrouve un post existant au statut « %s »", async (status) => {
    const provider = snapshotWith(status === "sent" ? [] : [raw({ status })], status === "sent" ? [raw({ status })] : []);
    const found = await provider.findDraftCandidates(lookup);
    expect(found.candidates.map((post) => post.id)).toEqual(["created-1"]);
  });

  it("un post au texte identique mais à la date différente est une ressemblance, pas une correspondance", async () => {
    const provider = snapshotWith([raw({ dueAt: "2030-02-01T09:00:00.000Z" })]);
    const found = await provider.findDraftCandidates(lookup);
    expect(found.candidates).toEqual([]);
    expect(found.possible?.map((post) => post.id)).toEqual(["created-1"]);
  });

  it("des médias différents de ceux envoyés ne sont pas une correspondance exacte", async () => {
    const provider = snapshotWith([raw({ assets: [{ type: "video", mimeType: "video/mp4", source: "https://x/v.mp4", thumbnail: "" }] })]);
    const found = await provider.findDraftCandidates({ ...lookup, assetKinds: ["image"] });
    expect(found.candidates).toEqual([]);
    expect(found.possible).toHaveLength(1);
    const same = await snapshotWith([raw({ assets: [{ type: "image", mimeType: "image/jpeg", source: "https://x/i.jpg", thumbnail: "" }] })])
      .findDraftCandidates({ ...lookup, assetKinds: ["image"] });
    expect(same.candidates).toHaveLength(1);
  });

  it("un texte retouché dans Buffer n'est pas une correspondance exacte : il est signalé comme ressemblance", async () => {
    const found = await snapshotWith([raw({ text: "Texte retouché dans Buffer" })]).findDraftCandidates(lookup);
    expect(found.candidates).toEqual([]);
    expect(found.possible?.map((post) => post.id)).toEqual(["created-1"]);
  });

  it("texte ET date retouchés dans Buffer : rien n'est retrouvé, et ce n'est PAS une preuve d'absence (la lecture se dit complète)", async () => {
    const found = await snapshotWith([raw({ text: "Tout a changé", dueAt: "2031-01-01T00:00:00.000Z" })]).findDraftCandidates(lookup);
    expect(found.candidates).toEqual([]);
    expect(found.possible).toEqual([]);
    expect(found.complete).toBe(true);
  });

  it("la lecture n'est pas complète si les posts publiés sont tronqués, ou si Buffer a ajouté des avertissements", async () => {
    expect((await snapshotWith([], [], { sentNext: true }).findDraftCandidates(lookup)).complete).toBe(false);
    expect((await snapshotWith([raw()], [], { errors: [{ message: "Champ indisponible" }] }).findDraftCandidates(lookup)).complete).toBe(false);
    expect((await snapshotWith([raw()]).findDraftCandidates(lookup)).complete).toBe(true);
  });
});

describe("quota", () => {
  it("un Retry-After de plusieurs jours est transmis tel quel (HTTP 429)", async () => {
    const { provider } = withWrite(() => json({}, 429, { "retry-after": "172800" }));
    expect(await provider.updateDraft("p", content).catch((e) => e)).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 172800 });
  });
});
