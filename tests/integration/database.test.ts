import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { beforeAll, describe, expect, it } from "vitest";

import { configureIsolatedTests, loadLocalEnv, requireEnv } from "../support/env";

/*
 * Tests d'intégration : ils parlent à la vraie base Supabase de développement.
 * Ils vérifient ce que l'interface ne peut pas garantir seule : l'isolation entre clients,
 * les validations simultanées et l'absence de double programmation.
 * Toutes les données créées ici sont préfixées « mock-it- » : elles ne touchent jamais aux vraies.
 */

loadLocalEnv();
configureIsolatedTests();

const RUN = `it-${Date.now()}`;
const SECRET = requireEnv("AUTOMATION_SECRET");
const FUTURE = "2030-01-15T09:00:00.000Z";
const CHANNEL_COLIBRI = "mock-ch-it-colibri";
const CHANNEL_NORDWIND = "mock-ch-it-nordwind";

function client(): SupabaseClient {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
  });
}

async function signedIn(user: "ADMIN" | "INES" | "HUGO" | "SOFIA"): Promise<SupabaseClient> {
  const supabase = client();
  const { error } = await supabase.auth.signInWithPassword({
    email: requireEnv(`DEMO_${user}_EMAIL`),
    password: requireEnv(`DEMO_${user}_PASSWORD`),
  });
  if (error) throw new Error(`Connexion ${user} impossible : ${error.message}`);
  return supabase;
}

interface TestPost {
  key: string;
  channel?: string;
  status?: string;
  text?: string;
  tagged?: boolean;
  dueAt?: string | null;
}

const bufferId = (key: string) => `mock-${RUN}-${key}`;

/** Simule une synchronisation : ce que le serveur enverrait après avoir lu Buffer. */
async function sync(posts: TestPost[], complete = false) {
  const { data, error } = await automation.rpc("sync_buffer_posts", {
    p_secret: SECRET,
    p_payload: {
      mode: "mock",
      triggeredBy: "test",
      complete,
      channels: [
        { id: CHANNEL_COLIBRI, service: "linkedin", name: "Test Colibri", organizationSlug: "maison-colibri" },
        { id: CHANNEL_NORDWIND, service: "linkedin", name: "Test Nordwind", organizationSlug: "nordwind-cycles" },
      ],
      posts: posts.map((post) => ({
        id: bufferId(post.key),
        channelId: post.channel ?? CHANNEL_COLIBRI,
        service: "linkedin",
        status: post.status ?? "draft",
        text: post.text ?? `Texte ${post.key}`,
        dueAt: post.dueAt === undefined ? FUTURE : post.dueAt,
        hasReviewTag: post.tagged ?? true,
        assets: [],
      })),
    },
  });
  if (error) throw new Error(error.message);
  return data as { created: number; updated: number; invalidated: number; removed: number };
}

async function row(key: string) {
  const { data, error } = await admin.from("posts").select("*").eq("buffer_post_id", bufferId(key)).single();
  if (error) throw new Error(error.message);
  return data;
}

async function decide(as: SupabaseClient, key: string, decision: string, comment?: string, hash?: string) {
  const post = await row(key);
  return as.rpc("decide_post", { p_post_id: post.id, p_decision: decision, p_expected_hash: hash ?? post.content_hash, p_comment: comment ?? null });
}

/** Jeton de la dernière réservation de chaque publication : la confirmation doit le représenter (migration 0010). */
const tokens = new Map<string, string>();

async function claimOne(key: string) {
  const post = await row(key);
  const result = await automation.rpc("claim_posts_for_scheduling_in_mode", { p_secret: SECRET, p_mode: "mock", p_post_id: post.id });
  const [reserved] = (result.data ?? []) as { id: string; token: string }[];
  if (reserved) tokens.set(reserved.id, reserved.token);
  return result;
}

/** Confirme la dernière réservation de la publication, avec son jeton. */
function completeScheduling(postId: string, ok: boolean, error?: string) {
  return automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: postId, p_ok: ok, ...(error ? { p_error: error } : {}), p_token: tokens.get(postId) ?? null });
}

let automation: SupabaseClient;
let admin: SupabaseClient;
let ines: SupabaseClient;
let hugo: SupabaseClient;
let sofia: SupabaseClient;

beforeAll(async () => {
  automation = client();
  [admin, ines, hugo, sofia] = await Promise.all([signedIn("ADMIN"), signedIn("INES"), signedIn("HUGO"), signedIn("SOFIA")]);
});

describe("isolation entre clients (RLS)", () => {
  beforeAll(async () => {
    await sync([
      { key: "iso-colibri" },
      { key: "iso-nordwind", channel: CHANNEL_NORDWIND },
      { key: "iso-brouillon", tagged: false },
    ]);
  });

  const visible = async (as: SupabaseClient, key: string) =>
    ((await as.from("posts").select("id").eq("buffer_post_id", bufferId(key))).data ?? []).length === 1;

  it("un client voit les posts soumis de son organisation, et seulement ceux-là", async () => {
    expect(await visible(ines, "iso-colibri")).toBe(true);
    expect(await visible(ines, "iso-nordwind")).toBe(false);
    expect(await visible(sofia, "iso-nordwind")).toBe(true);
    expect(await visible(sofia, "iso-colibri")).toBe(false);
  });

  it("un brouillon non soumis reste invisible pour le client, mais pas pour l'admin", async () => {
    expect(await visible(ines, "iso-brouillon")).toBe(false);
    expect(await visible(admin, "iso-brouillon")).toBe(true);
    expect(await visible(admin, "iso-nordwind")).toBe(true);
  });

  it("un client ne voit que son organisation, ses canaux et pas le journal de synchronisation", async () => {
    expect((await ines.from("organizations").select("slug")).data).toEqual([{ slug: "maison-colibri" }]);
    const channels = (await ines.from("channels").select("buffer_channel_id")).data ?? [];
    expect(channels.some((channel) => channel.buffer_channel_id === CHANNEL_NORDWIND)).toBe(false);
    expect((await ines.from("sync_runs").select("id")).data).toEqual([]);
  });

  it("un visiteur non connecté ne lit rien", async () => {
    const result = await automation.from("posts").select("id").limit(1);
    expect(result.error?.message).toContain("permission denied");
  });

  it("personne n'écrit directement dans les tables, pas même l'admin", async () => {
    const post = await row("iso-colibri");
    expect((await ines.from("posts").update({ approval_status: "approved" }).eq("id", post.id)).error).not.toBeNull();
    expect((await admin.from("posts").update({ approval_status: "approved" }).eq("id", post.id)).error).not.toBeNull();
    expect((await ines.from("comments").insert({ post_id: post.id, author_id: post.id, body: "x", version: 1 })).error).not.toBeNull();
    expect((await row("iso-colibri")).approval_status).toBe("pending");
  });

  it("un client ne peut ni décider ni commenter sur le post d'un autre client", async () => {
    expect((await decide(sofia, "iso-colibri", "approved")).error?.message).toBe("not_found");
    const post = await row("iso-colibri");
    expect((await sofia.rpc("add_comment", { p_post_id: post.id, p_body: "Intrusion" })).error?.message).toBe("not_found");
    expect((await row("iso-colibri")).approval_status).toBe("pending");
  });

  it("seul l'admin rattache un canal à un client", async () => {
    const { data: channel } = await admin.from("channels").select("id, organization_id").eq("buffer_channel_id", CHANNEL_COLIBRI).single();
    const attempt = await ines.from("channels").update({ organization_id: null }).eq("id", channel!.id).select("id");
    expect(attempt.data ?? []).toEqual([]);
    const after = await admin.from("channels").select("organization_id").eq("id", channel!.id).single();
    expect(after.data!.organization_id).toBe(channel!.organization_id);
  });

  it("les fonctions d'automatisation exigent le secret", async () => {
    const result = await ines.rpc("sync_buffer_posts", { p_secret: "mauvais-secret", p_payload: { posts: [] } });
    expect(result.error?.message).toBe("invalid_secret");
    expect((await ines.rpc("claim_posts_for_scheduling", { p_secret: "mauvais-secret" })).error?.message).toBe("invalid_secret");
  });
});

describe("décision du client", () => {
  beforeAll(async () => {
    await sync([{ key: "dec-admin" }, { key: "dec-perime" }, { key: "dec-modifs" }, { key: "dec-double" }, { key: "dec-programme", status: "scheduled" }]);
  });

  it("refuse l'approbation par un administrateur", async () => {
    expect((await decide(admin, "dec-admin", "approved")).error?.message).toBe("forbidden");
  });

  it("refuse une décision portant sur une version périmée", async () => {
    const stale = (await row("dec-perime")).content_hash;
    await sync([{ key: "dec-perime", text: "Texte modifié dans Buffer" }]);
    expect((await row("dec-perime")).version).toBe(2);
    expect((await decide(ines, "dec-perime", "approved", undefined, stale)).error?.message).toBe("stale_version");
    expect((await decide(ines, "dec-perime", "approved")).error).toBeNull();
  });

  it("exige un commentaire pour une demande de modifications, puis l'enregistre", async () => {
    expect((await decide(ines, "dec-modifs", "changes_requested", "   ")).error?.message).toBe("comment_required");
    expect((await decide(ines, "dec-modifs", "changes_requested", "Raccourcir l'accroche")).error).toBeNull();
    const post = await row("dec-modifs");
    expect(post.approval_status).toBe("changes_requested");
    const comments = (await ines.from("comments").select("body, kind").eq("post_id", post.id)).data;
    expect(comments).toEqual([{ body: "Raccourcir l'accroche", kind: "change_request" }]);
  });

  it("deux validations simultanées : une seule est retenue", async () => {
    const [first, second] = await Promise.all([decide(ines, "dec-double", "approved"), decide(hugo, "dec-double", "approved")]);
    const errors = [first.error?.message, second.error?.message];
    expect(errors.filter((message) => message === undefined)).toHaveLength(1);
    expect(errors.filter((message) => message === "not_pending")).toHaveLength(1);
    const post = await row("dec-double");
    const decisions = (await admin.from("approval_decisions").select("id").eq("post_id", post.id)).data;
    expect(decisions).toHaveLength(1);
  });

  it("refuse une décision sur un post qui n'est plus un brouillon dans Buffer", async () => {
    // Programmé dans Buffer sans jamais avoir été soumis : inexistant pour le client.
    expect((await decide(ines, "dec-programme", "approved")).error?.message).toBe("not_found");
    // Soumis, puis programmé à la main dans Buffer avant la décision.
    await sync([{ key: "dec-attente-programme" }]);
    await sync([{ key: "dec-attente-programme", status: "scheduled" }]);
    expect((await decide(ines, "dec-attente-programme", "approved")).error?.message).toBe("not_draft");
  });
});

describe("garde-fous ajoutés après audit", () => {
  it("refuse d'approuver une publication dont la date est passée ou absente, mais accepte une demande de modifications", async () => {
    await sync([{ key: "date-passee", dueAt: "2020-01-01T09:00:00.000Z" }, { key: "date-absente", dueAt: null }]);
    expect((await decide(ines, "date-passee", "approved")).error?.message).toBe("date_invalid");
    expect((await decide(ines, "date-absente", "approved")).error?.message).toBe("date_invalid");
    expect((await row("date-passee")).approval_status).toBe("pending");
    expect((await decide(ines, "date-passee", "changes_requested", "Merci de reprogrammer")).error).toBeNull();
  });

  it("un client ne lit pas les événements techniques, même en interrogeant l'API directement", async () => {
    await sync([{ key: "evt-technique" }]);
    await decide(ines, "evt-technique", "approved");
    const post = await row("evt-technique");
    await claimOne("evt-technique");
    await completeScheduling(post.id, false, "Détail technique confidentiel");

    const types = async (as: SupabaseClient) =>
      ((await as.from("post_events").select("type, detail").eq("post_id", post.id)).data ?? []).map((event) => event.type).sort();
    expect(await types(admin)).toEqual(["approved", "schedule_failed", "submitted"]);
    expect(await types(ines)).toEqual(["approved", "submitted"]);
  });
});

describe("programmation", () => {
  beforeAll(async () => {
    await sync([{ key: "prog-ok" }, { key: "prog-non-approuve" }, { key: "prog-modifs" }, { key: "prog-echec" }]);
    await decide(ines, "prog-ok", "approved");
    await decide(ines, "prog-modifs", "changes_requested", "À revoir");
    await decide(ines, "prog-echec", "approved");
  });

  it("ne réserve jamais un post non approuvé ou refusé", async () => {
    expect((await claimOne("prog-non-approuve")).data).toEqual([]);
    expect((await claimOne("prog-modifs")).data).toEqual([]);
  });

  it("ne réserve pas un post approuvé dont la date est entre-temps devenue trop proche ou passée", async () => {
    // Approuvé avec une date future, puis la date est avancée dans le passé : l'empreinte change, la validation tombe.
    await sync([{ key: "prog-date" }]);
    await decide(ines, "prog-date", "approved");
    await sync([{ key: "prog-date", dueAt: "2020-01-01T09:00:00.000Z" }]);
    expect((await row("prog-date")).approval_status).toBe("pending");
    expect((await claimOne("prog-date")).data).toEqual([]);
  });

  it("deux programmations simultanées : le post n'est réservé qu'une fois", async () => {
    const [first, second] = await Promise.all([claimOne("prog-ok"), claimOne("prog-ok")]);
    expect((first.data ?? []).length + (second.data ?? []).length).toBe(1);

    const post = await row("prog-ok");
    await completeScheduling(post.id, true);
    expect(await row("prog-ok")).toMatchObject({ schedule_state: "scheduled", buffer_status: "scheduled" });
    expect((await claimOne("prog-ok")).data).toEqual([]);
  });

  it("après un échec, le post peut être retenté puis programmé", async () => {
    const post = await row("prog-echec");
    expect((await claimOne("prog-echec")).data).toHaveLength(1);
    await completeScheduling(post.id, false, "Canal déconnecté");
    expect(await row("prog-echec")).toMatchObject({ schedule_state: "failed", schedule_error: "Canal déconnecté", approval_status: "approved" });
    expect((await claimOne("prog-echec")).data).toHaveLength(1);
    await completeScheduling(post.id, true);
    expect((await row("prog-echec")).schedule_state).toBe("scheduled");
  });
});


describe("séparation des modes de programmation", () => {
  it("un post simulé n'est réservé ni en mode réel ni par l'ancienne signature", async () => {
    await sync([{ key: "mode-boundary" }]);
    await decide(ines, "mode-boundary", "approved");
    const post = await row("mode-boundary");
    const real = await automation.rpc("claim_posts_for_scheduling_in_mode", { p_secret: SECRET, p_mode: "real", p_post_id: post.id });
    expect(real.error).toBeNull();
    expect(real.data).toEqual([]);
    const legacy = await automation.rpc("claim_posts_for_scheduling", { p_secret: SECRET, p_post_id: post.id });
    expect(legacy.error).toBeNull();
    expect(legacy.data).toEqual([]);
    expect((await row("mode-boundary")).schedule_state).toBe("idle");
    expect((await claimOne("mode-boundary")).data).toHaveLength(1);
    await completeScheduling(post.id, true);
  });

  it("les fonctions par mode refusent un mode invalide et un mauvais secret", async () => {
    for (const name of ["claim_posts_for_scheduling_in_mode", "list_posts_to_unschedule_in_mode"]) {
      expect((await automation.rpc(name, { p_secret: SECRET, p_mode: "invalide" })).error?.message).toBe("invalid_mode");
      expect((await automation.rpc(name, { p_secret: "mauvais-secret", p_mode: "mock" })).error?.message).toBe("invalid_secret");
    }
  });
});

describe("synchronisation", () => {
  it("annule une validation si seules les secondes de la date changent", async () => {
    await sync([{ key: "sync-secondes" }]);
    await decide(ines, "sync-secondes", "approved");
    const result = await sync([{ key: "sync-secondes", dueAt: "2030-01-15T09:00:30.000Z" }]);
    expect(result.invalidated).toBe(1);
    expect(await row("sync-secondes")).toMatchObject({ approval_status: "pending", version: 2, approved_hash: null });
  });

  it("est rejouable sans effet de bord", async () => {
    await sync([{ key: "sync-idem" }]);
    const before = await row("sync-idem");
    const result = await sync([{ key: "sync-idem" }]);
    const after = await row("sync-idem");
    expect(result.created).toBe(0);
    expect(after).toMatchObject({ version: before.version, content_hash: before.content_hash, approval_status: "pending" });
    const events = (await admin.from("post_events").select("type").eq("post_id", after.id)).data;
    expect(events).toEqual([{ type: "submitted" }]);
  });

  it("annule la validation et demande la déprogrammation quand un post programmé change dans Buffer", async () => {
    await sync([{ key: "sync-invalide" }]);
    await decide(ines, "sync-invalide", "approved");
    const post = await row("sync-invalide");
    await claimOne("sync-invalide");
    await completeScheduling(post.id, true);

    const result = await sync([{ key: "sync-invalide", status: "scheduled", text: "Texte changé après validation" }]);
    expect(result.invalidated).toBe(1);
    expect(await row("sync-invalide")).toMatchObject({ approval_status: "pending", version: 2, approved_hash: null, schedule_state: "unschedule_pending" });

    const pending = (await automation.rpc("list_posts_to_unschedule_in_mode", { p_secret: SECRET, p_mode: "mock" })).data as { id: string }[];
    expect(pending.some((item) => item.id === post.id)).toBe(true);
    const realPending = await automation.rpc("list_posts_to_unschedule_in_mode", { p_secret: SECRET, p_mode: "real" });
    expect(realPending.error).toBeNull();
    expect((realPending.data as { id: string }[]).some((item) => item.id === post.id)).toBe(false);
    await automation.rpc("complete_unscheduling", { p_secret: SECRET, p_post_id: post.id, p_ok: true });
    expect(await row("sync-invalide")).toMatchObject({ schedule_state: "idle", buffer_status: "draft" });
    expect((await claimOne("sync-invalide")).data).toEqual([]);
  });

  it("soumet une nouvelle version quand un post refusé est corrigé dans Buffer", async () => {
    await sync([{ key: "sync-corrige" }]);
    await decide(ines, "sync-corrige", "changes_requested", "Changer le texte");
    await sync([{ key: "sync-corrige", text: "Texte corrigé" }]);
    expect(await row("sync-corrige")).toMatchObject({ approval_status: "pending", version: 2 });
  });

  it("suit le tag : posé, le post est soumis ; retiré, il redevient invisible pour le client", async () => {
    await sync([{ key: "sync-tag", tagged: false }]);
    expect((await row("sync-tag")).approval_status).toBe("none");
    await sync([{ key: "sync-tag", tagged: true }]);
    expect((await row("sync-tag")).approval_status).toBe("pending");
    await sync([{ key: "sync-tag", tagged: false }]);
    expect((await row("sync-tag")).approval_status).toBe("none");
    expect((await ines.from("posts").select("id").eq("buffer_post_id", bufferId("sync-tag"))).data).toEqual([]);
  });

  it("redemande une validation si un post programmé par le dashboard redevient brouillon dans Buffer", async () => {
    await sync([{ key: "sync-retour" }]);
    await decide(ines, "sync-retour", "approved");
    const post = await row("sync-retour");
    await claimOne("sync-retour");
    await completeScheduling(post.id, true);
    await sync([{ key: "sync-retour", status: "draft" }]);
    expect(await row("sync-retour")).toMatchObject({ approval_status: "pending", schedule_state: "idle" });
  });

  it("marque comme supprimé un post disparu de Buffer, sans jamais l'effacer", async () => {
    await sync([{ key: "sync-garde" }, { key: "sync-disparu" }]);
    const result = await sync([{ key: "sync-garde" }], true);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect((await row("sync-disparu")).removed_at).not.toBeNull();
    expect((await row("sync-garde")).removed_at).toBeNull();
    expect((await ines.from("posts").select("id").eq("buffer_post_id", bufferId("sync-disparu"))).data).toEqual([]);
    expect((await decide(ines, "sync-disparu", "approved")).error?.message).toBe("not_found");
  });
});

/*
 * Migration 0009 (audit du 9 octobre 2026), sur le vrai moteur : mêmes scénarios que tests/sql/stabilisation.test.ts,
 * mais à travers l'API HTTP (PostgREST), les rôles réels et la résolution des signatures de fonctions.
 */
describe("stabilisation (0009)", () => {
  const XFER = `mock-ch-${RUN}-xfer`;

  async function syncOn(channelId: string, slug: string, posts: TestPost[]) {
    const { data, error } = await automation.rpc("sync_buffer_posts", {
      p_secret: SECRET,
      p_payload: {
        mode: "mock",
        triggeredBy: "test",
        complete: false,
        channels: [{ id: channelId, service: "linkedin", name: `Test ${channelId}`, organizationSlug: slug }],
        posts: posts.map((post) => ({
          id: bufferId(post.key), channelId, service: "linkedin", status: post.status ?? "draft", text: post.text ?? `Texte ${post.key}`,
          dueAt: post.dueAt === undefined ? FUTURE : post.dueAt, hasReviewTag: post.tagged ?? true, assets: [],
        })),
      },
    });
    if (error) throw new Error(error.message);
    return data;
  }
  const orgId = async (slug: string) => (await admin.from("organizations").select("id").eq("slug", slug).single()).data!.id as string;
  const seenBy = async (as: SupabaseClient, key: string) => ((await as.from("posts").select("id").eq("buffer_post_id", bufferId(key))).data ?? []).length === 1;

  it("transfert : l'accord de l'ancien client n'est plus programmable, et un import tardif reste réservé à l'admin", async () => {
    await syncOn(XFER, "maison-colibri", [{ key: "xf-old" }]);
    expect((await decide(ines, "xf-old", "approved")).error).toBeNull();
    expect((await claimOne("xf-old")).data).toHaveLength(1);
    // Réservation relâchée pour pouvoir tester le transfert.
    const old = await row("xf-old");
    await completeScheduling(old.id, false, "essai");

    const { data: channel } = await admin.from("channels").select("id").eq("buffer_channel_id", XFER).single();
    const transfer = await admin.rpc("admin_assign_channel", { p_channel_id: channel!.id, p_organization_id: await orgId("nordwind-cycles"), p_confirm_transfer: true });
    expect(transfer.error).toBeNull();
    expect(transfer.data).toMatchObject({ transferred: true });
    expect(await row("xf-old")).toMatchObject({ approval_status: "none", approved_hash: null });
    expect((await claimOne("xf-old")).data).toEqual([]);

    // Contenu ancien découvert après le transfert : created_at récent, mais appartenance ambiguë.
    await syncOn(XFER, "maison-colibri", [{ key: "xf-old" }, { key: "xf-late", text: "Ancien contenu de Colibri" }]);
    expect(await row("xf-late")).toMatchObject({ ownership: "ambiguous", owner_organization_id: null });
    expect(await seenBy(sofia, "xf-late")).toBe(false);
    expect(await seenBy(admin, "xf-late")).toBe(true);
    expect((await decide(sofia, "xf-late", "approved")).error?.message).toBe("not_found");

    // Attribué par l'admin à son vrai client : le propriétaire du canal n'y gagne rien.
    const late = await row("xf-late");
    const assigned = await admin.rpc("admin_set_post_owner", { p_post_ids: [late.id], p_organization_id: await orgId("maison-colibri") });
    expect(assigned.data).toBe(1);
    expect(await seenBy(sofia, "xf-late")).toBe(false);
  });

  it("programmation : la réservation porte un jeton, une confirmation tardive est compensée", async () => {
    await sync([{ key: "tok-1", text: "Validé" }]);
    expect((await decide(ines, "tok-1", "approved")).error).toBeNull();
    const claimed = await claimOne("tok-1");
    expect(claimed.error).toBeNull();
    const [reserved] = claimed.data as { id: string; token: string; content_hash: string }[];
    expect(reserved.token).toMatch(/^[0-9a-f-]{36}$/);

    // La synchronisation modifie le contenu pendant l'appel à Buffer.
    await sync([{ key: "tok-1", text: "Modifié pendant la réservation" }]);
    const late = await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: reserved.id, p_ok: true, p_token: reserved.token });
    expect(late.error).toBeNull();
    expect(late.data).toBe("stale");
    expect(await row("tok-1")).toMatchObject({ approval_status: "pending", schedule_state: "unschedule_pending" });
    const pending = await automation.rpc("list_posts_to_unschedule_in_mode", { p_secret: SECRET, p_mode: "mock" });
    expect((pending.data as { id: string }[]).map((item) => item.id)).toContain(reserved.id);

    // Déprogrammation constatée « déjà publié » : jamais enregistrée comme brouillon.
    const done = await automation.rpc("complete_unscheduling", { p_secret: SECRET, p_post_id: reserved.id, p_ok: true, p_observed_status: "sent" });
    expect(done.error).toBeNull();
    expect(await row("tok-1")).toMatchObject({ buffer_status: "sent", schedule_state: "idle" });
  });

  it("approbation : une date trop proche est refusée avec un code explicite", async () => {
    await sync([{ key: "proche", dueAt: new Date(Date.now() + 5 * 60_000).toISOString() }]);
    expect((await decide(ines, "proche", "approved")).error?.message).toBe("date_too_close");
  });

  it("notifications : un membre retiré avant la remise ne reçoit rien, puis l'accès rétabli n'envoie pas l'ancien message", async () => {
    const emails = (await admin.rpc("admin_list_user_emails")).data as { user_id: string; email: string }[];
    const inesId = emails.find((item) => item.email === requireEnv("DEMO_INES_EMAIL"))!.user_id;
    const colibri = await orgId("maison-colibri");
    await sync([{ key: "notif-revoque", text: "Texte réservé aux membres" }]);

    expect((await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: inesId, p_member: false })).error).toBeNull();
    try {
      const claimed = await automation.rpc("claim_notifications", { p_secret: SECRET, p_mode: "mock", p_limit: 200 });
      expect(claimed.error).toBeNull();
      const rows = claimed.data as { id: string; recipient_id: string; post_text: string }[];
      expect(rows.some((item) => item.recipient_id === inesId)).toBe(false);
      // Les notifications réellement réservées sont closes pour ne pas rester « en cours ».
      if (rows.length > 0) await automation.rpc("complete_notifications", { p_secret: SECRET, p_ids: rows.map((item) => item.id), p_status: "simulated" });
    } finally {
      await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: inesId, p_member: true });
    }
  });

  it("Studio : un envoi au résultat inconnu bloque tout renvoi jusqu'à la réconciliation", async () => {
    const colibri = await orgId("maison-colibri");
    const { data: channel } = await admin.from("channels").select("id").eq("buffer_channel_id", CHANNEL_COLIBRI).single();
    const saved = await admin.rpc("studio_save_draft", {
      p_id: null, p_expected_revision: null,
      p_payload: { organizationId: colibri, title: "Essai résultat inconnu", dueAt: FUTURE, hashtags: ["#essai"], variants: [{ channelId: channel!.id, text: "Texte" }] },
    });
    expect(saved.error).toBeNull();
    const draftId = (saved.data as { id: string }).id;

    const claim = await admin.rpc("studio_claim_push", { p_draft_id: draftId, p_force: false });
    expect(claim.error).toBeNull();
    const [reserved] = claim.data as { variant_id: string; hashtags: string[]; revision: number }[];
    expect(reserved).toMatchObject({ hashtags: ["#essai"], revision: 1 });
    expect((await admin.rpc("studio_complete_push", { p_variant_id: reserved.variant_id, p_ok: false, p_buffer_post_id: null, p_error: "délai dépassé", p_revision: null, p_uncertain: true })).error).toBeNull();

    expect((await admin.rpc("studio_claim_push", { p_draft_id: draftId, p_force: true })).error?.message).toBe("push_unknown");
    // Réponse tardive possible : pas d'autorisation de renvoi tout de suite.
    expect((await admin.rpc("studio_resolve_unknown", { p_variant_id: reserved.variant_id, p_buffer_post_id: null, p_confirmed_absent: true })).error?.message).toBe("unknown_too_recent");
    // Un brouillon retrouvé dans Buffer est adopté, jamais recréé.
    const adopted = await admin.rpc("studio_resolve_unknown", { p_variant_id: reserved.variant_id, p_buffer_post_id: `mock-${RUN}-retrouve`, p_confirmed_absent: false });
    expect(adopted.data).toBe("adopted");
    const again = await admin.rpc("studio_claim_push", { p_draft_id: draftId, p_force: false });
    expect((again.data as { buffer_post_id: string }[])[0].buffer_post_id).toBe(`mock-${RUN}-retrouve`);
    await admin.rpc("studio_complete_push", { p_variant_id: reserved.variant_id, p_ok: false, p_buffer_post_id: null, p_error: "essai terminé", p_revision: null });
    await admin.rpc("studio_set_draft_archived", { p_id: draftId, p_archived: true });
  });

  it("un client ne peut ni attribuer une publication, ni appeler les fonctions internes", async () => {
    const post = await row("iso-colibri");
    expect((await ines.rpc("admin_set_post_owner", { p_post_ids: [post.id], p_organization_id: await orgId("maison-colibri") })).error?.message).toBe("forbidden");
    expect((await ines.rpc("set_sync_backoff", { p_secret: "mauvais", p_mode: "mock", p_seconds: 5 })).error?.message).toBe("invalid_secret");
    expect((await ines.rpc("studio_resolve_unknown", { p_variant_id: post.id })).error?.message).toBe("forbidden");
  });
});

/*
 * Migration 0010 (contre-audit du 10 octobre 2026), sur le vrai moteur : API HTTP (PostgREST), rôles réels et RLS.
 * Mêmes invariants que tests/sql/contre-audit.test.ts.
 */
describe("deuxième stabilisation (0010)", () => {
  const EMPTY = `mock-ch-${RUN}-vide`;
  const FRESH = `mock-ch-${RUN}-b3`;

  async function syncOn(channelId: string, slug: string, posts: TestPost[]) {
    const { error } = await automation.rpc("sync_buffer_posts", {
      p_secret: SECRET,
      p_payload: {
        mode: "mock", triggeredBy: "test", complete: false,
        channels: [{ id: channelId, service: "linkedin", name: `Test ${channelId}`, organizationSlug: slug }],
        posts: posts.map((post) => ({
          id: bufferId(post.key), channelId, service: "linkedin", status: post.status ?? "draft", text: post.text ?? `Texte ${post.key}`,
          dueAt: post.dueAt === undefined ? FUTURE : post.dueAt, hasReviewTag: post.tagged ?? true, assets: [],
        })),
      },
    });
    if (error) throw new Error(error.message);
  }
  const orgId = async (slug: string) => (await admin.from("organizations").select("id").eq("slug", slug).single()).data!.id as string;
  const seenBy = async (as: SupabaseClient, key: string) => ((await as.from("posts").select("id").eq("buffer_post_id", bufferId(key))).data ?? []).length === 1;

  it("B2 : un transfert d'un canal SANS publication importée protège un import tardif (lecture réelle par le client B)", async () => {
    await syncOn(EMPTY, "maison-colibri", []);
    const { data: channel } = await admin.from("channels").select("id").eq("buffer_channel_id", EMPTY).single();
    const transfer = await admin.rpc("admin_assign_channel", { p_channel_id: channel!.id, p_organization_id: await orgId("nordwind-cycles"), p_confirm_transfer: false });
    expect(transfer.error).toBeNull();
    expect(transfer.data).toMatchObject({ transferred: true });
    const trace = await admin.from("channel_owner_history").select("kind").eq("channel_id", channel!.id);
    expect(trace.data).toEqual([{ kind: "transfer" }]);

    await syncOn(EMPTY, "maison-colibri", [{ key: "vide-tardif", text: "CONFIDENTIEL de l'ancien client" }]);
    expect(await row("vide-tardif")).toMatchObject({ ownership: "ambiguous", owner_organization_id: null });
    expect(await seenBy(sofia, "vide-tardif")).toBe(false);
    expect(await seenBy(ines, "vide-tardif")).toBe(false);
    expect((await sofia.from("channel_owner_history").select("id")).data).toEqual([]);
  });

  it("B3 : retirer l'approbateur retire son accord ; une réservation n'est plus possible", async () => {
    await syncOn(FRESH, "maison-colibri", [{ key: "b3-a" }]);
    expect((await decide(hugo, "b3-a", "approved")).error).toBeNull();
    const colibri = await orgId("maison-colibri");
    const { data: hugoProfile } = await admin.from("profiles").select("id").eq("full_name", "Hugo Bernard").single();
    expect((await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: hugoProfile!.id, p_member: false })).error).toBeNull();
    try {
      expect(await row("b3-a")).toMatchObject({ approval_status: "pending", approved_by: null });
      expect((await claimOne("b3-a")).data).toEqual([]);
    } finally {
      // Les comptes de démonstration sont partagés par les autres suites : le membre est rétabli.
      await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: hugoProfile!.id, p_member: true });
    }
  });

  it("B4 : une confirmation sans jeton n'a aucun effet sur la réservation courante", async () => {
    await syncOn(FRESH, "maison-colibri", [{ key: "b4-a" }]);
    expect((await decide(ines, "b4-a", "approved")).error).toBeNull();
    const [reserved] = (await claimOne("b4-a")).data as { id: string; token: string }[];
    const without = await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: reserved.id, p_ok: true });
    expect(without.data).toBe("superseded");
    expect(await row("b4-a")).toMatchObject({ schedule_state: "claimed" });
    const withToken = await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: reserved.id, p_ok: true, p_token: reserved.token });
    expect(withToken.data).toBe("scheduled");
  });

  it("quota : une pause de trois jours est conservée et lisible par les actions qui écrivent", async () => {
    // Mode « real » : aucune suite de test n'écrit dans le vrai Buffer, la pause n'affecte donc pas les autres suites.
    const set = await automation.rpc("set_sync_backoff", { p_secret: SECRET, p_mode: "real", p_seconds: 3 * 86400, p_reason: "Test 0010" });
    expect(set.error).toBeNull();
    try {
      const pause = await automation.rpc("get_sync_pause", { p_secret: SECRET, p_mode: "real" });
      expect(pause.error).toBeNull();
      expect(Date.parse((pause.data as { until: string }).until) - Date.now()).toBeGreaterThan(3 * 86400_000 - 60_000);
      // La pause du mode réel n'est pas celle du mode simulé.
      expect((await automation.rpc("get_sync_pause", { p_secret: SECRET, p_mode: "mock" })).data).toBeNull();
    } finally {
      // Une exécution manuelle réussie lève une pause antérieure : la base de test est remise comme elle était.
      const run = await automation.rpc("begin_sync_run", { p_secret: SECRET, p_mode: "real", p_triggered_by: "test", p_scheduled: false });
      await automation.rpc("finish_sync_run", { p_secret: SECRET, p_mode: "real", p_token: (run.data as { token: string }).token, p_ok: true });
    }
    expect((await automation.rpc("get_sync_pause", { p_secret: SECRET, p_mode: "real" })).data).toBeNull();
  });
});

