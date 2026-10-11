import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Comptes clients créés par l'administrateur : mot de passe généré par le serveur, renvoyé à l'administrateur seul,
 * conservé chiffré. La base et le service des comptes sont remplacés par des doublures.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SERVICE_KEY = "cle-de-service-tres-secrete";

let role: "admin" | "client" | null = "admin";
let targetRole: "admin" | "client" | null = "client";
const automationCalls: { name: string; params: Record<string, unknown> }[] = [];
const sessionCalls: { name: string; params: Record<string, unknown> }[] = [];
let stored: { ciphertext: string; keyVersion: number } | null = null;
let storeFails = false;
/** Réponses successives de admin_add_user. Par défaut : adresse inconnue, puis accès accordé une fois le compte créé. */
let addUserErrors: (string | null)[] = ["user_not_found", null];

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth", () => ({
  getSession: async () => (role ? { profile: { id: ADMIN, fullName: "Alex", jobTitle: "", role }, organizations: [] } : null),
}));
vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      sessionCalls.push({ name, params });
      const failure = name === "admin_add_user" ? (addUserErrors.shift() ?? null) : null;
      return failure ? { data: null, error: { message: failure } } : { data: USER, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: targetRole ? { role: targetRole } : null }) }) }) }),
  }),
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      automationCalls.push({ name, params });
      if (name === "server_set_user_password") {
        if (storeFails) return { data: null, error: { message: "panne" } };
        stored = { ciphertext: String(params.p_ciphertext), keyVersion: Number(params.p_key_version) };
        return { data: null, error: null };
      }
      if (name === "server_get_user_password") return { data: stored, error: null };
      return { data: null, error: null };
    },
  }),
}));

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[] = [];
let answer: (call: Call) => Response = () => new Response(JSON.stringify({ id: USER }), { status: 200 });

beforeEach(() => {
  role = "admin";
  targetRole = "client";
  automationCalls.length = 0;
  sessionCalls.length = 0;
  stored = null;
  storeFails = false;
  addUserErrors = ["user_not_found", null];
  calls = [];
  answer = () => new Response(JSON.stringify({ id: USER }), { status: 200 });
  vi.stubEnv("AUTOMATION_SECRET", "secret-de-test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "cle-publique");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  vi.stubEnv("CADENCE_CREDENTIALS_KEY", randomBytes(32).toString("base64"));
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), method: String(init?.method), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return answer(call);
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const load = () => import("@/server/user-actions");
const input = { organizationId: ORG, email: "  Camille@Exemple.fr ", fullName: "Camille Durand", jobTitle: "Marketing" };

describe("création du compte d'un utilisateur client", () => {
  it("crée le compte, génère le mot de passe, le conserve chiffré, donne l'accès et le renvoie à l'administrateur", async () => {
    const { createClientUser } = await load();
    const result = await createClientUser(input);
    expect(result).toMatchObject({ ok: true, email: "camille@exemple.fr", message: "Compte créé et accès accordé." });
    expect(result.password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);

    // Un seul appel au service des comptes : création confirmée, avec la clé de service côté serveur.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:1/auth/v1/admin/users", method: "POST", body: { email: "camille@exemple.fr", password: result.password, email_confirm: true } });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);

    // La base ne reçoit qu'un texte chiffré : jamais le mot de passe.
    const set = automationCalls.find((call) => call.name === "server_set_user_password")!;
    expect(set.params).toMatchObject({ p_actor: ADMIN, p_user_id: USER, p_key_version: 1 });
    expect(String(set.params.p_ciphertext)).toMatch(/^v1\./);
    expect(JSON.stringify(automationCalls)).not.toContain(result.password);
    expect(JSON.stringify(sessionCalls)).not.toContain(result.password);
    const grant = { name: "admin_add_user", params: { p_organization_id: ORG, p_email: "camille@exemple.fr", p_full_name: "Camille Durand", p_job_title: "Marketing" } };
    expect(sessionCalls).toEqual([grant, grant]);
  });

  it("deux comptes ne reçoivent jamais le même mot de passe", async () => {
    const { createClientUser } = await load();
    const passwords = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      addUserErrors = ["user_not_found", null];
      passwords.add((await createClientUser(input)).password!);
    }
    expect(passwords.size).toBe(20);
  });

  it("réservée à l'administrateur : un client ou un visiteur ne crée rien", async () => {
    const { createClientUser } = await load();
    role = "client";
    expect(await createClientUser(input)).toEqual({ ok: false, message: "Réservé à l'administrateur." });
    role = null;
    expect(await createClientUser(input)).toMatchObject({ ok: false, expired: true });
    expect(calls).toEqual([]);
    expect(automationCalls).toEqual([]);
    expect(sessionCalls).toEqual([]);
  });

  it("sans clé d'administration des comptes ou sans clé de chiffrement : refus net, aucun appel", async () => {
    const { createClientUser } = await load();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await createClientUser(input)).ok).toBe(false);
    addUserErrors = ["user_not_found", null];
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
    vi.stubEnv("CADENCE_CREDENTIALS_KEY", "");
    expect((await createClientUser(input)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("adresse qui a déjà un compte : seul l'accès est accordé, aucun appel au service des comptes, mot de passe inchangé", async () => {
    addUserErrors = [null];
    const { createClientUser } = await load();
    const result = await createClientUser(input);
    expect(result).toEqual({ ok: true, message: "Accès accordé à ce compte existant. Son mot de passe n'a pas été changé." });
    expect(calls).toEqual([]);
    expect(automationCalls).toEqual([]);
  });

  it("un administrateur ou un refus de la base n'aboutit jamais à une création", async () => {
    const { createClientUser } = await load();
    for (const code of ["not_a_client", "not_found", "forbidden"]) {
      addUserErrors = [code];
      expect((await createClientUser(input)).ok, code).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("adresse inconnue sans nom : rien n'est créé, le nom est demandé", async () => {
    const { createClientUser } = await load();
    const result = await createClientUser({ ...input, fullName: " " });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Aucun compte ne correspond à cet e-mail.");
    expect(calls).toEqual([]);
  });

  it("saisie invalide : rien n'est envoyé", async () => {
    const { createClientUser } = await load();
    expect((await createClientUser({ ...input, email: "pas-une-adresse" })).ok).toBe(false);
    expect(calls).toEqual([]);
    expect(sessionCalls).toEqual([]);
  });

  it("compte créé mais mot de passe non conservé : il est tout de même remis à l'administrateur, avec l'avertissement", async () => {
    storeFails = true;
    const { createClientUser } = await load();
    const result = await createClientUser(input);
    expect(result.ok).toBe(true);
    expect(result.password).toMatch(/^.{20}$/);
    expect(result.message).toContain("ne pourra pas être réaffiché");
  });

  it("la clé de service n'apparaît dans aucun résultat, même en cas de panne", async () => {
    answer = () => { throw new Error(`échec avec ${SERVICE_KEY}`); };
    const { createClientUser } = await load();
    const result = await createClientUser(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SERVICE_KEY);
  });
});

describe("mot de passe d'un compte existant", () => {
  it("réaffiche le mot de passe conservé ; un texte chiffré pour un autre compte ne se déchiffre pas", async () => {
    const { createClientUser, revealUserPassword } = await load();
    const created = await createClientUser(input);
    const shown = await revealUserPassword({ userId: USER });
    expect(shown).toMatchObject({ ok: true, password: created.password });
    expect(automationCalls.at(-1)).toMatchObject({ name: "server_get_user_password", params: { p_actor: ADMIN, p_user_id: USER } });
    // Le chiffré est lié au compte : rangé sous un autre identifiant, il est illisible.
    const other = await revealUserPassword({ userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    expect(other.ok).toBe(false);
    expect(other.password).toBeUndefined();
  });

  it("aucun mot de passe conservé : le dit, sans rien inventer", async () => {
    const { revealUserPassword } = await load();
    const result = await revealUserPassword({ userId: USER });
    expect(result.ok).toBe(false);
    expect(result.password).toBeUndefined();
  });

  it("renouveler : nouveau mot de passe posé sur le compte, puis conservé chiffré", async () => {
    const { createClientUser, regenerateUserPassword, revealUserPassword } = await load();
    const first = await createClientUser(input);
    const renewed = await regenerateUserPassword({ userId: USER });
    expect(renewed.ok).toBe(true);
    expect(renewed.password).not.toBe(first.password);
    expect(calls.at(-1)).toMatchObject({ url: `http://127.0.0.1:1/auth/v1/admin/users/${USER}`, method: "PUT", body: { password: renewed.password } });
    expect((await revealUserPassword({ userId: USER })).password).toBe(renewed.password);
  });

  it("le mot de passe d'un administrateur ne se renouvelle jamais ici", async () => {
    targetRole = "admin";
    const { regenerateUserPassword } = await load();
    expect((await regenerateUserPassword({ userId: USER })).ok).toBe(false);
    targetRole = null;
    expect((await regenerateUserPassword({ userId: USER })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("le service refuse le changement : l'ancien mot de passe reste conservé", async () => {
    const { createClientUser, regenerateUserPassword, revealUserPassword } = await load();
    const first = await createClientUser(input);
    answer = () => new Response("{}", { status: 500 });
    const renewed = await regenerateUserPassword({ userId: USER });
    expect(renewed.ok).toBe(false);
    expect(renewed.password).toBeUndefined();
    expect((await revealUserPassword({ userId: USER })).password).toBe(first.password);
  });

  it("afficher et renouveler sont réservés à l'administrateur", async () => {
    const { revealUserPassword, regenerateUserPassword } = await load();
    role = "client";
    expect(await revealUserPassword({ userId: USER })).toEqual({ ok: false, message: "Réservé à l'administrateur." });
    expect(await regenerateUserPassword({ userId: USER })).toEqual({ ok: false, message: "Réservé à l'administrateur." });
    expect(calls).toEqual([]);
    expect(automationCalls).toEqual([]);
  });
});
