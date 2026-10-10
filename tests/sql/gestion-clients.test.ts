import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalDb, type Actor } from "../support/local-db";

/*
 * Migration 0005 : gestion des clients, attribution des canaux, accès.
 * Base PostgreSQL locale en mémoire. Le point central : un transfert de canal ne doit jamais
 * montrer à un client les publications, commentaires et décisions d'un autre.
 */

let db: LocalDb;
afterEach(() => db?.close());

const channelId = async (bufferId: string) => (await db.sql<{ id: string }>("select id from public.channels where buffer_channel_id = $1", [bufferId]))[0].id;
const assign = async (actor: Actor, bufferId: string, organizationId: string | null, confirm = false) =>
  (await db.as<{ r: { transferred: boolean; hidden_posts: number } }>(actor, "select public.admin_assign_channel($1, $2, $3) as r", [await channelId(bufferId), organizationId, confirm]))[0].r;
const visiblePosts = async (actor: Actor) =>
  (await db.as<{ buffer_post_id: string }>(actor, "select buffer_post_id from public.posts order by 1")).map((row) => row.buffer_post_id);
const count = async (actor: Actor, table: string) => Number((await db.as<{ n: string }>(actor, `select count(*) as n from public.${table}`))[0].n);
const saveOrg = (actor: Actor, id: string | null, name: string, extra: Partial<{ slug: string; timezone: string; color: string; initials: string }> = {}) =>
  db.as<{ id: string }>(actor, "select public.admin_save_organization($1, $2, $3, 'Secteur', $4, $5, $6) as id", [
    id, name, extra.slug ?? "nouveau-client", extra.timezone ?? "Europe/Paris", extra.initials ?? "NC", extra.color ?? "#1f4f8f",
  ]);

describe("montée de version", () => {
  it("0005 s'applique sur une base utilisée sans rien changer à ce que voient les clients", async () => {
    db = await LocalDb.create("0004");
    const { ines, sofia } = await db.seed();
    await db.sync([{ id: "c1" }, { id: "n1", channelId: "canal-nordwind" }]);
    await db.decide(ines, "c1", "changes_requested", "À revoir");
    const before = { ines: await visiblePosts(ines), sofia: await visiblePosts(sofia), comments: await count(ines, "comments") };
    await db.migrate("0005_gestion_clients.sql");
    expect({ ines: await visiblePosts(ines), sofia: await visiblePosts(sofia), comments: await count(ines, "comments") }).toEqual(before);
    expect(await db.sql("select count(*)::int as n from public.organizations where archived_at is not null")).toEqual([{ n: 0 }]);
    // La synchronisation et la validation fonctionnent toujours.
    await db.sync([{ id: "c1", text: "Corrigé" }, { id: "n1", channelId: "canal-nordwind" }]);
    await db.decide(ines, "c1", "approved");
    expect(await db.post("c1")).toMatchObject({ approval_status: "approved", version: 2 });
  });
});

describe("droits d'administration", () => {
  it("seul l'administrateur peut appeler les fonctions d'administration", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "c1" }]);
    const channel = await channelId("canal-colibri");
    const calls: [string, unknown[]][] = [
      ["select public.admin_save_organization(null, 'Pirate', 'pirate', '', 'Europe/Paris', 'PI', '#000000')", []],
      ["select public.admin_set_organization_archived($1, true)", [colibri]],
      ["select public.admin_assign_channel($1, $2, true)", [channel, colibri]],
      ["select public.admin_set_member($1, $2, true)", [colibri, ines.userId]],
      ["select public.admin_add_user($1, 'ines@test.example', 'Inès')", [colibri]],
      ["select * from public.admin_list_user_emails()", []],
    ];
    for (const [query, params] of calls) {
      await expect(db.as(ines, query, params), query).rejects.toThrow("forbidden");
      await expect(db.as("anon", query, params), query).rejects.toThrow(/permission denied/);
    }
    expect((await db.as(admin, "select * from public.admin_list_user_emails()")).length).toBe(3);
  });

  it("plus aucune écriture directe dans les tables, même pour l'administrateur", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    for (const actor of [admin, ines]) {
      await expect(db.as(actor, "update public.channels set organization_id = $1", [colibri])).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "update public.organizations set name = 'X'")).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "insert into public.organization_members (organization_id, user_id) values ($1, $2)", [colibri, ines.userId])).rejects.toThrow(/permission denied/);
    }
  });
});

describe("clients", () => {
  it("création, modification et contrôles de saisie", async () => {
    db = await LocalDb.create();
    const { admin, colibri } = await db.seed();
    const [{ id }] = await saveOrg(admin, null, "  Atelier Lumen  ", { slug: "atelier-lumen", initials: "al" });
    expect(await db.sql("select slug, name, initials, archived_at from public.organizations where id = $1", [id])).toEqual([{ slug: "atelier-lumen", name: "Atelier Lumen", initials: "AL", archived_at: null }]);

    // Même adresse demandée : elle est rendue unique. Même nom : refusé.
    const [second] = await saveOrg(admin, null, "Atelier Lumen Paris", { slug: "atelier-lumen" });
    expect(await db.sql("select slug from public.organizations where id = $1", [second.id])).toEqual([{ slug: "atelier-lumen-2" }]);
    await expect(saveOrg(admin, null, "atelier lumen")).rejects.toThrow("name_taken");

    // Modification : l'adresse ne change pas.
    await saveOrg(admin, id, "Lumen Studio", { slug: "autre-adresse", color: "#aa3300" });
    expect(await db.sql("select slug, name, color from public.organizations where id = $1", [id])).toEqual([{ slug: "atelier-lumen", name: "Lumen Studio", color: "#aa3300" }]);
    await saveOrg(admin, colibri, "colibri");

    await expect(saveOrg(admin, null, "   ")).rejects.toThrow("invalid_name");
    await expect(saveOrg(admin, null, "A", { timezone: "Mars/Olympus" })).rejects.toThrow("invalid_timezone");
    await expect(saveOrg(admin, null, "A", { color: "rouge" })).rejects.toThrow("invalid_color");
    await expect(saveOrg(admin, null, "A", { slug: "Pas Valide" })).rejects.toThrow("invalid_slug");
    await expect(saveOrg(admin, "00000000-0000-0000-0000-000000000000", "A")).rejects.toThrow("not_found");
  });

  it("l'archivage retire l'accès aux membres sans rien supprimer, et se défait", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, colibri } = await db.seed();
    await db.sync([{ id: "c1" }, { id: "n1", channelId: "canal-nordwind" }]);
    const rows = await db.sql("select count(*)::int as n from public.posts");

    await db.as(admin, "select public.admin_set_organization_archived($1, true)", [colibri]);
    expect(await visiblePosts(ines)).toEqual([]);
    expect(await count(ines, "organizations")).toBe(0);
    expect(await count(ines, "channels")).toBe(0);
    await expect(db.decide(ines, "c1", "approved")).rejects.toThrow("not_found");
    await expect(db.as(ines, "select public.add_comment($1, 'Bonjour')", [(await db.post("c1")).id])).rejects.toThrow("not_found");
    expect(await visiblePosts(sofia)).toEqual(["n1"]);
    expect(await visiblePosts(admin)).toEqual(["c1", "n1"]);
    expect(await db.sql("select count(*)::int as n from public.posts")).toEqual(rows);
    // Un canal ne peut pas être rattaché à un client archivé.
    await expect(assign(admin, "canal-libre", colibri)).rejects.toThrow("organization_unavailable");

    // Restauré : rien n'est rendu d'office. La validation retirée à l'archivage est redemandée à la
    // synchronisation suivante (le tag « à valider » est toujours présent dans Buffer).
    await db.as(admin, "select public.admin_set_organization_archived($1, false)", [colibri]);
    expect(await visiblePosts(ines)).toEqual([]);
    await db.sync([{ id: "c1" }, { id: "n1", channelId: "canal-nordwind" }]);
    expect(await visiblePosts(ines)).toEqual(["c1"]);
    await db.decide(ines, "c1", "approved");
  });
});

describe("attribution des canaux", () => {
  it("rattacher un canal jamais attribué montre ses publications en attente, le détacher les masque", async () => {
    db = await LocalDb.create();
    const { admin, ines, colibri } = await db.seed();
    await db.sync([{ id: "libre-1", channelId: "canal-libre" }]);
    expect(await visiblePosts(ines)).toEqual([]);

    expect(await assign(admin, "canal-libre", colibri)).toMatchObject({ transferred: false, hidden_posts: 0 });
    expect(await visiblePosts(ines)).toEqual(["libre-1"]);

    await assign(admin, "canal-libre", null);
    expect(await visiblePosts(ines)).toEqual([]);
    // Retour chez le même client : aucune confirmation. Ce qui attendait une décision a été suspendu au
    // détachement ; la demande de validation revient à la synchronisation suivante (tag toujours présent).
    expect(await assign(admin, "canal-libre", colibri)).toMatchObject({ transferred: false, hidden_posts: 0 });
    expect(await visiblePosts(ines)).toEqual([]);
    await db.sync([{ id: "libre-1", channelId: "canal-libre" }]);
    expect(await visiblePosts(ines)).toEqual(["libre-1"]);
  });

  it("un client peut avoir plusieurs comptes du même réseau ; un canal n'a jamais deux clients", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, nordwind } = await db.seed();
    await db.sync([{ id: "a" }, { id: "b", channelId: "canal-colibri-2" }]);
    expect(await visiblePosts(ines)).toEqual(["a", "b"]);
    expect(await db.sql("select count(*)::int as n from public.channels c join public.organizations o on o.id = c.organization_id where o.slug = 'colibri' and c.service = 'linkedin'")).toEqual([{ n: 2 }]);

    await assign(admin, "canal-colibri-2", nordwind, true);
    expect(await db.sql("select count(*)::int as n from public.channels where buffer_channel_id = 'canal-colibri-2'")).toEqual([{ n: 1 }]);
    expect(await visiblePosts(ines)).toEqual(["a"]);
    expect(await visiblePosts(sofia)).toEqual([]);
  });

  it("un transfert exige une confirmation et ne révèle rien de l'ancien client au nouveau", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, nordwind, colibri } = await db.seed();
    await db.sync([{ id: "ancien-1" }, { id: "ancien-2" }]);
    await db.decide(ines, "ancien-1", "changes_requested", "Commentaire confidentiel de Colibri");
    await db.decide(ines, "ancien-2", "approved");
    const old = await db.post("ancien-1");

    // Sans confirmation : refus, rien ne change. Vrai aussi en passant par « détacher puis rattacher ».
    await expect(assign(admin, "canal-colibri", nordwind)).rejects.toThrow("transfer_confirmation_required");
    await assign(admin, "canal-colibri", null);
    await expect(assign(admin, "canal-colibri", nordwind)).rejects.toThrow("transfer_confirmation_required");
    expect(await visiblePosts(sofia)).toEqual([]);

    expect(await assign(admin, "canal-colibri", nordwind, true)).toMatchObject({ transferred: true, hidden_posts: 2 });

    // Le nouveau client ne voit ni les anciennes publications ni leurs commentaires, décisions, événements.
    expect(await visiblePosts(sofia)).toEqual([]);
    for (const table of ["comments", "approval_decisions", "post_events"]) expect(await count(sofia, table), table).toBe(0);
    expect((await db.as<{ full_name: string }>(sofia, "select full_name from public.profiles")).map((row) => row.full_name)).not.toContain("ines");
    // Même en connaissant l'identifiant d'une ancienne publication, il ne peut ni décider ni commenter.
    await expect(db.as(sofia, "select public.decide_post($1, 'approved', $2)", [old.id, old.content_hash])).rejects.toThrow("not_found");
    await expect(db.as(sofia, "select public.add_comment($1, 'Je vois tout')", [old.id])).rejects.toThrow("not_found");
    // L'ancien client ne voit plus ce canal non plus ; l'administrateur garde tout.
    expect(await visiblePosts(ines)).toEqual([]);
    expect(await visiblePosts(admin)).toEqual(["ancien-1", "ancien-2"]);
    expect(await count(admin, "comments")).toBe(1);

    // Une publication découverte après le transfert peut être un ancien contenu importé tardivement :
    // elle reste réservée à l'administrateur tant qu'il ne l'a pas attribuée.
    await db.sync([{ id: "ancien-1" }, { id: "ancien-2" }, { id: "nouveau-1" }]);
    expect(await visiblePosts(sofia)).toEqual([]);
    expect(await visiblePosts(admin)).toEqual(["ancien-1", "ancien-2", "nouveau-1"]);
    const nouveau = await db.post("nouveau-1");
    expect(await db.sql("select ownership from public.posts where id = $1", [nouveau.id])).toEqual([{ ownership: "ambiguous" }]);
    await expect(db.as(sofia, "select public.admin_set_post_owner($1, $2)", [[nouveau.id], nordwind])).rejects.toThrow("forbidden");
    expect((await db.as<{ n: number }>(admin, "select public.admin_set_post_owner($1, $2) as n", [[nouveau.id], nordwind]))[0].n).toBe(1);
    expect(await visiblePosts(sofia)).toEqual(["nouveau-1"]);
    await db.decide(sofia, "nouveau-1", "approved");
    expect(await count(sofia, "approval_decisions")).toBe(1);

    // Retour à l'ancien client : c'est de nouveau un transfert, et il ne voit pas ce qu'a fait le suivant.
    await expect(assign(admin, "canal-colibri", colibri)).rejects.toThrow("transfer_confirmation_required");
    await assign(admin, "canal-colibri", colibri, true);
    expect(await visiblePosts(ines)).toEqual([]);
    expect(await count(ines, "approval_decisions")).toBe(0);
  });

  it("un transfert suspend validation et programmation des publications du client précédent", async () => {
    db = await LocalDb.create();
    const { admin, ines, nordwind } = await db.seed();
    await db.sync([{ id: "p" }]);
    await db.decide(ines, "p", "approved");
    const before = await db.post("p");
    await assign(admin, "canal-colibri", nordwind, true);
    const after = await db.post("p");
    // Le contenu n'est pas touché, mais la validation de l'ancien client n'est plus exploitable.
    expect(after).toMatchObject({ content_hash: before.content_hash, version: before.version, approval_status: "none", approved_hash: null, approved_organization_id: null });
    expect(await db.automation("claim_posts_for_scheduling_in_mode", { p_mode: "real", p_post_id: before.id })).toEqual([]);
    // La synchronisation suivante ne remet ni le canal ni la validation chez l'ancien client.
    await db.sync([{ id: "p" }]);
    expect(await db.sql("select o.slug from public.channels c join public.organizations o on o.id = c.organization_id where c.buffer_channel_id = 'canal-colibri'")).toEqual([{ slug: "nordwind" }]);
    expect(await db.post("p")).toMatchObject({ approval_status: "none" });
  });
});

describe("membres", () => {
  it("associer puis dissocier un utilisateur donne puis retire réellement l'accès", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, nordwind } = await db.seed();
    await db.sync([{ id: "n1", channelId: "canal-nordwind" }]);
    expect(await visiblePosts(ines)).toEqual([]);

    await db.as(admin, "select public.admin_set_member($1, $2, true)", [nordwind, ines.userId]);
    await db.as(admin, "select public.admin_set_member($1, $2, true)", [nordwind, ines.userId]);
    expect(await visiblePosts(ines)).toEqual(["n1"]);

    await db.as(admin, "select public.admin_set_member($1, $2, false)", [nordwind, ines.userId]);
    expect(await visiblePosts(ines)).toEqual([]);
    await expect(db.decide(ines, "n1", "approved")).rejects.toThrow("not_found");
    expect(await visiblePosts(sofia)).toEqual(["n1"]);
    await expect(db.as(admin, "select public.admin_set_member($1, $2, true)", [nordwind, admin.userId])).rejects.toThrow("not_a_client");
  });

  it("donne accès à un compte existant retrouvé par son e-mail", async () => {
    db = await LocalDb.create();
    const { admin, colibri, nordwind } = await db.seed();
    await db.sync([{ id: "c1" }]);
    await expect(db.as(admin, "select public.admin_add_user($1, 'inconnu@test.example', 'Inconnu')", [colibri])).rejects.toThrow("user_not_found");
    await expect(db.as(admin, "select public.admin_add_user($1, 'admin@test.example', 'Admin')", [colibri])).rejects.toThrow("not_a_client");

    const [{ id }] = await db.sql<{ id: string }>("insert into auth.users (email) values ('Lea@Test.example') returning id");
    await expect(db.as(admin, "select public.admin_add_user($1, 'lea@test.example', '  ')", [colibri])).rejects.toThrow("invalid_name");
    await db.as(admin, "select public.admin_add_user($1, ' lea@test.example ', 'Léa Roux', 'Direction')", [colibri]);
    expect(await db.sql("select full_name, job_title, role from public.profiles where id = $1", [id])).toEqual([{ full_name: "Léa Roux", job_title: "Direction", role: "client" }]);
    expect(await visiblePosts({ userId: id })).toEqual(["c1"]);

    // Compte déjà connu : son profil n'est pas écrasé, il gagne seulement l'accès au second client.
    await db.as(admin, "select public.admin_add_user($1, 'lea@test.example', 'Autre nom')", [nordwind]);
    expect(await db.sql("select full_name from public.profiles where id = $1", [id])).toEqual([{ full_name: "Léa Roux" }]);
    expect(await count({ userId: id }, "organizations")).toBe(2);
  });
});

describe("retour arrière de 0005", () => {
  it("remet les règles d'avant sans supprimer de données, et 0005 peut être rejouée", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia, nordwind } = await db.seed();
    await db.sync([{ id: "c1" }, { id: "n1", channelId: "canal-nordwind" }]);
    await db.decide(ines, "c1", "changes_requested", "À revoir");
    const rows = await db.sql("select (select count(*) from public.posts)::int as posts, (select count(*) from public.comments)::int as comments, (select count(*) from public.organization_members)::int as members");

    await db.exec(readFileSync(resolve(process.cwd(), "supabase/outils/0005_retour_arriere.sql"), "utf8"));
    expect(await db.sql("select (select count(*) from public.posts)::int as posts, (select count(*) from public.comments)::int as comments, (select count(*) from public.organization_members)::int as members")).toEqual(rows);
    expect(await visiblePosts(ines)).toEqual(["c1"]);
    expect(await visiblePosts(sofia)).toEqual(["n1"]);
    await expect(db.as(admin, "select public.admin_assign_channel($1, $2, true)", [await channelId("canal-libre"), nordwind])).rejects.toThrow(/does not exist/);
    // L'ancien rattachement direct, réservé à l'admin, fonctionne de nouveau.
    await db.as(admin, "update public.channels set organization_id = $1 where buffer_channel_id = 'canal-libre'", [nordwind]);
    await expect(db.as(ines, "update public.channels set organization_id = null")).resolves.toEqual([]);
    expect(await db.sql("select count(*)::int as n from public.channels where organization_id is null")).toEqual([{ n: 0 }]);
    await db.sync([{ id: "c1", text: "Corrigé" }]);
    await db.decide(ines, "c1", "approved");

    await db.migrate("0005_gestion_clients.sql");
    expect(await assign(admin, "canal-libre", null)).toMatchObject({ transferred: false, hidden_posts: 0 });
  });
});
