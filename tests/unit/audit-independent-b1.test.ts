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

describe("Contre-audit indépendant B1",()=>{
 beforeEach(()=>{rpcResult={data:null,error:{code:"PGRST202",message:"function missing"}};});
 it("la compatibilité doit refuser le détachement d'un canal de A",async()=>{
  channelRow={organization_id:ORG};
  expect((await assignChannel({channelId:CHANNEL,organizationId:null})).ok).toBe(false);
  expect(directUpdates.length).toBe(0);
 });
 it("la compatibilité doit refuser le rattachement à B si l'historique existe",async()=>{
  channelRow={organization_id:null};postCount=1;
  expect((await assignChannel({channelId:CHANNEL,organizationId:OTHER})).ok).toBe(false);
  expect(directUpdates.length).toBe(0);
 });
});
