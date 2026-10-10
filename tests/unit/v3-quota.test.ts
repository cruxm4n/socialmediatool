import { describe, expect, it, vi } from "vitest";

import { BufferProvider, parseRetryAfter } from "@/server/publishing/buffer-provider";
import type { DraftContent } from "@/server/publishing/provider";

/*
 * (Mission V3, C08) Retry-After : durées conservées sans raccourcissement, formes valides non numériques, valeur absente
 * ou invalide ; et comptage des requêtes par opération (base du budget de quota du pilote, docs/EXPLOITATION.md).
 * Aucun appel réseau : fetch est remplacé.
 */

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const DUE = "2030-01-15T09:00:00.000Z";
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: "p1", channelId: "c1", channelService: "linkedin", text: "Texte", dueAt: DUE, status: "draft", sentAt: null, updatedAt: null,
  externalLink: null, schedulingType: "automatic", error: null, tags: [{ name: "À valider" }], assets: [], ...overrides,
});
const content: DraftContent = { channelId: "c1", service: "linkedin", text: "Texte", dueAt: DUE, assets: [] };

describe("Retry-After", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");

  it("durées numériques conservées telles quelles : 15 minutes, 48 heures, 30 jours", () => {
    expect(parseRetryAfter("900", now)).toBe(900);
    expect(parseRetryAfter("172800", now)).toBe(172_800);
    expect(parseRetryAfter("2592000", now)).toBe(2_592_000);
    // Au-delà de 30 jours : conservée par le transport (la base plafonne à la fenêtre de 30 jours documentée).
    expect(parseRetryAfter("5184000", now)).toBe(5_184_000);
  });

  it("date HTTP valide (RFC 9110) : durée jusqu'à cette date, arrondie au-dessus", () => {
    expect(parseRetryAfter("Sat, 10 Oct 2026 12:15:00 GMT", now)).toBe(900);
    expect(parseRetryAfter("Mon, 12 Oct 2026 12:00:00 GMT", now)).toBe(172_800);
  });

  it("absent, vide, invalide, nul, négatif ou dans le passé : aucune durée (la pause par défaut s'applique)", () => {
    for (const value of [null, "", "   ", "bientôt", "-30", "0", "1.5e3", "Fri, 09 Oct 2026 12:00:00 GMT"]) {
      expect(parseRetryAfter(value, now), String(value)).toBeUndefined();
    }
  });

  it.each([
    ["172800", 172_800],
    ["Mon, 12 Oct 2026 12:00:00 GMT", undefined],
  ])("transporté depuis la réponse HTTP 429 (%s)", async (header, expected) => {
    vi.useFakeTimers({ now });
    try {
      const fetchImpl = vi.fn(async () => json({}, 429, { "retry-after": header }));
      const provider = new BufferProvider("cle", "À valider", fetchImpl as unknown as typeof fetch);
      const error = await provider.getPost("p1").catch((e) => e);
      expect(error).toMatchObject({ kind: "rate_limit", outcome: "failed" });
      expect(error.retryAfterSeconds).toBe(expected ?? 172_800);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("comptage des requêtes Buffer par opération (budget de quota)", () => {
  /** Fournisseur dont chaque requête est comptée par nature. */
  function counted() {
    const counts: Record<string, number> = {};
    const bump = (name: string) => {
      counts[name] = (counts[name] ?? 0) + 1;
    };
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("account { organizations")) {
        bump("organisation");
        return json({ data: { account: { organizations: [{ id: "org1" }] } } });
      }
      if (query.includes("query Snapshot")) {
        bump("instantané (page)");
        return json({
          data: {
            channels: [{ id: "c1", service: "linkedin", name: "C", displayName: null, avatar: null, isDisconnected: false }],
            active: { edges: [{ node: raw() }], pageInfo: { hasNextPage: false, endCursor: null } },
            sent: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        });
      }
      if (query.includes("query Post(")) {
        bump("lecture d'un post");
        return json({ data: { post: raw() } });
      }
      if (query.includes("query Channel")) {
        bump("canal (tag)");
        return json({ data: { channel: { organizationId: "org1" } } });
      }
      if (query.includes("tagsV2")) {
        bump("tags");
        return json({ data: { tagsV2: { edges: [{ node: { id: "t1", name: "À valider" } }] } } });
      }
      if (query.includes("createPost")) {
        bump("écriture : création");
        return json({ data: { createPost: { __typename: "PostActionSuccess", post: raw() } } });
      }
      if (query.includes("editPost")) {
        bump("écriture : modification");
        const input = JSON.parse(String(init?.body)).variables.input;
        return json({ data: { editPost: { __typename: "PostActionSuccess", post: raw({ status: input.saveToDraft ? "draft" : "scheduled" }) } } });
      }
      return json({ data: {} });
    });
    return { provider: new BufferProvider("cle", "À valider", fetchImpl as unknown as typeof fetch), counts, total: () => fetchImpl.mock.calls.length };
  }

  it("un poll complet : 1 requête d'organisation (une fois par processus) + 1 par page ; un poll suivant : 1", async () => {
    const { provider, total } = counted();
    await provider.fetchSnapshot();
    expect(total()).toBe(2);
    await provider.fetchSnapshot();
    expect(total()).toBe(3);
  });

  it("programmer un post : 1 lecture + 1 écriture ; l'annuler : 1 lecture + 1 écriture", async () => {
    const { provider, counts, total } = counted();
    const live = (await provider.getPost("p1"))!;
    await provider.schedulePost(live);
    expect(total()).toBe(2);
    expect(counts).toMatchObject({ "lecture d'un post": 1, "écriture : modification": 1 });
    await provider.unschedulePost((await provider.getPost("p1"))!);
    expect(total()).toBe(4);
  });

  it("créer un brouillon : canal + tags (1re fois) + création ; ensuite canal + création", async () => {
    const { provider, total } = counted();
    await provider.createDraft(content);
    expect(total()).toBe(3);
    await provider.createDraft(content);
    expect(total()).toBe(5);
  });
});
