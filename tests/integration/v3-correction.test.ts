import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { configureIsolatedTests, loadLocalEnv, requireEnv } from "../support/env";
import { FileProvider, readState, writeState, emptyState } from "../support/file-provider";

/*
 * Mission V3 — intégration sur PostgreSQL NATIF (pile isolée), HTTP/PostgREST réel, vrais JWT, faux Buffer PERSISTANT
 * (fichier JSON qui COMPTE les effets) et processus qui s'arrêtent brutalement (SIGKILL). Couvre T01 (isolation entre
 * clients, transferts, imports concurrents), T02 (créations incertaines), T03 (compensation, reprise, deux workers).
 * Aucune clé Buffer, aucun e-mail, aucune base d'application : la pile est celle créée par scripts/test-stack.mjs.
 */

loadLocalEnv();
configureIsolatedTests();

const RUN = `v3-${Date.now()}`;
const SECRET = requireEnv("AUTOMATION_SECRET");
const URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const DB_CONTAINER = requireEnv("TEST_DB_CONTAINER");
const FUTURE = "2031-03-10T09:00:00.000Z";
const FILE = join(mkdtempSync(join(tmpdir(), "cadence-v3-")), "buffer.json");

let automation: SupabaseClient;
let admin: SupabaseClient;
let ines: SupabaseClient;
let sofia: SupabaseClient;
let anonymous: SupabaseClient;
let colibri: string;
let nordwind: string;
let inesId: string;
let provider: FileProvider;

// Les modules serveur parlent à la base avec « leur » client : ici, des clients de session et d'automatisation réels.
vi.mock("@/server/supabase/clients", () => ({
  createSessionClient: async () => admin,
  getAutomationClient: () => automation,
}));
// Seul le fournisseur externe est remplacé : emissionProblem utilise les vraies RPC de la pile isolée.
vi.mock("@/server/publishing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/publishing")>(),
  getProvider: () => provider,
}));

const client = (): SupabaseClient =>
  createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket } });

async function signedIn(user: "ADMIN" | "INES" | "SOFIA"): Promise<SupabaseClient> {
  const supabase = client();
  const { error } = await supabase.auth.signInWithPassword({ email: requireEnv(`DEMO_${user}_EMAIL`), password: requireEnv(`DEMO_${user}_PASSWORD`) });
  if (error) throw new Error(`Connexion ${user} impossible : ${error.message}`);
  return supabase;
}

/** SQL en tant que propriétaire, dans le conteneur de CETTE pile uniquement (vieillissement d'un état, retrait d'un rôle…). */
function owner(sql: string): string {
  return execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();
}

const bufferId = (key: string) => `mock-${RUN}-${key}`;
const CH = (key: string) => `mock-ch-${RUN}-${key}`;

const channelRows = (keys: string[], slug = "maison-colibri") =>
  keys.map((key) => ({ id: CH(key), service: "linkedin", name: `V3 ${key}`, displayName: null, avatar: null, isDisconnected: false, organizationSlug: slug }));

/** Envoie un état de Buffer à la base (ce que le serveur ferait après lecture). */
async function importPosts(posts: { key: string; channel: string; text?: string; tagged?: boolean; status?: string }[], channels: string[]) {
  const { data, error } = await automation.rpc("sync_buffer_posts", {
    p_secret: SECRET,
    p_payload: {
      mode: "mock", triggeredBy: "v3", complete: false,
      channels: channelRows(channels),
      posts: posts.map((post) => ({
        id: bufferId(post.key), channelId: CH(post.channel), service: "linkedin", status: post.status ?? "draft", text: post.text ?? `Texte ${post.key}`,
        dueAt: FUTURE, hasReviewTag: post.tagged ?? true, assets: [],
      })),
    },
  });
  if (error) throw new Error(error.message);
  return data;
}

async function post(key: string) {
  const { data, error } = await admin.from("posts").select("*").eq("buffer_post_id", bufferId(key)).single();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

const channelUuid = async (key: string) => {
  const { data } = await admin.from("channels").select("id").eq("buffer_channel_id", CH(key)).single();
  return data!.id as string;
};

const state = () => readState(FILE);
const calls = (name: string) => state().calls[name] ?? 0;

/** Contenu du Studio d'un canal de test, prêt à être envoyé. */
async function newDraft(key: string, text: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc("studio_save_draft", {
    p_id: null, p_expected_revision: null,
    p_payload: { organizationId: colibri, title: `V3 ${key}`, dueAt: FUTURE, variants: [{ channelId: await channelUuid("studio"), text }], ...extra },
  });
  if (error) throw new Error(error.message);
  return (data as { id: string; revision: number }).id;
}

const variantOf = async (draftId: string) => {
  const { data } = await admin.from("studio_variants").select("*").eq("draft_id", draftId).is("removed_at", null).single();
  return data as Record<string, unknown>;
};

let push: (draftId: string) => Promise<{ ok: boolean; created: number; updated: number; failed: number; unknown?: number; code?: string; message: string }>;
let reconcile: (draftId: string) => Promise<{ ok: boolean; unknown?: number; code?: string; message: string }>;
let confirmAbsent: (draftId: string, evidence: string) => Promise<{ ok: boolean; message: string }>;
let runUrgent: () => Promise<{ ok: boolean; skipped?: string; compensated: number; compensationFailures: number; reconciled: number }>;
let runUrgentCycle: typeof import("@/server/urgent").runUrgentCycle;

beforeAll(async () => {
  provider = new FileProvider(FILE, `mock-${RUN}-b`);
  automation = client();
  [admin, ines, sofia] = await Promise.all([signedIn("ADMIN"), signedIn("INES"), signedIn("SOFIA")]);
  anonymous = client();
  const orgs = await admin.from("organizations").select("id, slug");
  colibri = orgs.data!.find((org) => org.slug === "maison-colibri")!.id;
  nordwind = orgs.data!.find((org) => org.slug === "nordwind-cycles")!.id;
  inesId = (await ines.auth.getUser()).data.user!.id;

  const studio = await import("@/server/studio");
  push = studio.pushDraftToBuffer;
  reconcile = studio.reconcileDraftPush;
  confirmAbsent = studio.confirmDraftAbsent;
  const urgent = await import("@/server/urgent");
  runUrgent = urgent.runUrgent;
  runUrgentCycle = urgent.runUrgentCycle;
});

afterAll(() => {
  // Aucune pause de quota ne doit survivre à ce fichier (la base de la pile est partagée avec les autres suites).
  owner("update public.sync_state set backoff_until = null, backoff_reason = null, backoff_hard = false where mode = 'mock'");
});

beforeEach(async () => {
  const fresh = emptyState();
  fresh.snapshotComplete = false;
  fresh.channels = channelRows(["studio", "iso"]);
  writeState(FILE, fresh);
  owner("update public.sync_state set backoff_until = null, backoff_reason = null, backoff_hard = false, urgent_until = null, urgent_token = null where mode = 'mock'");
  // Chaque test repart sans annulation ni réservation en cours laissées par un autre (la base de la pile est partagée).
  owner("update public.posts set schedule_state = 'idle', schedule_token = null where schedule_state in ('claimed', 'unschedule_pending') and buffer_post_id like 'mock-%'");
  // Le canal du Studio existe en base (créé par une synchronisation sans publication).
  await importPosts([], ["studio"]);
});

describe("T01 — isolation entre clients, avec les vrais JWT (HTTP/PostgREST)", () => {
  /** Tout ce qu'un client peut lire d'une publication, par table liée. */
  const leaks = async (who: SupabaseClient, postId: string, text: string) => {
    const found: string[] = [];
    const probes: [string, () => PromiseLike<{ data: unknown[] | null; error: unknown }>][] = [
      ["posts", () => who.from("posts").select("id").eq("id", postId)],
      ["posts(texte)", () => who.from("posts").select("id").ilike("text", `%${text}%`)],
      ["post_versions", () => who.from("post_versions").select("post_id").eq("post_id", postId)],
      ["comments", () => who.from("comments").select("id").eq("post_id", postId)],
      ["approval_decisions", () => who.from("approval_decisions").select("id").eq("post_id", postId)],
      ["post_events", () => who.from("post_events").select("id").eq("post_id", postId)],
      ["notifications", () => who.from("notifications").select("id").eq("post_id", postId)],
      ["channel_owner_history", () => who.from("channel_owner_history").select("id")],
      ["studio_drafts", () => who.from("studio_drafts").select("id")],
      ["studio_variants", () => who.from("studio_variants").select("id")],
      ["media_assets", () => who.from("media_assets").select("id")],
      ["studio_push_events", () => who.from("studio_push_events").select("id")],
    ];
    for (const [name, probe] of probes) {
      const { data } = await probe();
      if (data && data.length > 0) found.push(`${name}:${data.length}`);
    }
    return found;
  };

  it("transfert A → B d'un canal VIDE puis import tardif d'un ancien contenu de A : B ne lit rien, A non plus, seul l'administrateur", async () => {
    const text = `CONFIDENTIEL-A-${RUN}`;
    await importPosts([], ["iso-a"]);
    const channelId = await channelUuid("iso-a");
    const assign = await admin.rpc("admin_assign_channel", { p_channel_id: channelId, p_organization_id: nordwind, p_confirm_transfer: false });
    expect(assign.error).toBeNull();
    expect(assign.data).toMatchObject({ transferred: true });

    await importPosts([{ key: "iso-old", channel: "iso-a", text }], ["iso-a"]);
    const imported = await post("iso-old");
    expect(imported).toMatchObject({ ownership: "ambiguous", owner_organization_id: null });
    expect(await leaks(sofia, imported.id as string, text)).toEqual([]);
    expect(await leaks(ines, imported.id as string, text)).toEqual([]);
    expect(await leaks(anonymous, imported.id as string, text)).toEqual([]);
    expect((await admin.from("posts").select("id").eq("id", imported.id as string)).data).toHaveLength(1);

    // B ne peut ni décider, ni commenter ce contenu.
    const decide = await sofia.rpc("decide_post", { p_post_id: imported.id, p_decision: "approved", p_expected_hash: imported.content_hash, p_comment: null });
    expect(decide.error).not.toBeNull();

    // Attribution à A alors que le canal appartient à B : rien à décider, rien à lire (conservateur), B jamais.
    const owned = await admin.rpc("admin_set_post_owner", { p_post_ids: [imported.id], p_organization_id: colibri });
    expect(owned.error).toBeNull();
    expect(await leaks(sofia, imported.id as string, text)).toEqual([]);
    const blocked = await ines.rpc("decide_post", { p_post_id: imported.id, p_decision: "approved", p_expected_hash: imported.content_hash, p_comment: null });
    expect(blocked.error).not.toBeNull();
    expect(await leaks(sofia, imported.id as string, text)).toEqual([]);
  });

  it("A → B → A, détachements multiples, même propriétaire, absence de posts : aucun contenu de B ne devient lisible de A et réciproquement", async () => {
    await importPosts([], ["iso-b"]);
    const channelId = await channelUuid("iso-b");
    const move = async (to: string | null) => {
      const result = await admin.rpc("admin_assign_channel", { p_channel_id: channelId, p_organization_id: to, p_confirm_transfer: true });
      expect(result.error).toBeNull();
    };
    await move(colibri); // même propriétaire : ni transfert ni erreur
    await move(null);
    await move(nordwind);
    await move(null);
    await move(null);
    await move(colibri);
    const history = await admin.from("channel_owner_history").select("kind").eq("channel_id", channelId).order("id");
    expect(history.data!.map((row) => row.kind)).toEqual(["detach", "transfer", "detach", "transfer"]);

    await importPosts([{ key: "iso-late", channel: "iso-b", text: `ANCIEN-${RUN}` }], ["iso-b"]);
    const late = await post("iso-late");
    expect(late.ownership).toBe("ambiguous");
    for (const who of [ines, sofia, anonymous]) expect(await leaks(who, late.id as string, `ANCIEN-${RUN}`)).toEqual([]);
  });

  it("import concurrent au transfert (deux connexions réelles, 10 manches) : jamais lisible du client B", async () => {
    for (let round = 0; round < 10; round += 1) {
      const key = `race-${round}`;
      await importPosts([], [key]);
      const channelId = await channelUuid(key);
      const [moved, imported] = await Promise.all([
        admin.rpc("admin_assign_channel", { p_channel_id: channelId, p_organization_id: nordwind, p_confirm_transfer: true }),
        automation.rpc("sync_buffer_posts", {
          p_secret: SECRET,
          p_payload: {
            mode: "mock", triggeredBy: "v3", complete: false, channels: channelRows([key]),
            posts: [{ id: bufferId(`${key}-old`), channelId: CH(key), service: "linkedin", status: "draft", text: `COURSE-${RUN}-${round}`, dueAt: FUTURE, hasReviewTag: true, assets: [] }],
          },
        }),
      ]);
      expect(moved.error).toBeNull();
      expect(imported.error).toBeNull();
      const created = await post(`${key}-old`);
      // Quel que soit l'ordre des transactions : jamais attribué à B, jamais lisible de B.
      expect(created.owner_organization_id).not.toBe(nordwind);
      expect(await leaks(sofia, created.id as string, `COURSE-${RUN}-${round}`)).toEqual([]);
    }
  });

  it("le stockage des médias : ni l'autre client, ni le propriétaire, ni l'anonyme ne téléchargent un objet (modèle actuel : administrateur seul)", async () => {
    const path = `${colibri}/v3-${RUN}.png`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const upload = await admin.storage.from("media").upload(path, png, { contentType: "image/png" });
    expect(upload.error?.message ?? null).toBeNull();
    for (const who of [ines, sofia, anonymous]) {
      const read = await who.storage.from("media").download(path);
      expect(read.error).not.toBeNull();
    }
    const read = await admin.storage.from("media").download(path);
    expect(Buffer.from(await read.data!.arrayBuffer()).equals(png)).toBe(true);
  });
});

describe("T02 — créations Buffer incertaines (faux Buffer persistant qui compte ses créations)", () => {
  it("réponse perdue après la création : le renvoi (normal, double clic) ne crée rien de plus", async () => {
    const draft = await newDraft("lost", "Texte perdu");
    const s = state();
    s.faults = ["createDraft:lose"];
    writeState(FILE, s);
    const first = await push(draft);
    expect(first).toMatchObject({ ok: false, unknown: 1, code: "push_unknown" });
    expect(calls("createDraft")).toBe(1);
    expect((await variantOf(draft)).push_state).toBe("unknown");

    const [again, double] = await Promise.all([push(draft), push(draft)]);
    expect(again.code).toBe("push_unknown");
    expect(double.code).toBe("push_unknown");
    expect(calls("createDraft")).toBe(1);
  });

  it("deux envois simultanés d'un contenu neuf : une seule création", async () => {
    const draft = await newDraft("parallel", "Texte parallèle");
    const results = await Promise.all([push(draft), push(draft)]);
    expect(calls("createDraft")).toBe(1);
    expect(results.filter((result) => result.created === 1)).toHaveLength(1);
  });

  it("exception inattendue après l'effet (pas une erreur de fournisseur) : inconnu, pas un échec certain", async () => {
    const draft = await newDraft("crash-inproc", "Texte exception");
    const s = state();
    s.faults = ["createDraft:crash"];
    writeState(FILE, s);
    const result = await push(draft);
    expect(result).toMatchObject({ unknown: 1, code: "push_unknown" });
    expect(calls("createDraft")).toBe(1);
    expect((await push(draft)).code).toBe("push_unknown");
    expect(calls("createDraft")).toBe(1);
  });

  it("processus ARRÊTÉ (SIGKILL) après l'effet et avant l'enregistrement : aucun renvoi, normal ou après vieillissement, ne crée ; la réconciliation adopte", async () => {
    const draft = await newDraft("sigkill", "Texte du crash");
    const worker = spawnSync(process.execPath, [resolve("tests/support/crash-worker.mjs"), JSON.stringify({
      action: "studio-create-then-die", run: RUN, url: URL, anon: ANON, file: FILE, draftId: draft,
      email: requireEnv("DEMO_ADMIN_EMAIL"), password: requireEnv("DEMO_ADMIN_PASSWORD"),
    })], { encoding: "utf8" });
    expect(worker.signal).toBe("SIGKILL");
    expect(calls("createDraft")).toBe(1);
    expect((await variantOf(draft)).push_state).toBe("pushing");

    // Nouveau processus : l'envoi est « en cours » (moins de cinq minutes).
    expect((await push(draft)).code).toBe("push_in_progress");
    owner("update public.studio_variants set push_claimed_at = now() - interval '6 minutes' where push_state = 'pushing'");
    // Plus de cinq minutes : abandonné = inconnu, jamais un échec certain, jamais forçable.
    expect((await push(draft)).code).toBe("push_unknown");
    expect(calls("createDraft")).toBe(1);

    const found = await reconcile(draft);
    expect(found, found.message).toMatchObject({ ok: true });
    const adopted = await variantOf(draft);
    expect(adopted.buffer_post_id).toMatch(new RegExp(`^mock-${RUN}-crash-`));
    const sent = await push(draft);
    expect(sent.created).toBe(0);
    expect(calls("createDraft")).toBe(1);
    expect(calls("updateDraft")).toBe(1);
  });

  it("ancien identifiant supprimé dans Buffer, recréation, réponse perdue : inconnu malgré l'ancien identifiant", async () => {
    const draft = await newDraft("recreate", "Texte recréé");
    const first = await push(draft);
    expect(first, first.message).toMatchObject({ created: 1 });
    const oldId = (await variantOf(draft)).buffer_post_id as string;
    const s = state();
    delete s.posts[oldId];
    s.faults = ["createDraft:lose"];
    writeState(FILE, s);
    // Une nouvelle révision à envoyer (texte modifié).
    const saved = await admin.rpc("studio_save_draft", {
      p_id: draft, p_expected_revision: 1,
      p_payload: { organizationId: colibri, title: "V3 recreate", dueAt: FUTURE, variants: [{ channelId: await channelUuid("studio"), text: "Texte recréé v2" }] },
    });
    expect(saved.error).toBeNull();
    const second = await push(draft);
    expect(second).toMatchObject({ unknown: 1, code: "push_unknown" });
    expect(calls("createDraft")).toBe(2);
    expect((await variantOf(draft)).push_state).toBe("unknown");
    expect((await push(draft)).code).toBe("push_unknown");
    expect(calls("createDraft")).toBe(2);
  });

  it("réconciliation prudente : un candidat « error » ou « sent » n'est pas adopté, une lecture incomplète ne prouve pas l'absence", async () => {
    const draft = await newDraft("reconcile", "Texte à retrouver");
    const s = state();
    s.faults = ["createDraft:lose"];
    writeState(FILE, s);
    await push(draft);
    // Le brouillon créé est passé en erreur dans Buffer.
    const created = state();
    const [id] = Object.keys(created.posts);
    created.posts[id].status = "error";
    writeState(FILE, created);
    owner("update public.studio_variants set push_unknown_at = now() - interval '11 minutes' where push_state = 'unknown'");
    const result = await reconcile(draft);
    expect(result.ok).toBe(false);
    expect((await variantOf(draft)).push_state).toBe("unknown");
    expect((await variantOf(draft)).buffer_post_id).toBeNull();

    // Rien de retrouvé + lecture incomplète : « absence non prouvée », toujours inconnu.
    const empty = state();
    empty.posts = {};
    empty.snapshotComplete = false;
    writeState(FILE, empty);
    const absent = await reconcile(draft);
    expect(absent).toMatchObject({ ok: false, code: "push_absent_unproven" });
    expect((await variantOf(draft)).push_state).toBe("unknown");
    expect(calls("createDraft")).toBe(1);
  });

  it("l'absence confirmée est une dérogation : preuve exigée, délai exigé, tentative consignée, puis un renvoi crée (risque assumé et tracé)", async () => {
    const draft = await newDraft("absent", "Texte absent");
    const s = state();
    s.faults = ["createDraft:lose"];
    writeState(FILE, s);
    await push(draft);
    const cleared = state();
    cleared.posts = {};
    writeState(FILE, cleared);

    const tooSoon = await confirmAbsent(draft, "Brouillons du canal relus dans Buffer : aucun.");
    expect(tooSoon.ok).toBe(false);
    owner("update public.studio_variants set push_unknown_at = now() - interval '11 minutes' where push_state = 'unknown'");
    const noProof = await confirmAbsent(draft, "ok");
    expect(noProof.ok).toBe(false);
    const confirmed = await confirmAbsent(draft, "Brouillons du canal relus dans Buffer à 14 h : aucun à ce texte.");
    expect(confirmed.ok).toBe(true);
    const attempt = (await variantOf(draft)).push_attempt as Record<string, unknown>;
    expect(attempt).toMatchObject({ absenceEvidence: expect.stringContaining("relus dans Buffer"), attemptId: expect.any(String) });
    expect(attempt.absenceConfirmedBy).toBeTruthy();
    const resent = await push(draft);
    expect(resent.created).toBe(1);
    expect(calls("createDraft")).toBe(2);
  });
});

describe("T03 — compensation, reprise après crash, deux workers (horloge réelle, base native)", () => {
  /** Une publication approuvée par A, prête à être réservée, présente dans le faux Buffer. */
  async function approvedPost(key: string) {
    await importPosts([{ key, channel: "studio", text: `Texte ${key}` }], ["studio"]);
    const imported = await post(key);
    const s = state();
    s.posts[bufferId(key)] = {
      id: bufferId(key), channelId: CH("studio"), service: "linkedin", status: "draft", text: `Texte ${key}`, dueAt: FUTURE, sentAt: null,
      updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [],
    };
    writeState(FILE, s);
    const decision = await ines.rpc("decide_post", { p_post_id: imported.id, p_decision: "approved", p_expected_hash: imported.content_hash, p_comment: null });
    expect(decision.error).toBeNull();
    return imported.id as string;
  }

  const crashAfterAccept = (postId: string, key: string) => {
    const worker = spawnSync(process.execPath, [resolve("tests/support/crash-worker.mjs"), JSON.stringify({
      action: "schedule-then-die", url: URL, anon: ANON, secret: SECRET, file: FILE, postId, bufferPostId: bufferId(key),
    })], { encoding: "utf8" });
    expect(worker.signal).toBe("SIGKILL");
  };

  const restoreMember = () => admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: inesId, p_member: true });
  /** Écritures de Cadence vers le faux Buffer. Doit rester à 0 en lecture seule (les écritures de l'ancien moteur, historiques, sont exclues par un relevé de référence). */
  const writeCalls = () => ["createDraft", "updateDraft", "rescheduleDraft", "schedulePost", "unschedulePost"].reduce((sum, name) => sum + calls(name), 0);
  /** L'agence agit À LA MAIN dans Buffer : le faux Buffer change de statut, sans passer par Cadence. */
  const byHand = (key: string, status: "draft" | "scheduled") => {
    const s = state();
    s.posts[bufferId(key)].status = status;
    writeState(FILE, s);
  };

  it("crash APRÈS l'acceptation de Buffer (état hérité) puis retrait de l'approbateur : le passage urgent constate sans écrire, la publication reste « à confirmer » tant qu'elle est programmée, puis le retour en brouillon fait à la main est constaté — lecture seule", async () => {
    const postId = await approvedPost("c3-revoked");
    crashAfterAccept(postId, "c3-revoked");
    expect(state().posts[bufferId("c3-revoked")].status).toBe("scheduled");
    expect(await post("c3-revoked")).toMatchObject({ schedule_state: "claimed" });
    // Référence : l'écriture de l'ancien moteur (historique) est comptée ici ; rien de nouveau ne doit suivre.
    const writesBefore = writeCalls();

    try {
      const removed = await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: inesId, p_member: false });
      expect(removed.error).toBeNull();
      // Le serveur « redémarre » : le traitement urgent est le seul à tourner (aucun poll général).
      const started = Date.now();
      // Buffer indique encore « programmé » : le passage signale l'écart, sans annuler ni réécrire. (D'autres accords d'Inès
      // des suites précédentes de la pile partagée peuvent être constatés en même temps : compteurs « au moins ».)
      const first = await runUrgent();
      expect(first.ok).toBe(false);
      expect(first.compensationFailures).toBeGreaterThanOrEqual(1);
      expect(calls("fetchSnapshot")).toBe(0);
      expect(calls("unschedulePost")).toBe(0);
      expect(writeCalls()).toBe(writesBefore);
      expect(state().posts[bufferId("c3-revoked")].status).toBe("scheduled");
      expect(await post("c3-revoked")).toMatchObject({ schedule_state: "unschedule_pending" });

      // L'agence repasse la publication en brouillon à la main ; le passage suivant le constate.
      byHand("c3-revoked", "draft");
      const result = await runUrgent();
      expect(result.ok).toBe(true);
      expect(result.compensated).toBeGreaterThanOrEqual(1);
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(calls("fetchSnapshot")).toBe(0);
      expect(calls("unschedulePost")).toBe(0);
      expect(writeCalls()).toBe(writesBefore);
      expect(state().posts[bufferId("c3-revoked")].status).toBe("draft");
      expect(await post("c3-revoked")).toMatchObject({ schedule_state: "idle", buffer_status: "draft", approval_status: "pending" });
    } finally {
      await restoreMember();
    }
  });

  it("crash après l'acceptation, accord toujours valable : la réservation abandonnée est rapprochée et confirmée avec SON jeton", async () => {
    const postId = await approvedPost("c3-valid");
    crashAfterAccept(postId, "c3-valid");
    // Avant le délai de grâce : rien à reprendre.
    expect(await runUrgent()).toMatchObject({ skipped: "idle" });
    owner(`update public.posts set schedule_claimed_at = now() - interval '3 minutes' where id = '${postId}'`);
    const result = await runUrgent();
    expect(result).toMatchObject({ ok: true, reconciled: 1, compensated: 0 });
    expect(await post("c3-valid")).toMatchObject({ schedule_state: "scheduled", buffer_status: "scheduled" });
    expect(calls("unschedulePost")).toBe(0);
  });

  it("crash après l'acceptation, contenu modifié dans Buffer entre-temps : le passage urgent ne programme ni n'annule rien ; la publication non conforme reste « à confirmer » jusqu'au retour en brouillon constaté — lecture seule", async () => {
    const postId = await approvedPost("c3-edited");
    crashAfterAccept(postId, "c3-edited");
    const s = state();
    s.posts[bufferId("c3-edited")].text = "Texte retouché dans Buffer après l'accord";
    writeState(FILE, s);
    owner(`update public.posts set schedule_claimed_at = now() - interval '3 minutes' where id = '${postId}'`);
    const writesBefore = writeCalls();
    // Réservation abandonnée et contenu différent : Cadence le constate, sans rien écrire. Buffer est toujours programmé.
    const first = await runUrgent();
    expect(first.ok).toBe(false);
    expect(first.compensationFailures).toBeGreaterThanOrEqual(1);
    expect(calls("unschedulePost")).toBe(0);
    expect(writeCalls()).toBe(writesBefore);
    expect(state().posts[bufferId("c3-edited")].status).toBe("scheduled");
    expect(await post("c3-edited")).toMatchObject({ schedule_state: "unschedule_pending" });

    // L'agence repasse en brouillon à la main ; le constat est enregistré au passage suivant.
    byHand("c3-edited", "draft");
    const result = await runUrgent();
    expect(result).toMatchObject({ ok: true });
    expect(result.compensated).toBeGreaterThanOrEqual(1);
    expect(calls("unschedulePost")).toBe(0);
    expect(writeCalls()).toBe(writesBefore);
    expect(state().posts[bufferId("c3-edited")].status).toBe("draft");
    expect(await post("c3-edited")).toMatchObject({ schedule_state: "idle", buffer_status: "draft" });
  });

  it("deux workers simultanés : aucune écriture chez Buffer, constat enregistré — lecture seule", async () => {
    const postId = await approvedPost("c3-two");
    crashAfterAccept(postId, "c3-two");
    try {
      await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: inesId, p_member: false });
      byHand("c3-two", "draft");
      const writesBefore = writeCalls();
      const [a, b] = await Promise.all([runUrgentCycle(provider), runUrgentCycle(provider)]);
      expect(calls("unschedulePost")).toBe(0);
      expect(writeCalls()).toBe(writesBefore);
      // Soit l'un a été écarté par le verrou, soit le second est passé après le premier, qui avait déjà constaté : au moins un constat.
      expect(a.compensated + b.compensated).toBeGreaterThanOrEqual(1);
      expect(await post("c3-two")).toMatchObject({ schedule_state: "idle", buffer_status: "draft" });
    } finally {
      await restoreMember();
    }
  });

  it("quota de requêtes Buffer atteint (pause posée par le serveur) : échec durable et visible, aucune relecture pendant la pause, reprise à l'échéance, constat seulement une fois la publication repassée en brouillon — jamais « annulé » — lecture seule", async () => {
    const postId = await approvedPost("c3-429");
    crashAfterAccept(postId, "c3-429");
    try {
      await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: inesId, p_member: false });
      // Quota atteint : pause de 48 heures posée par le serveur (ce que faisait le refus 429 de Buffer).
      const paused = await automation.rpc("set_sync_backoff", { p_secret: SECRET, p_mode: "mock", p_seconds: 172_800, p_reason: "Quota de requêtes Buffer atteint" });
      expect(paused.error).toBeNull();
      const pause = await automation.rpc("get_sync_pause", { p_secret: SECRET, p_mode: "mock" });
      expect(Date.parse((pause.data as { until: string }).until) - Date.now()).toBeGreaterThan(47 * 3_600_000);

      const getsBefore = calls("getPost");
      const writesBefore = writeCalls();
      const first = await runUrgent();
      expect(first.ok).toBe(false);
      expect(first.compensated).toBe(0);
      // Pendant la pause : aucune relecture, aucune écriture, et l'échec reste visible.
      expect(calls("getPost")).toBe(getsBefore);
      expect(writeCalls()).toBe(writesBefore);
      expect(await post("c3-429")).toMatchObject({ schedule_state: "unschedule_pending" });
      expect((await post("c3-429")).unschedule_attempts).toBeGreaterThanOrEqual(1);

      const second = await runUrgent();
      expect(second.ok).toBe(false);
      expect(calls("getPost")).toBe(getsBefore);
      expect(calls("unschedulePost")).toBe(0);
      expect(await post("c3-429")).toMatchObject({ schedule_state: "unschedule_pending" });

      // L'échéance de la pause passée : la publication est relue ; elle est toujours programmée, donc rien n'est annoncé annulé.
      owner("update public.sync_state set backoff_until = now() - interval '1 second' where mode = 'mock'");
      const third = await runUrgent();
      expect(third.ok).toBe(false);
      expect(state().posts[bufferId("c3-429")].status).toBe("scheduled");
      expect(await post("c3-429")).toMatchObject({ schedule_state: "unschedule_pending" });

      // L'agence repasse la publication en brouillon à la main ; le constat aboutit.
      byHand("c3-429", "draft");
      const fourth = await runUrgent();
      expect(fourth.ok).toBe(true);
      expect(calls("unschedulePost")).toBe(0);
      expect(writeCalls()).toBe(writesBefore);
      expect(await post("c3-429")).toMatchObject({ schedule_state: "idle", buffer_status: "draft" });
    } finally {
      await restoreMember();
    }
  });

  it("l'instantané général en échec ne bloque pas le constat (la reprise ne dépend pas du poll) — lecture seule", async () => {
    const postId = await approvedPost("c3-snapshot");
    crashAfterAccept(postId, "c3-snapshot");
    try {
      await admin.rpc("admin_set_member", { p_organization_id: colibri, p_user_id: inesId, p_member: false });
      // L'agence a repassé la publication en brouillon à la main ; l'instantané général, lui, échoue.
      const s = state();
      s.snapshotFails = true;
      s.posts[bufferId("c3-snapshot")].status = "draft";
      writeState(FILE, s);
      const result = await runUrgent();
      expect(result.ok).toBe(true);
      expect(calls("fetchSnapshot")).toBe(0);
      expect(calls("unschedulePost")).toBe(0);
      expect(state().posts[bufferId("c3-snapshot")].status).toBe("draft");
      expect(await post("c3-snapshot")).toMatchObject({ schedule_state: "idle", buffer_status: "draft" });
    } finally {
      await restoreMember();
    }
  });
});

describe("C08 — poses de pause concurrentes (deux connexions réelles)", () => {
  it("une pause de 48 h posée pendant qu'une exécution se termine avec 15 minutes n'est jamais raccourcie, quel que soit l'ordre", async () => {
    for (let round = 0; round < 8; round += 1) {
      owner("update public.sync_state set backoff_until = null, backoff_reason = null, backoff_hard = false, lock_token = null, locked_until = null where mode = 'mock'");
      const lock = await automation.rpc("begin_sync_run", { p_secret: SECRET, p_mode: "mock", p_triggered_by: "v3", p_scheduled: false });
      const token = (lock.data as { token: string }).token;
      const [paused, finished] = await Promise.all([
        automation.rpc("set_sync_backoff", { p_secret: SECRET, p_mode: "mock", p_seconds: 172_800, p_reason: "Quota atteint (429)" }),
        automation.rpc("finish_sync_run", { p_secret: SECRET, p_mode: "mock", p_token: token, p_ok: true, p_backoff_seconds: 900, p_backoff_reason: "Pause préventive" }),
      ]);
      expect(paused.error).toBeNull();
      expect(finished.error).toBeNull();
      const pause = (await automation.rpc("get_sync_pause", { p_secret: SECRET, p_mode: "mock" })).data as { until: string; hard: boolean };
      expect(Date.parse(pause.until) - Date.now(), `manche ${round}`).toBeGreaterThan(47 * 3_600_000);
      expect(pause.hard).toBe(true);
    }
  });

  it("deux réservations simultanées du même traitement urgent : une seule l'obtient", async () => {
    owner("update public.sync_state set urgent_until = null, urgent_token = null where mode = 'mock'");
    const [first, second] = await Promise.all([
      automation.rpc("begin_urgent_run", { p_secret: SECRET, p_mode: "mock" }),
      automation.rpc("begin_urgent_run", { p_secret: SECRET, p_mode: "mock" }),
    ]);
    const acquired = [first, second].filter((answer) => (answer.data as { acquired: boolean }).acquired);
    expect(acquired).toHaveLength(1);
    const token = (acquired[0].data as { token: string }).token;
    await automation.rpc("finish_urgent_run", { p_secret: SECRET, p_mode: "mock", p_token: token, p_ok: true, p_done: 0 });
  });
});
