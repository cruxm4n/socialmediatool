import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * (Mission V3, C11) Préparation au service ≠ liveness : configuration absente, migration manquante, base injoignable
 * ou secret refusé font échouer le contrôle, sans jamais renvoyer de valeur de configuration.
 */
let answer: unknown = { ready: true, checks: { "0006": true, "0007": true, "0008": true, "0009": true, "0010": true, "0011": true, "0012": true } };
let failure: Error | null = null;
vi.mock("@/server/automation-rpc", () => {
  class MissingFunctionError extends Error {}
  return {
    MissingFunctionError,
    rpc: async () => {
      if (failure) throw failure;
      return answer;
    },
  };
});

const { readiness } = await import("@/server/readiness");

const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "AUTOMATION_SECRET", "BUFFER_MODE", "BUFFER_API_KEY", "CADENCE_PROFILE", "NOTIFICATIONS_MODE", "NOTIFICATIONS_CONTENT", "APP_URL"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const configure = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
};
const GOOD = {
  NEXT_PUBLIC_SUPABASE_URL: "https://projet.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x", AUTOMATION_SECRET: "un-secret-assez-long-0123456789", BUFFER_MODE: "mock",
};

beforeEach(() => {
  answer = { ready: true, checks: { "0006": true, "0007": true, "0008": true, "0009": true, "0010": true, "0011": true, "0012": true, "0013": true, "0014": true } };
  failure = null;
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("readiness", () => {
  it("configuration complète, migrations en place : prête", async () => {
    configure(GOOD);
    const result = await readiness();
    expect(result.ready).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("base sans la migration 0012 (connexions fournisseur) : non prête, la migration est nommée", async () => {
    configure(GOOD);
    answer = { ready: true, checks: { "0006": true, "0007": true, "0008": true, "0009": true, "0010": true, "0011": true } };
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(["migration 0012 en place"]);
  });

  it("une migration manquante : non prête, la migration est nommée", async () => {
    configure(GOOD);
    answer = { ready: false, checks: { "0006": true, "0007": true, "0008": true, "0009": true, "0010": true, "0011": false, "0012": true } };
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => !check.ok)?.name).toContain("0011");
  });

  it("configuration absente : non prête, la base n'est même pas interrogée", async () => {
    configure({});
    failure = new Error("ne doit pas être appelée");
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks.some((check) => check.name.includes("non vérifiée"))).toBe(true);
  });

  it("base injoignable ou secret refusé : non prête", async () => {
    configure(GOOD);
    failure = new Error("fetch failed");
    expect((await readiness()).ready).toBe(false);
  });

  it("fonction absente (migration 0011 non appliquée) : non prête, avec un nom explicite", async () => {
    configure(GOOD);
    const { MissingFunctionError } = await import("@/server/automation-rpc");
    failure = new MissingFunctionError("absente");
    const result = await readiness();
    expect(result.ready).toBe(false);
    expect(result.checks.at(-1)?.name).toContain("0011 absente");
  });

  it("mode réel sans clé de chiffrement des connexions, adresse en HTTP non locale, secret trop court : non prête", async () => {
    configure({ ...GOOD, BUFFER_MODE: "real" });
    expect((await readiness()).ready).toBe(false);
    configure({ ...GOOD, NEXT_PUBLIC_SUPABASE_URL: "http://projet.exemple.org" });
    expect((await readiness()).ready).toBe(false);
    configure({ ...GOOD, AUTOMATION_SECRET: "court" });
    expect((await readiness()).ready).toBe(false);
  });

  it("profil pilote avec un réglage d'envoi réel ou de contenu détaillé : non prête (erreur de configuration)", async () => {
    configure({ ...GOOD, CADENCE_PROFILE: "pilot", NOTIFICATIONS_MODE: "webhook" });
    expect((await readiness()).ready).toBe(false);
    configure({ ...GOOD, CADENCE_PROFILE: "pilot", NOTIFICATIONS_CONTENT: "full" });
    expect((await readiness()).ready).toBe(false);
    configure({ ...GOOD, CADENCE_PROFILE: "pilot" });
    expect((await readiness()).ready).toBe(true);
  });

  it("la réponse ne contient aucune valeur de configuration", async () => {
    configure({ ...GOOD, APP_URL: "https://cadence.example.org" });
    const dump = JSON.stringify(await readiness());
    expect(dump).not.toContain(GOOD.AUTOMATION_SECRET);
    expect(dump).not.toContain(GOOD.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    expect(dump).not.toContain("supabase.co");
    expect(dump).not.toContain("cadence.example.org");
  });
});
