import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FUTURE, LocalDb, type Actor } from "../support/local-db";

/*
 * Migration 0008 : Content Studio. Base PostgreSQL locale en mémoire.
 * Points centraux : tout est réservé à l'administrateur, rien du Studio n'est visible d'un client,
 * et un contenu ne peut pas être créé deux fois dans Buffer.
 */

let db: LocalDb;
afterEach(() => db?.close());

type Seed = Awaited<ReturnType<LocalDb["seed"]>>;
type Saved = { id: string; revision: number };
type Claim = { variant_id: string; buffer_channel_id: string; text: string; buffer_post_id: string | null; revision: number };

const channel = async (bufferId: string) => (await db.sql<{ id: string }>("select id from public.channels where buffer_channel_id = $1", [bufferId]))[0].id;
const save = async (actor: Actor, id: string | null, revision: number | null, payload: Record<string, unknown>) =>
  (await db.as<{ r: Saved }>(actor, "select public.studio_save_draft($1, $2, $3::jsonb) as r", [id, revision, JSON.stringify(payload)]))[0].r;
// L'ordre de RETURNING n'est pas garanti par PostgreSQL : les lignes sont triées pour que les tests soient déterministes.
const claim = (actor: Actor, draftId: string, force = false) =>
  db.as<Claim>(actor, "select * from public.studio_claim_push($1, $2) order by buffer_channel_id", [draftId, force]);
const complete = (actor: Actor, variantId: string, ok: boolean, bufferPostId: string | null, revision: number | null, error: string | null = null) =>
  db.as(actor, "select public.studio_complete_push($1, $2, $3, $4, $5)", [variantId, ok, bufferPostId, error, revision]);
const upload = async (actor: Actor, organizationId: string, name = "photo.jpg", mime = "image/jpeg") => {
  const path = `${organizationId}/${name}`;
  await db.sql("insert into storage.objects (bucket_id, name) values ('media', $1) on conflict do nothing", [path]);
  return (await db.as<{ id: string }>(actor, "select public.studio_register_media($1, $2, $3, $4, 120000, 1080, 1080) as id", [organizationId, path, name, mime]))[0].id;
};
const draft = async (id: string) => (await db.sql<Record<string, unknown>>("select * from public.studio_drafts where id = $1", [id]))[0];
const variants = (draftId: string) =>
  db.sql<{ push_state: string; buffer_post_id: string | null; removed_at: Date | null; text: string }>(
    "select v.push_state, v.buffer_post_id, v.removed_at, v.text from public.studio_variants v join public.channels c on c.id = v.channel_id where v.draft_id = $1 order by c.buffer_channel_id", [draftId]);

/** Base à jour, deux clients, leurs canaux créés par une première synchronisation. */
const start = async (): Promise<Seed & { c1: string; c2: string; n1: string }> => {
  db = await LocalDb.create();
  const seed = await db.seed();
  await db.sync([]);
  return { ...seed, c1: await channel("canal-colibri"), c2: await channel("canal-colibri-2"), n1: await channel("canal-nordwind") };
};

describe("droits", () => {
  it("seul l'administrateur prépare des contenus ; un client ne voit rien du Studio", async () => {
    const { admin, ines, colibri, c1 } = await start();
    const payload = { organizationId: colibri, title: "Guji", dueAt: FUTURE, variants: [{ channelId: c1, text: "Bonjour" }] };
    await expect(save(ines, null, null, payload)).rejects.toThrow("forbidden");
    await expect(save("anon", null, null, payload)).rejects.toThrow(/permission denied/);
    const saved = await save(admin, null, null, payload);
    await upload(admin, colibri);

    for (const table of ["studio_drafts", "studio_variants", "media_assets"]) {
      expect(await db.as(ines, `select 1 from public.${table}`)).toEqual([]);
      expect(await db.as(admin, `select 1 from public.${table}`)).toHaveLength(1);
      await expect(db.as(admin, `update public.${table} set created_at = now()`)).rejects.toThrow(/permission denied/);
    }
    await expect(claim(ines, saved.id)).rejects.toThrow("forbidden");
    await expect(db.as(ines, "select public.studio_set_draft_archived($1, true)", [saved.id])).rejects.toThrow("forbidden");
    await expect(db.as(ines, "select public.studio_register_media($1, $2, 'x.jpg', 'image/jpeg', 10)", [colibri, `${colibri}/x.jpg`])).rejects.toThrow("forbidden");
  });

  it("le stockage des médias est privé : lecture et dépôt par l'administrateur seulement, sans écrasement ni suppression", async () => {
    const { admin, ines, colibri } = await start();
    expect(await db.sql("select public, file_size_limit from storage.buckets where id = 'media'")).toEqual([{ public: false, file_size_limit: 52428800 }]);
    await db.as(admin, "insert into storage.objects (bucket_id, name) values ('media', $1)", [`${colibri}/a.jpg`]);
    await expect(db.as(ines, "insert into storage.objects (bucket_id, name) values ('media', $1)", [`${colibri}/b.jpg`])).rejects.toThrow(/row-level security/);
    expect(await db.as(ines, "select name from storage.objects")).toEqual([]);
    expect(await db.as(admin, "select name from storage.objects")).toHaveLength(1);
    // Aucune règle de modification ni de suppression : les requêtes ne touchent aucune ligne.
    await db.as(admin, "update storage.objects set name = 'ailleurs'");
    await db.as(admin, "delete from storage.objects");
    expect(await db.sql("select name from storage.objects")).toEqual([{ name: `${colibri}/a.jpg` }]);
  });
});

describe("médias", () => {
  it("enregistre un fichier déposé dans le dossier du client, et refuse le reste", async () => {
    const { admin, colibri, nordwind } = await start();
    const id = await upload(admin, colibri, "clip.mp4", "video/mp4");
    expect(await db.sql("select kind, file_name, organization_id from public.media_assets where id = $1", [id])).toEqual([{ kind: "video", file_name: "clip.mp4", organization_id: colibri }]);

    const register = (org: string, path: string, mime = "image/jpeg", size = 1000) =>
      db.as(admin, "select public.studio_register_media($1, $2, 'f', $3, $4)", [org, path, mime, size]);
    await expect(register(colibri, `${colibri}/absent.jpg`)).rejects.toThrow("media_not_uploaded");
    await expect(register(nordwind, `${colibri}/clip.mp4`, "video/mp4")).rejects.toThrow("invalid_media_path");
    await expect(register(colibri, `${colibri}/../x.jpg`)).rejects.toThrow("invalid_media_path");
    await expect(register(colibri, `${colibri}/clip.mp4`, "application/pdf")).rejects.toThrow("invalid_media_type");
    await expect(register(colibri, `${colibri}/clip.mp4`, "video/mp4", 60_000_000)).rejects.toThrow("invalid_media_size");
  });

  it("un contenu n'accepte que les médias de son client ; l'archivage ne retire rien aux contenus existants", async () => {
    const { admin, colibri, nordwind, c1 } = await start();
    const mine = await upload(admin, colibri);
    const other = await upload(admin, nordwind);
    const base = { organizationId: colibri, dueAt: FUTURE, variants: [{ channelId: c1, text: "T" }] };
    await expect(save(admin, null, null, { ...base, mediaIds: [other] })).rejects.toThrow("invalid_media");
    await expect(save(admin, null, null, { ...base, mediaIds: [mine, mine] })).rejects.toThrow("invalid_media");
    const saved = await save(admin, null, null, { ...base, mediaIds: [mine] });
    await db.as(admin, "select public.studio_set_media_archived($1, true)", [mine]);
    expect((await draft(saved.id)).media_ids).toEqual([mine]);
    expect(await db.sql("select count(*)::int as n from public.media_assets where archived_at is not null")).toEqual([{ n: 1 }]);
  });
});

describe("enregistrement d'un contenu", () => {
  it("crée, puis enregistre en incrémentant la révision ; un onglet en retard est refusé", async () => {
    const { admin, colibri, c1, c2 } = await start();
    const first = await save(admin, null, null, { organizationId: colibri, title: "  Guji  ", dueAt: FUTURE, hashtags: ["#café"], variants: [{ channelId: c1, text: "A" }] });
    expect(first.revision).toBe(1);
    expect(await draft(first.id)).toMatchObject({ title: "Guji", status: "draft", hashtags: ["#café"] });

    const second = await save(admin, first.id, 1, { title: "Guji", dueAt: FUTURE, variants: [{ channelId: c1, text: "A2" }, { channelId: c2, text: "B" }] });
    expect(second.revision).toBe(2);
    await expect(save(admin, first.id, 1, { title: "Écrasement", variants: [] })).rejects.toThrow("stale_revision");
    expect((await variants(first.id)).map((row) => row.text)).toEqual(["A2", "B"]);
  });

  it("refuse le canal d'un autre client, un canal en double, un client archivé", async () => {
    const { admin, colibri, c1, n1 } = await start();
    const base = { organizationId: colibri, dueAt: FUTURE };
    await expect(save(admin, null, null, { ...base, variants: [{ channelId: n1, text: "T" }] })).rejects.toThrow("invalid_channel");
    await expect(save(admin, null, null, { ...base, variants: [{ channelId: c1, text: "T" }, { channelId: c1, text: "U" }] })).rejects.toThrow("invalid_channel");
    await db.as(admin, "select public.admin_set_organization_archived($1, true)", [colibri]);
    await expect(save(admin, null, null, { ...base, variants: [] })).rejects.toThrow("organization_unavailable");
  });

  it("retirer un canal le marque sans rien effacer ; le remettre le réactive", async () => {
    const { admin, colibri, c1, c2 } = await start();
    const saved = await save(admin, null, null, { organizationId: colibri, dueAt: FUTURE, variants: [{ channelId: c1, text: "A" }, { channelId: c2, text: "B" }] });
    await save(admin, saved.id, 1, { dueAt: FUTURE, variants: [{ channelId: c1, text: "A" }] });
    expect((await variants(saved.id)).map((row) => row.removed_at !== null)).toEqual([false, true]);
    await save(admin, saved.id, 2, { dueAt: FUTURE, variants: [{ channelId: c1, text: "A" }, { channelId: c2, text: "B bis" }] });
    expect(await variants(saved.id)).toMatchObject([{ removed_at: null }, { removed_at: null, text: "B bis" }]);
  });

  it("le glisser-déposer ne change que la date ; l'archivage se défait", async () => {
    const { admin, colibri, c1 } = await start();
    const saved = await save(admin, null, null, { organizationId: colibri, dueAt: FUTURE, variants: [{ channelId: c1, text: "A" }] });
    const moved = (await db.as<{ r: Saved }>(admin, "select public.studio_reschedule_draft($1, 1, '2031-03-01T10:00:00Z') as r", [saved.id]))[0].r;
    expect(moved.revision).toBe(2);
    await expect(db.as(admin, "select public.studio_reschedule_draft($1, 1, '2031-03-02T10:00:00Z')", [saved.id])).rejects.toThrow("stale_revision");
    await db.as(admin, "select public.studio_set_draft_archived($1, true)", [saved.id]);
    await expect(save(admin, saved.id, 2, { variants: [] })).rejects.toThrow("draft_archived");
    await expect(claim(admin, saved.id)).rejects.toThrow("draft_archived");
    await db.as(admin, "select public.studio_set_draft_archived($1, false)", [saved.id]);
    expect((await draft(saved.id)).status).toBe("draft");
  });
});

describe("envoi vers Buffer", () => {
  const ready = async () => {
    const seed = await start();
    const saved = await save(seed.admin, null, null, { organizationId: seed.colibri, dueAt: FUTURE, variants: [{ channelId: seed.c1, text: "A" }, { channelId: seed.c2, text: "B" }] });
    return { ...seed, saved };
  };

  it("réserve chaque texte une seule fois : un double clic ne crée pas deux brouillons", async () => {
    const { admin, saved } = await ready();
    const first = await claim(admin, saved.id);
    expect(first.map((row) => [row.buffer_channel_id, row.text, row.buffer_post_id, row.revision])).toEqual([["canal-colibri", "A", null, 1], ["canal-colibri-2", "B", null, 1]]);
    await expect(claim(admin, saved.id)).rejects.toThrow("push_in_progress");
  });

  it("tout envoyé : le contenu passe à « envoyé » et rien n'est à renvoyer", async () => {
    const { admin, saved } = await ready();
    const [a, b] = await claim(admin, saved.id);
    await complete(admin, a.variant_id, true, "buf-a", 1);
    expect((await draft(saved.id)).status).toBe("draft");
    await complete(admin, b.variant_id, true, "buf-b", 1);
    expect(await draft(saved.id)).toMatchObject({ status: "submitted" });
    expect(await claim(admin, saved.id)).toEqual([]);
  });

  it("un échec partiel ne renvoie que ce qui a échoué, sans recréer ce qui existe", async () => {
    const { admin, saved } = await ready();
    const [a, b] = await claim(admin, saved.id);
    await complete(admin, a.variant_id, true, "buf-a", 1);
    await complete(admin, b.variant_id, false, null, null, "Canal déconnecté");
    expect(await variants(saved.id)).toMatchObject([{ push_state: "pushed", buffer_post_id: "buf-a" }, { push_state: "failed", buffer_post_id: null }]);
    const retry = await claim(admin, saved.id);
    expect(retry.map((row) => row.text)).toEqual(["B"]);
  });

  it("un contenu modifié après l'envoi met à jour le brouillon Buffer existant au lieu d'en créer un autre", async () => {
    const { admin, c1, c2, saved } = await ready();
    for (const row of await claim(admin, saved.id)) await complete(admin, row.variant_id, true, `buf-${row.text}`, 1);
    await save(admin, saved.id, 1, { dueAt: FUTURE, variants: [{ channelId: c1, text: "A corrigé" }, { channelId: c2, text: "B" }] });
    const again = await claim(admin, saved.id);
    expect(again.map((row) => [row.text, row.buffer_post_id, row.revision])).toEqual([["A corrigé", "buf-A", 2], ["B", "buf-B", 2]]);
    // Un canal déjà présent dans Buffer ne se retire pas depuis le Studio.
    for (const row of again) await complete(admin, row.variant_id, true, null, 2);
    await expect(save(admin, saved.id, 2, { dueAt: FUTURE, variants: [{ channelId: c1, text: "A" }] })).rejects.toThrow("variant_in_buffer");
    expect((await variants(saved.id)).map((row) => row.buffer_post_id)).toEqual(["buf-A", "buf-B"]);
  });

  it("un envoi interrompu n'est jamais repris, même forcé : il faut d'abord le résoudre", async () => {
    const { admin, saved } = await ready();
    await claim(admin, saved.id);
    await db.sql("update public.studio_variants set push_claimed_at = now() - interval '10 minutes'");
    // Contre-audit B6 : un envoi abandonné peut avoir créé le brouillon dans Buffer. Ni renvoi simple ni renvoi
    // forcé : il faut d'abord le résoudre (adoption ou absence confirmée par une personne).
    await expect(claim(admin, saved.id)).rejects.toThrow("push_unknown");
    await expect(claim(admin, saved.id, true)).rejects.toThrow("push_unknown");
  });

  it("refuse une date absente ou trop proche, un contenu sans canal, un canal passé à un autre client", async () => {
    const { admin, colibri, nordwind, c1 } = await start();
    const soon = await save(admin, null, null, { organizationId: colibri, dueAt: new Date(Date.now() + 60_000).toISOString(), variants: [{ channelId: c1, text: "A" }] });
    await expect(claim(admin, soon.id)).rejects.toThrow("date_invalid");
    const undated = await save(admin, null, null, { organizationId: colibri, variants: [{ channelId: c1, text: "A" }] });
    await expect(claim(admin, undated.id)).rejects.toThrow("date_invalid");
    const empty = await save(admin, null, null, { organizationId: colibri, dueAt: FUTURE, variants: [] });
    await expect(claim(admin, empty.id)).rejects.toThrow("no_variant");

    const moved = await save(admin, null, null, { organizationId: colibri, dueAt: FUTURE, variants: [{ channelId: c1, text: "A" }] });
    await db.as(admin, "select public.admin_assign_channel($1, $2, true)", [c1, nordwind]);
    await expect(claim(admin, moved.id)).rejects.toThrow("invalid_channel");
  });

  it("le Studio ne valide ni ne programme rien : la publication suit le circuit habituel", async () => {
    const { admin, ines, saved } = await ready();
    for (const row of await claim(admin, saved.id)) await complete(admin, row.variant_id, true, `buf-${row.text}`, 1);
    // Rien dans posts tant que Buffer n'a pas été relu.
    expect(await db.sql("select 1 from public.posts")).toEqual([]);
    await db.sync([{ id: "buf-A", text: "A" }]);
    expect(await db.post("buf-A")).toMatchObject({ approval_status: "pending", schedule_state: "idle" });
    expect(await db.automation("claim_posts_for_scheduling_in_mode", { p_mode: "real" })).toEqual([]);
    await db.decide(ines, "buf-A", "approved");
    expect(await db.automation("claim_posts_for_scheduling_in_mode", { p_mode: "real" })).toHaveLength(1);
  });
});

describe("historique des versions", () => {
  it("garde chaque version du contenu, visible du client concerné seulement", async () => {
    const { admin, ines, sofia } = await start();
    await db.sync([{ id: "p", text: "Version 1" }]);
    await db.sync([{ id: "p", text: "Version 2" }]);
    await db.sync([{ id: "p", text: "Version 2" }]);
    await db.decide(ines, "p", "approved");
    await db.sync([{ id: "p", text: "Version 3" }]);
    const texts = async (actor: Actor) => (await db.as<{ text: string }>(actor, "select text from public.post_versions order by version")).map((row) => row.text);
    expect(await texts(admin)).toEqual(["Version 1", "Version 2", "Version 3"]);
    expect(await texts(ines)).toEqual(["Version 1", "Version 2", "Version 3"]);
    expect(await texts(sofia)).toEqual([]);
    await expect(db.as(admin, "delete from public.post_versions")).rejects.toThrow(/permission denied/);
  });
});

describe("montée de version et retour arrière de 0008", () => {
  it("reprend la version actuelle des publications existantes, se rejoue, et se retire sans rien effacer", async () => {
    db = await LocalDb.create("0007");
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "ancien", text: "Avant" }]);
    await db.decide(ines, "ancien", "approved");
    const before = await db.post("ancien");
    await db.migrate("0008_studio.sql");
    await db.migrate("0008_studio.sql");
    expect(await db.post("ancien")).toEqual(before);
    expect(await db.sql("select version, text from public.post_versions")).toEqual([{ version: 1, text: "Avant" }]);
    const saved = await save(admin, null, null, { organizationId: colibri, dueAt: FUTURE, variants: [] });

    await db.exec(readFileSync(resolve(process.cwd(), "supabase/outils/0008_retour_arriere.sql"), "utf8"));
    await expect(save(admin, saved.id, 1, { variants: [] })).rejects.toThrow(/does not exist/);
    expect(await draft(saved.id)).toBeDefined();
    expect(await db.sql("select count(*)::int as n from public.post_versions")).toEqual([{ n: 1 }]);
    await db.sync([{ id: "ancien", text: "Avant" }], { complete: true });
    expect(await db.post("ancien")).toMatchObject({ approval_status: "approved" });
    await db.migrate("0008_studio.sql");
    expect((await save(admin, saved.id, 1, { variants: [] })).revision).toBe(2);
  });
});
