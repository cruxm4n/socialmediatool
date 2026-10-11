import { describe, expect, it, vi } from "vitest";

import { BufferProvider, parseRateLimit } from "@/server/publishing/buffer-provider";
import { MockProvider } from "@/server/publishing/mock-provider";
import { BUFFER_READ_ONLY, ProviderError, sameContent, type ProviderPost } from "@/server/publishing/provider";

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

/**
 * Refus de lecture seule : l'opération rejette avec la phrase exacte et un résultat certain (« failed »), et aucune
 * mutation n'a quitté le serveur (aucun appel dont le corps contient « mutation »).
 */
async function expectReadOnlyRefusal(promise: Promise<unknown>, fetchImpl: typeof fetch) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({ message: BUFFER_READ_ONLY, kind: "api", outcome: "failed", refusal: "writes_disabled" });
  const sent = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  expect(sent.filter(([, init]) => String((init as RequestInit | undefined)?.body ?? "").includes("mutation"))).toHaveLength(0);
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

  it("refuse un changement de secondes ou une date invalide", () => {
    expect(sameContent(approved, { ...approved, dueAt: "2026-12-15T10:00:30.000Z" })).toBe(false);
    expect(sameContent({ ...approved, dueAt: "invalide" }, { ...approved, dueAt: "invalide" })).toBe(false);
  });

  it("ne confond pas des sources contenant des virgules avec plusieurs médias", () => {
    const one = [{ type: "image" as const, source: "a,image:b", thumbnail: "" }];
    const two = [{ type: "image" as const, source: "a", thumbnail: "" }, { type: "image" as const, source: "b", thumbnail: "" }];
    expect(sameContent({ ...approved, assets: one }, { ...approved, assets: two })).toBe(false);
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

  it("traite un post null comme une publication introuvable", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ data: { post: null } }));
    await expect(new BufferProvider("k", "À valider", fetchImpl).getPost("absent")).resolves.toBeNull();
  });

  it("programme un brouillon en renvoyant le texte, la date et le mode : la seule écriture de Cadence", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess", post: { ...RAW_POST, status: "scheduled" } } } }));
    const result = await new BufferProvider("k", "À valider", fetchImpl).schedulePost(livePost);
    expect(result.status).toBe("scheduled");
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("editPost");
    // Rien d'autre que le passage en « programmé » à la date déjà portée par le brouillon : ni tag, ni média, ni canal.
    expect(calls[0].variables).toEqual({
      input: { id: "p1", saveToDraft: false, mode: "customScheduled", schedulingType: "automatic", dueAt: "2026-12-15T10:00:00.000Z", text: "Bonjour" },
    });
  });

  it("renvoie le média quand le post n'a pas de texte (Buffer exige l'un ou l'autre)", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess", post: { ...RAW_POST, status: "scheduled" } } } }));
    await new BufferProvider("k", "À valider", fetchImpl).schedulePost({ ...livePost, text: "", assets: [{ type: "image", source: "https://img/1.jpg", thumbnail: "" }] });
    expect(calls[0].variables.input).toMatchObject({ id: "p1", saveToDraft: false, assets: [{ image: { url: "https://img/1.jpg" } }] });
    expect(calls[0].variables.input).not.toHaveProperty("text");
  });

  it("repasser un post en brouillon reste refusé, sans aucun appel réseau", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess", post: { ...RAW_POST, status: "draft" } } } }));
    await expectReadOnlyRefusal(new BufferProvider("k", "À valider", fetchImpl).unschedulePost(livePost), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("refuse de programmer un post sans date, sans aucun appel réseau", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => json({}));
    await expect(new BufferProvider("k", "À valider", fetchImpl).schedulePost({ ...livePost, dueAt: null })).rejects.toMatchObject({ name: "ProviderError", outcome: "failed", message: "Ce post n'a pas de date prévue." });
    expect(calls).toHaveLength(0);
  });

  it("remonte le refus de Buffer comme un échec certain", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ data: { editPost: { __typename: "InvalidInputError", message: "Invalid post: Post must have either text or media." } } }));
    await expect(new BufferProvider("k", "À valider", fetchImpl).schedulePost(livePost)).rejects.toMatchObject({
      name: "ProviderError", kind: "api", outcome: "failed", message: "Buffer a refusé la programmation : Invalid post: Post must have either text or media.",
    });
  });

  it("une réponse qui ne passe pas le post en « programmé » est un résultat incertain, jamais une réussite", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess", post: RAW_POST } } }));
    await expect(new BufferProvider("k", "À valider", fetchImpl).schedulePost(livePost)).rejects.toMatchObject({ name: "ProviderError", outcome: "unknown" });
    const empty = fakeBuffer(() => json({ data: { editPost: { __typename: "PostActionSuccess" } } }));
    await expect(new BufferProvider("k", "À valider", empty.fetchImpl).schedulePost(livePost)).rejects.toMatchObject({ name: "ProviderError", outcome: "unknown" });
  });

  it("signale le dépassement de quota avec le délai d'attente", async () => {
    const { fetchImpl } = fakeBuffer(() => json({ errors: [{ message: "RATE_LIMIT_EXCEEDED" }] }, { status: 429, headers: { "retry-after": "600" } }));
    const error = await new BufferProvider("k", "À valider", fetchImpl).getPost("p1").catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 600 });
  });

  it("retente une lecture une fois après une panne passagère, puis réussit", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET");
      return json({ data: { post: RAW_POST } });
    }) as unknown as typeof fetch;
    const post = await new BufferProvider("k", "À valider", fetchImpl).getPost("p1");
    expect(post?.id).toBe("p1");
    expect(attempts).toBe(2);
  });

  it("abandonne une lecture après deux pannes et le signale", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(new BufferProvider("k", "À valider", fetchImpl).getPost("p1")).rejects.toMatchObject({ kind: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ne retente jamais une écriture : on ignore si Buffer l'a prise en compte", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(new BufferProvider("k", "À valider", fetchImpl).schedulePost(livePost)).rejects.toMatchObject({ kind: "network", outcome: "unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("traite une erreur 5xx comme une panne passagère et une erreur 401 comme une clé invalide", async () => {
    const down = fakeBuffer(() => json({}, { status: 503 }));
    await expect(new BufferProvider("k", "À valider", down.fetchImpl).getPost("p1")).rejects.toMatchObject({ kind: "network" });
    expect(down.calls).toHaveLength(2);

    const denied = fakeBuffer(() => json({}, { status: 401 }));
    await expect(new BufferProvider("k", "À valider", denied.fetchImpl).getPost("p1")).rejects.toMatchObject({
      name: "ProviderError", kind: "api", outcome: "failed",
      message: "Buffer refuse la clé d'API de ce compte (invalide, révoquée ou expirée) : remplacez-la dans la connexion concernée.",
    });
    expect(denied.calls).toHaveLength(1);
  });

  it("ne conclut pas à des suppressions quand Buffer ne renvoie aucun canal", async () => {
    const { fetchImpl } = fakeBuffer((query) => {
      if (query.includes("account")) return json({ data: { account: { organizations: [{ id: "org1" }] } } });
      return json({ data: { channels: [], active: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } }, sent: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    });
    const snapshot = await new BufferProvider("k", "À valider", fetchImpl).fetchSnapshot();
    expect(snapshot.complete).toBe(false);
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

describe("brouillons du Studio dans Buffer", () => {
  const CONTENT = { channelId: "c1", service: "instagram", text: "Le Guji est de retour", dueAt: "2026-12-15T10:00:00.000Z", assets: [{ type: "image" as const, url: "https://stockage/a.jpg" }, { type: "video" as const, url: "https://stockage/b.mp4" }] };
  const withTag = (write: (query: string, variables: Record<string, unknown>) => Response) =>
    fakeBuffer((query, variables) => {
      if (query.includes("channel(input")) return json({ data: { channel: { organizationId: "org1" } } });
      if (query.includes("tagsV2")) return json({ data: { tagsV2: { edges: [{ node: { id: "tag-autre", name: "Promo" } }, { node: { id: "tag-valider", name: "À valider" } }] } } });
      return write(query, variables);
    });
  const success = (name: string, status = "draft") => json({ data: { [name]: { __typename: "PostActionSuccess", post: { ...RAW_POST, status } } } });

  it("crée toujours un brouillon tagué « à valider », jamais un post programmé — refusé, lecture seule", async () => {
    const { fetchImpl, calls } = withTag(() => success("createPost"));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", fetchImpl).createDraft(CONTENT), fetchImpl);
    expect(calls).toHaveLength(0);
  });

  it("refuse d'envoyer si le tag de validation n'existe pas dans Buffer, sans le créer — refusé, lecture seule", async () => {
    const { fetchImpl, calls } = fakeBuffer((query) =>
      query.includes("channel(input") ? json({ data: { channel: { organizationId: "org1" } } }) : json({ data: { tagsV2: { edges: [] } } }));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", fetchImpl).createDraft(CONTENT), fetchImpl);
    expect(calls.some((call) => call.query.includes("mutation"))).toBe(false);
  });

  it("si Buffer programme malgré tout le post créé, il est aussitôt repassé en brouillon — refusé, lecture seule", async () => {
    const mutations: Record<string, unknown>[] = [];
    const { fetchImpl } = withTag((query, variables) => {
      mutations.push(variables.input as Record<string, unknown>);
      return query.includes("createPost") ? success("createPost", "scheduled") : success("editPost", "draft");
    });
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", fetchImpl).createDraft(CONTENT), fetchImpl);
    expect(mutations).toHaveLength(0);
  });

  it("met à jour un brouillon existant sans en créer un second, et le laisse en brouillon — refusé, lecture seule", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => success("editPost"));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", fetchImpl).updateDraft("p1", { ...CONTENT, service: "linkedin", assets: [] }), fetchImpl);
    expect(calls).toHaveLength(0);
  });

  it("déplace un brouillon en renvoyant son texte, et refuse de déplacer un post programmé — refusé, lecture seule", async () => {
    const { fetchImpl, calls } = fakeBuffer(() => success("editPost"));
    const provider = new BufferProvider("cle", "À valider", fetchImpl);
    const draft = { id: "p1", channelId: "c1", service: "twitter", status: "draft", text: "Bonjour", dueAt: "2026-12-15T10:00:00.000Z", sentAt: null, updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [] } as ProviderPost;
    await expectReadOnlyRefusal(provider.rescheduleDraft(draft, "2026-12-20T10:00:00.000Z"), fetchImpl);
    await expectReadOnlyRefusal(provider.rescheduleDraft({ ...draft, status: "scheduled" }, "2026-12-20T10:00:00.000Z"), fetchImpl);
    expect(calls).toHaveLength(0);
  });

  it("remonte le refus de Buffer à la création — refusé, lecture seule", async () => {
    const { fetchImpl, calls } = withTag(() => json({ data: { createPost: { __typename: "LimitReachedError", message: "Scheduled posts limit reached" } } }));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", fetchImpl).createDraft(CONTENT), fetchImpl);
    expect(calls).toHaveLength(0);
  });

  it("Buffer simulé : crée, met à jour et déplace un brouillon, sans jamais programmer", async () => {
    const provider = new MockProvider(`studio-${Date.now()}`);
    const [channel] = (await provider.fetchSnapshot()).channels;
    const created = await provider.createDraft({ ...CONTENT, channelId: channel.id });
    expect(created).toMatchObject({ status: "draft", hasReviewTag: true });
    expect(created.id).toMatch(/^mock-studio-\d+-studio-1$/);
    expect((await provider.updateDraft(created.id, { ...CONTENT, channelId: channel.id, text: "Corrigé" })).text).toBe("Corrigé");
    expect((await provider.rescheduleDraft(created, "2027-01-01T10:00:00.000Z")).dueAt).toBe("2027-01-01T10:00:00.000Z");
    expect(provider.scheduleCalls).toBe(0);
    provider.failNextCreate("Limite atteinte");
    await expect(provider.createDraft({ ...CONTENT, channelId: channel.id })).rejects.toThrow("Limite atteinte");
    await expect(provider.createDraft({ ...CONTENT, channelId: "inconnu" })).rejects.toThrow("Canal introuvable");
  });
});

describe("résultat d'une écriture Buffer : certain ou inconnu (audit B6)", () => {
  const CONTENT = { channelId: "c1", service: "linkedin", text: "Bonjour", dueAt: "2026-12-15T10:00:00.000Z", assets: [] };
  /** Lectures normales (canal, tag) puis un comportement choisi pour la mutation. */
  const withWrite = (write: () => Response | Promise<Response>) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body));
      calls.push(query);
      if (query.includes("channel(input")) return json({ data: { channel: { organizationId: "org1" } } });
      if (query.includes("tagsV2")) return json({ data: { tagsV2: { edges: [{ node: { id: "tag", name: "À valider" } }] } } });
      return write();
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as ProviderError;
    }
    throw new Error("aucune erreur levée");
  };

  it("un délai dépassé pendant une création est un résultat INCONNU et n'est jamais retenté — refusé, lecture seule", async () => {
    const { fetchImpl, calls } = withWrite(() => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", fetchImpl).createDraft(CONTENT), fetchImpl);
    expect(calls.filter((query) => query.includes("createPost"))).toHaveLength(0);
  });

  it("lecture : une réponse 2xx illisible est une erreur signalée, jamais un résultat vide ni une disparition", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>passerelle</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const provider = new BufferProvider("cle", "À valider", fetchImpl);
    const error = await provider.getPost("p1").then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "api", message: "Réponse de Buffer illisible : l'opération a peut-être été appliquée." });
    // Une lecture en erreur ne doit jamais être prise pour « ce post n'existe plus ».
    await expect(provider.fetchSnapshot()).rejects.toMatchObject({ kind: "api" });
  });

  it("une erreur 5xx pendant une création est inconnue ; une réponse 2xx illisible aussi — refusé, lecture seule", async () => {
    const five = withWrite(() => new Response("oups", { status: 502 }));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", five.fetchImpl).createDraft(CONTENT), five.fetchImpl);
    const garbled = withWrite(() => new Response("<html>", { status: 200 }));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", garbled.fetchImpl).createDraft(CONTENT), garbled.fetchImpl);
  });

  it("un refus applicatif, un quota ou une clé refusée sont des échecs certains, avec le délai de reprise — refusé, lecture seule", async () => {
    const refused = withWrite(() => json({ data: { createPost: { __typename: "MutationError", message: "Texte vide" } } }));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", refused.fetchImpl).createDraft(CONTENT), refused.fetchImpl);
    const quota = withWrite(() => json({}, { status: 429, headers: { "retry-after": "600" } }));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", quota.fetchImpl).createDraft(CONTENT), quota.fetchImpl);
    const key = withWrite(() => json({}, { status: 401 }));
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", key.fetchImpl).createDraft(CONTENT), key.fetchImpl);
  });

  it("brouillon créé puis remise en brouillon impossible : l'identifiant du brouillon accompagne l'erreur — refusé, lecture seule", async () => {
    let writes = 0;
    const { fetchImpl } = withWrite(() => {
      writes += 1;
      if (writes === 1) return json({ data: { createPost: { __typename: "PostActionSuccess", post: { ...RAW_POST, id: "cree-9", status: "scheduled" } } } });
      throw Object.assign(new Error("coupure"), { name: "TimeoutError" });
    });
    await expectReadOnlyRefusal(new BufferProvider("cle", "À valider", fetchImpl).createDraft(CONTENT), fetchImpl);
    expect(writes).toBe(0);
  });

  it("la réconciliation lit sans écrire : elle ne retient que le canal, le texte et l'instant exacts", async () => {
    const queries: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body));
      queries.push(query);
      if (query.includes("account")) return json({ data: { account: { organizations: [{ id: "org1" }] } } });
      return json({
        data: {
          channels: [{ id: "c1", service: "linkedin", name: "A", displayName: null, avatar: null, isDisconnected: false }],
          active: {
            edges: [
              { node: { ...RAW_POST, id: "bon", channelId: "c1", text: "Bonjour", dueAt: "2026-12-15T10:00:00.000Z" } },
              { node: { ...RAW_POST, id: "autre-texte", channelId: "c1", text: "Bonsoir" } },
              { node: { ...RAW_POST, id: "autre-canal", channelId: "c2", text: "Bonjour" } },
              { node: { ...RAW_POST, id: "autre-date", channelId: "c1", text: "Bonjour", dueAt: "2026-12-16T10:00:00.000Z" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          sent: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      });
    }) as unknown as typeof fetch;
    const found = await new BufferProvider("cle", "À valider", fetchImpl).findDraftCandidates({ channelId: "c1", text: "Bonjour", dueAt: "2026-12-15T10:00:00+00:00" });
    expect(found.candidates.map((post) => post.id)).toEqual(["bon"]);
    expect(found.complete).toBe(true);
    expect(queries.some((query) => query.includes("mutation"))).toBe(false);
  });

  it("le Buffer simulé sait perdre une réponse après avoir créé le brouillon", async () => {
    const provider = new MockProvider(`perte-${Date.now()}`);
    const channel = (await provider.fetchSnapshot()).channels[0];
    provider.loseNextCreateResponse();
    const error = await failure(provider.createDraft({ ...CONTENT, channelId: channel.id }));
    expect(error.outcome).toBe("unknown");
    expect(provider.createCalls).toBe(1);
    const found = await provider.findDraftCandidates({ channelId: channel.id, text: CONTENT.text, dueAt: CONTENT.dueAt });
    expect(found.candidates).toHaveLength(1);
  });
});
