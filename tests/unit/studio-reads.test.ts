import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Lectures du Studio : un média ancien ne disparaît pas derrière le plafond de la liste, et une panne
 * n'est jamais présentée comme une migration absente (audit, phase 2).
 */

type Result = { data: Record<string, unknown>[] | null; error: { code?: string; message: string } | null };
let mainResult: Result;
let referencedResult: Result;
const queries: { table: string; method: string; args: unknown[] }[] = [];

function builder(table: string) {
  let isReferenced = false;
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "is"]) {
    query[method] = (...args: unknown[]) => {
      queries.push({ table, method, args });
      return query;
    };
  }
  query.in = (...args: unknown[]) => {
    queries.push({ table, method: "in", args });
    isReferenced = true;
    return query;
  };
  query.then = (resolve: (value: unknown) => void) => resolve(isReferenced ? referencedResult : mainResult);
  query.maybeSingle = async () => mainResult;
  return query;
}

vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => ({
    from: builder,
    storage: { from: () => ({ createSignedUrls: async (paths: string[]) => ({ data: paths.map((path) => ({ path, signedUrl: `https://s/${path}` })), error: null }) }) },
  }),
}));
vi.mock("@/server/data", () => ({ listChannels: async () => [] }));
vi.mock("@/server/publishing", () => ({ getProvider: () => ({}) }));
vi.mock("@/server/sync", () => ({ runSync: vi.fn(), recordRateLimit: vi.fn() }));

const { listMedia, listStudioDrafts, getStudioDraft, listPostVersions } = await import("@/server/studio");

const media = (id: string, extra: Record<string, unknown> = {}) => ({
  id, organization_id: "o1", storage_path: `o1/${id}.jpg`, file_name: `${id}.jpg`, kind: "image", mime_type: "image/jpeg", size_bytes: 1, width: 1, height: 1,
  duration_ms: null, created_at: "2026-10-01T00:00:00Z", archived_at: null, ...extra,
});

beforeEach(() => {
  queries.length = 0;
  mainResult = { data: [], error: null };
  referencedResult = { data: [], error: null };
});

describe("médias", () => {
  it("un média ancien explicitement référencé est lu à part, hors du plafond de la liste", async () => {
    mainResult = { data: [media("recent")], error: null };
    referencedResult = { data: [media("ancien")], error: null };
    const result = await listMedia("o1", ["ancien"]);
    expect(result?.map((item) => item.id)).toEqual(["recent", "ancien"]);
    expect(queries.find((query) => query.method === "in")?.args).toEqual(["id", ["ancien"]]);
  });

  it("ne relit rien de plus quand tous les médias référencés sont déjà dans la liste", async () => {
    mainResult = { data: [media("a")], error: null };
    await listMedia("o1", ["a"]);
    expect(queries.some((query) => query.method === "in")).toBe(false);
  });

  it("un média archivé reste disponible pour le contenu qui l'utilise", async () => {
    mainResult = { data: [media("a", { archived_at: "2026-10-02T00:00:00Z" }), media("b", { archived_at: "2026-10-02T00:00:00Z" })], error: null };
    expect((await listMedia("o1", ["a"]))?.map((item) => item.id)).toEqual(["a"]);
  });
});

describe("erreurs de lecture", () => {
  it("une table absente signifie « migration non appliquée » (null)", async () => {
    mainResult = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    expect(await listStudioDrafts()).toBeNull();
    expect(await listMedia(null)).toBeNull();
    expect(await listPostVersions("p")).toEqual([]);
  });

  it("toute autre erreur est levée : une panne n'est pas présentée comme une migration absente", async () => {
    mainResult = { data: null, error: { code: "57P01", message: "connexion interrompue" } };
    await expect(listStudioDrafts()).rejects.toThrow("connexion interrompue");
    await expect(listMedia(null)).rejects.toThrow("connexion interrompue");
    await expect(listPostVersions("p")).rejects.toThrow("connexion interrompue");
    await expect(getStudioDraft("11111111-1111-4111-8111-111111111111")).rejects.toThrow("connexion interrompue");
  });
});
