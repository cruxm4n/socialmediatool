import { describe, expect, it, vi } from "vitest";

import { BufferProvider, parseRateLimit } from "@/server/publishing/buffer-provider";
import { MockProvider } from "@/server/publishing/mock-provider";
import { ProviderError, sameContent, type ProviderPost } from "@/server/publishing/provider";

const RAW_POST = {
  id: "p1",
  status: "draft",
  text: "Bonjour",
  dueAt: "2026-12-15T10:00:00.000Z",
  sentAt: null,
  updatedAt: "2026-10-08T19:11:38.948Z",
  externalLink: null,
  channelId: "c1",
  channelService: "twitter",
  schedulingType: "automatic",
  error: null,
  tags: [{ name: "à VALIDER " }],
  assets: [{ type: "image", mimeType: "image/jpeg", source: "https://img/1.jpg", thumbnail: "https://img/1-t.jpg" }],
};

function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers: { "content-type": "application/json", ...init.headers } });
}

/** Faux fetch : répond selon le texte de la requête GraphQL et garde la trace des appels. */
function fakeBuffer(handlers: (query: string, variables: Record<string, unknown>) => Response) {
  const calls: { query: string; variables: Record<string, unknown>; authorization: string }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ query: body.query, variables: body.variables, authorization: (init?.headers as Record<string, string>).Authorization });
    return handlers(body.query, body.variables);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("lecture du quota Buffer", () => {
  it("extrait le reste de chaque fenêtre", () => {
    expect(parseRateLimit('"100-in-15min"; r=98; t=897, "500-in-1day"; r=480; t=86397')).toEqual({ "100-in-15min": 98, "500-in-1day": 480 });
    expect(parseRateLimit(null)).toBeNull();
  });
});

describe("comparaison du contenu validé et du contenu Buffer", () => {
  const approved = { text: "Bonjour", dueAt: "2026-12-15T10:00:00+00:00", assets: [{ type: "image" as const, source: "a", thumbnail: "t" }] };

  it("accepte un contenu identique, quelle que soit l'écriture de la date", () => {
    expect(sameContent(approved, { text: "Bonjour", dueAt: "2026-12-15T10:00:00.000Z", assets: [{ type: "image", source: "a", thumbnail: "autre" }] })).toBe(true);
  });

  it("détecte un changement de texte, de date ou de média", () => {
    const live = { text: "Bonjour", dueAt: "2026-12-15T10:00:00.000Z", assets: approved.assets };
    expect(sameContent(approved, { ...live, text: "Bonsoir" })).toBe(false);
    expect(sameContent(approved, { ...live, dueAt: "2026-12-15T11:00:00.000Z" })).toBe(false);
    expect(sameContent(approved, { ...live, assets: [] })).toBe(false);
  });
});

describe("client de l'API Buffer", () => {
  it("récupère canaux et posts, reconnaît le tag de validation et transmet la clé", async () => {
    const { fetchImpl, calls } = fakeBuffer((query) => {
      if (query.includes("account")) return json({ data: { account: { organizations: [{ id: "org1" }] } } });
      return json(
        {
          data: {
            channels: [{ id: "c1", service: "twitter", name: "Amollety", displayName: "Amollety", avatar: null, isDisconnected: false }],
            active: { edges: [{ node: RAW_POST }], pageInfo: { hasNextPage: false, endCursor: null } },
            sent: { edges: [{ node: { ...RAW_POST, id: "p2", status: "sent", tags: [] } }], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
        { headers: { ratelimit: '"100-in-15min"; r=90; t=100' } },
      );
    });
    const snapshot = await new BufferProvider("cle-secrete", "À valider", fetchImpl).fetchSnapshot();

    expect(calls.every((call) => call.authorization === "Bearer cle-secrete")).toBe(true);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.rateLimit).toEqual({ "100-in-15min": 90 });
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.posts.map((post) => [post.id, post.status, post.hasReviewTag])).toEqual([
      ["p1", "draft", true],
      ["p2", "sent", false],
    ]);
    expect(snapshot.posts[0]).toMatchObject({ service: "twitter", channelId: "c1", assets: [{ type: "image", source: "https://img/1.jpg" }] });
  });

  const livePost: ProviderPost = {
    id: "p1", channelId: "c1", service: "twitter", status: "draft", text: "Bonjour", dueAt: "2026-12-15T10:00:00.000Z",
    sentAt: null, updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [],
  };

  it("programme un brouillon en renvoyant le texte, la date et le mode", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess", post: { ...RAW_POST, status: "scheduled" } } } }));
    const result = await new BufferProvider("k", "À valider", fetchImpl).schedulePost(livePost);

    expect(result.status).toBe("scheduled");
    expect(calls[0].variables.input).toEqual({
      id: "p1", saveToDraft: false, text: "Bonjour", mode: "customScheduled", schedulingType: "automatic", dueAt: "2026-12-15T10:00:00.000Z",
    });
  });

  it("renvoie le média quand le post n'a pas de texte", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess", post: { ...RAW_POST, status: "draft" } } } }));
    await new BufferProvider("k", "À valider", fetchImpl).unschedulePost({
      ...livePost, text: "", assets: [{ type: "image", source: "https://img/1.jpg", thumbnail: "" }],
    });
    expect(calls[0].variables.input).toEqual({ id: "p1", saveToDraft: true, assets: [{ image: { url: "https://img/1.jpg" } }] });
  });

  it("refuse de programmer un post sans date", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => json({}));
    await expect(new BufferProvider("k", "À valider", fetchImpl).schedulePost({ ...livePost, dueAt: null })).rejects.toThrow("date");
    expect(calls).toHaveLength(0);
  });

  it("remonte le refus de Buffer comme une erreur", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ data: { editPost: { __typename: "InvalidInputError", message: "Invalid post: Post must have either text or media." } } }));
    await expect(new BufferProvider("k", "À valider", fetchImpl).schedulePost(livePost)).rejects.toThrow("Post must have either text or media");
  });

  it("considère comme un échec une réponse qui ne passe pas le post en « programmé »", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess", post: RAW_POST } } }));
    await expect(new BufferProvider("k", "À valider", fetchImpl).schedulePost(livePost)).rejects.toThrow("n'a pas programmé");
  });

  it("signale le dépassement de quota avec le délai d'attente", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ errors: [{ message: "RATE_LIMIT_EXCEEDED" }] }, { status: 429, headers: { "retry-after": "600" } }));
    const error = await new BufferProvider("k", "À valider", fetchImpl).getPost("p1").catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 600 });
  });

  it("signale une panne réseau sans faire échouer le serveur", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(new BufferProvider("k", "À valider", fetchImpl).getPost("p1")).rejects.toMatchObject({ kind: "network" });
  });
});

describe("Buffer simulé", () => {
  it("programme, déprogramme et simule un échec", async () => {
    const provider = new MockProvider(`unit-${Date.now()}`);
    const snapshot = await provider.fetchSnapshot();
    const draft = snapshot.posts.find((post) => post.status === "draft" && post.hasReviewTag)!;
    expect(draft.id.startsWith("mock-")).toBe(true);
    expect(snapshot.channels.every((channel) => channel.id.startsWith("mock-"))).toBe(true);

    expect((await provider.schedulePost(draft)).status).toBe("scheduled");
    expect((await provider.getPost(draft.id))?.status).toBe("scheduled");
    expect((await provider.unschedulePost(draft)).status).toBe("draft");

    provider.failNextSchedule("Canal déconnecté");
    await expect(provider.schedulePost(draft)).rejects.toThrow("Canal déconnecté");
    expect((await provider.schedulePost(draft)).status).toBe("scheduled");
    expect(provider.scheduleCalls).toBe(3);
  });
});
