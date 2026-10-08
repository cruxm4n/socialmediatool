import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { beforeAll, describe, expect, it } from "vitest";

import { loadLocalEnv, requireEnv } from "../support/env";

/*
 * Tests d'intégration : ils parlent à la vraie base Supabase de développement.
 * Ils vérifient ce que l'interface ne peut pas garantir seule : l'isolation entre clients,
 * les validations simultanées et l'absence de double programmation.
 * Toutes les données créées ici sont préfixées « mock-it- » : elles ne touchent jamais aux vraies.
 */

loadLocalEnv();

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

async function claimOne(key: string) {
  const post = await row(key);
  return automation.rpc("claim_posts_for_scheduling", { p_secret: SECRET, p_post_id: post.id });
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

describe("programmation", () => {
  beforeAll(async () => {
    await sync([{ key: "prog-ok" }, { key: "prog-non-approuve" }, { key: "prog-modifs" }, { key: "prog-passe", dueAt: "2020-01-01T09:00:00.000Z" }, { key: "prog-echec" }]);
    await decide(ines, "prog-ok", "approved");
    await decide(ines, "prog-modifs", "changes_requested", "À revoir");
    await decide(ines, "prog-passe", "approved");
    await decide(ines, "prog-echec", "approved");
  });

  it("ne réserve jamais un post non approuvé, refusé ou dont la date est passée", async () => {
    expect((await claimOne("prog-non-approuve")).data).toEqual([]);
    expect((await claimOne("prog-modifs")).data).toEqual([]);
    expect((await claimOne("prog-passe")).data).toEqual([]);
  });

  it("deux programmations simultanées : le post n'est réservé qu'une fois", async () => {
    const [first, second] = await Promise.all([claimOne("prog-ok"), claimOne("prog-ok")]);
    expect((first.data ?? []).length + (second.data ?? []).length).toBe(1);

    const post = await row("prog-ok");
    await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: post.id, p_ok: true });
    expect(await row("prog-ok")).toMatchObject({ schedule_state: "scheduled", buffer_status: "scheduled" });
    expect((await claimOne("prog-ok")).data).toEqual([]);
  });

  it("après un échec, le post peut être retenté puis programmé", async () => {
    const post = await row("prog-echec");
    expect((await claimOne("prog-echec")).data).toHaveLength(1);
    await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: post.id, p_ok: false, p_error: "Canal déconnecté" });
    expect(await row("prog-echec")).toMatchObject({ schedule_state: "failed", schedule_error: "Canal déconnecté", approval_status: "approved" });
    expect((await claimOne("prog-echec")).data).toHaveLength(1);
    await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: post.id, p_ok: true });
    expect((await row("prog-echec")).schedule_state).toBe("scheduled");
  });
});

describe("synchronisation", () => {
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
    await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: post.id, p_ok: true });

    const result = await sync([{ key: "sync-invalide", status: "scheduled", text: "Texte changé après validation" }]);
    expect(result.invalidated).toBe(1);
    expect(await row("sync-invalide")).toMatchObject({ approval_status: "pending", version: 2, approved_hash: null, schedule_state: "unschedule_pending" });

    const pending = (await automation.rpc("list_posts_to_unschedule", { p_secret: SECRET })).data as { id: string }[];
    expect(pending.some((item) => item.id === post.id)).toBe(true);
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
    await automation.rpc("complete_scheduling", { p_secret: SECRET, p_post_id: post.id, p_ok: true });
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
