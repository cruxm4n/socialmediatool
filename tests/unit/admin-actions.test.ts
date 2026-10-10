import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Actions d'administration, isolées : la base et la session sont remplacées par des doublures.
 * On vérifie ce que l'écran reçoit : refus sans session ou sans rôle admin, messages lisibles
 * pour chaque refus de la base, confirmation de transfert, et repli sur une base sans la migration 0005.
 */

type RpcError = { code?: string; message: string };
let role: "admin" | "client" | null = "admin";
let rpcResult: { data: unknown; error: RpcError | null } = { data: null, error: null };
const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let channelRow: { organization_id: string | null } | null = null;
/** Nombre de publications déjà présentes sur le canal (lecture de l'historique par l'ancien chemin). */
let postCount = 0;
const directUpdates: Record<string, unknown>[] = [];
const revalidated: string[] = [];

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidated.push(path) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/sync", () => ({ runSync: vi.fn(), scheduleApprovedPosts: vi.fn() }));
vi.mock("@/server/auth", () => ({
  homePath: () => "/admin",
  getSession: async () => (role ? { profile: { id: "u1", fullName: "Test", jobTitle: "", role }, organizations: [] } : null),
}));
vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      return rpcResult;
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: channelRow, error: null }),
          then: (resolve: (value: unknown) => void) => resolve({ count: postCount, error: null }),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        directUpdates.push(values);
        return { eq: () => ({ select: async () => ({ data: [{ id: "c1" }], error: null }) }) };
      },
    }),
  }),
}));

const { addUserByEmail, assignChannel, saveOrganization, setMember, setOrganizationArchived } = await import("@/server/actions");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const client = { name: "Colibri Café", sector: "Restauration", timezone: "Europe/Paris", color: "#1f4f8f" };

beforeEach(() => {
  role = "admin";
  rpcResult = { data: null, error: null };
  rpcCalls.length = 0;
  directUpdates.length = 0;
  revalidated.length = 0;
  channelRow = null;
  postCount = 0;
});

describe("contrôle d'accès des actions d'administration", () => {
  const actions: [string, () => Promise<{ ok: boolean; message: string; expired?: boolean }>][] = [
    ["enregistrer un client", () => saveOrganization(client)],
    ["archiver un client", () => setOrganizationArchived({ id: ORG, archived: true })],
    ["attribuer un canal", () => assignChannel({ channelId: CHANNEL, organizationId: ORG })],
    ["associer un membre", () => setMember({ organizationId: ORG, userId: USER, member: true })],
    ["ajouter un utilisateur", () => addUserByEmail({ organizationId: ORG, email: "a@b.fr", fullName: "A", jobTitle: "" })],
  ];

  it.each(actions)("%s : refusé à un client, sans appeler la base", async (_label, action) => {
    role = "client";
    const result = await action();
    expect(result).toMatchObject({ ok: false, message: "Réservé à l'administrateur." });
    expect(rpcCalls).toEqual([]);
  });

  it.each(actions)("%s : sans session, renvoie vers la connexion", async (_label, action) => {
    role = null;
    expect(await action()).toMatchObject({ ok: false, expired: true });
    expect(rpcCalls).toEqual([]);
  });

  it("la session expirée entre le contrôle et l'appel est reconnue", async () => {
    rpcResult = { data: null, error: { message: "permission denied for function admin_set_member" } };
    expect(await setMember({ organizationId: ORG, userId: USER, member: false })).toMatchObject({ ok: false, expired: true });
  });
});

describe("clients", () => {
  it("déduit l'adresse et les initiales du nom à la création", async () => {
    rpcResult = { data: ORG, error: null };
    const result = await saveOrganization(client);
    expect(result).toEqual({ ok: true, message: "Client créé.", id: ORG });
    expect(rpcCalls[0]).toEqual({
      name: "admin_save_organization",
      params: { p_id: null, p_name: "Colibri Café", p_slug: "colibri-cafe", p_sector: "Restauration", p_timezone: "Europe/Paris", p_initials: "CC", p_color: "#1f4f8f" },
    });
    expect(revalidated).toEqual(["/"]);
  });

  it("refuse une saisie invalide avant tout appel", async () => {
    expect((await saveOrganization({ ...client, name: "   " })).ok).toBe(false);
    expect((await saveOrganization({ ...client, color: "rouge" })).ok).toBe(false);
    expect((await setOrganizationArchived({ id: "pas-un-uuid", archived: true })).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });

  it("traduit un refus de la base en message lisible, sans rafraîchir l'écran", async () => {
    rpcResult = { data: null, error: { message: "name_taken" } };
    const result = await saveOrganization(client);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("name_taken");
    expect(revalidated).toEqual([]);
  });

  it("garde le détail d'un refus inconnu plutôt que de le masquer", async () => {
    rpcResult = { data: null, error: { message: "erreur inattendue" } };
    expect((await setOrganizationArchived({ id: ORG, archived: true })).message).toBe("Action impossible : erreur inattendue");
  });

  it("base sans la migration 0005 : message explicite", async () => {
    rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect((await saveOrganization(client)).message).toContain("migration 0005");
  });
});

describe("attribution d'un canal", () => {
  it("demande une confirmation avant un transfert, puis annonce ce qui reste masqué", async () => {
    rpcResult = { data: null, error: { message: "transfer_confirmation_required" } };
    expect(await assignChannel({ channelId: CHANNEL, organizationId: ORG })).toMatchObject({ ok: false, needsConfirmation: true });
    expect(rpcCalls[0].params).toMatchObject({ p_confirm_transfer: false });

    rpcResult = { data: { transferred: true, hidden_posts: 3 }, error: null };
    const confirmed = await assignChannel({ channelId: CHANNEL, organizationId: ORG, confirmTransfer: true });
    expect(rpcCalls[1].params).toMatchObject({ p_confirm_transfer: true });
    expect(confirmed).toMatchObject({ ok: true });
    expect(confirmed.message).toContain("3 publications antérieures restent invisibles");
  });

  it("rattache et détache", async () => {
    rpcResult = { data: { transferred: false, hidden_posts: 0 }, error: null };
    expect((await assignChannel({ channelId: CHANNEL, organizationId: ORG })).message).toBe("Canal rattaché au client.");
    expect((await assignChannel({ channelId: CHANNEL, organizationId: null })).message).toBe("Canal détaché.");
  });

  describe("base sans la migration 0005 (aucune garantie d'isolation de l'historique)", () => {
    beforeEach(() => {
      rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    });

    it("rattache un canal libre qui ne porte aucune publication", async () => {
      channelRow = { organization_id: null };
      postCount = 0;
      expect(await assignChannel({ channelId: CHANNEL, organizationId: ORG })).toMatchObject({ ok: true, message: "Canal rattaché au client." });
      expect(directUpdates).toEqual([{ organization_id: ORG }]);
    });

    it("refuse un transfert direct : il montrerait au nouveau client l'historique de l'ancien", async () => {
      channelRow = { organization_id: OTHER };
      const result = await assignChannel({ channelId: CHANNEL, organizationId: ORG, confirmTransfer: true });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("migration 0005");
      expect(directUpdates).toEqual([]);
    });

    it("refuse « détacher puis rattacher » : le canal détaché paraît libre alors que son historique existe", async () => {
      // Détacher : refusé, ce schéma ne conserve pas l'ancien propriétaire.
      channelRow = { organization_id: OTHER };
      expect(await assignChannel({ channelId: CHANNEL, organizationId: null })).toMatchObject({ ok: false });
      // Rattacher un canal libre qui porte déjà des publications : refusé (c'est le contournement B1 de l'audit).
      channelRow = { organization_id: null };
      postCount = 4;
      const result = await assignChannel({ channelId: CHANNEL, organizationId: ORG, confirmTransfer: true });
      expect(result).toMatchObject({ ok: false });
      expect(result.message).toContain("migration 0005");
      expect(directUpdates).toEqual([]);
    });

    it("sans pouvoir lire l'historique, refuse plutôt que de supposer le canal vide", async () => {
      channelRow = { organization_id: null };
      postCount = Number.NaN;
      expect(await assignChannel({ channelId: CHANNEL, organizationId: ORG })).toMatchObject({ ok: false });
      expect(directUpdates).toEqual([]);
    });
  });
});

describe("accès", () => {
  it("première association d'un compte : le nom est demandé", async () => {
    rpcResult = { data: null, error: { message: "invalid_name" } };
    expect((await addUserByEmail({ organizationId: ORG, email: "nouveau@client.fr", fullName: "", jobTitle: "" })).message).toContain("indiquez son nom");
  });

  it("refuse une adresse e-mail invalide avant tout appel", async () => {
    expect((await addUserByEmail({ organizationId: ORG, email: "pas-une-adresse", fullName: "A", jobTitle: "" })).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });

  it("accorde puis retire un accès", async () => {
    expect((await setMember({ organizationId: ORG, userId: USER, member: true })).message).toBe("Accès accordé.");
    expect((await setMember({ organizationId: ORG, userId: USER, member: false })).message).toBe("Accès retiré.");
    expect(rpcCalls.map((call) => call.params.p_member)).toEqual([true, false]);
  });
});
