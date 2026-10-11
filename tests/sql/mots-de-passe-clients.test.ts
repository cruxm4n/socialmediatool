import { afterEach, describe, expect, it } from "vitest";

import { LocalDb } from "../support/local-db";

/*
 * Migration 0015 — mots de passe chiffrés des comptes clients.
 * La table est dans le schéma privé ; seul le serveur (secret d'automatisation + acteur administrateur) y accède.
 * La base ne voit jamais un mot de passe en clair : elle range un texte chiffré par le serveur.
 */

let db: LocalDb;
afterEach(async () => {
  await db?.close();
});

const CIPHER = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccccccc";
const OTHER = "v1.dddddddddddddddd.eeeeeeeeeeeeeeeeeeeeee.ffffffffffffffffffffffffff";

describe("mots de passe des comptes clients (0015)", () => {
  it("le serveur enregistre, relit et remplace le mot de passe chiffré d'un compte client", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    expect(await db.automation("server_get_user_password", { p_actor: admin.userId, p_user_id: ines.userId })).toEqual([{ server_get_user_password: null }]);
    await db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: ines.userId, p_ciphertext: CIPHER, p_key_version: 1 });
    const [read] = await db.automation<{ server_get_user_password: { ciphertext: string; keyVersion: number } }>("server_get_user_password", { p_actor: admin.userId, p_user_id: ines.userId });
    expect(read.server_get_user_password).toMatchObject({ ciphertext: CIPHER, keyVersion: 1 });

    await db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: ines.userId, p_ciphertext: OTHER, p_key_version: 2 });
    const rows = await db.sql<{ ciphertext: string; key_version: number; updated_by: string }>("select ciphertext, key_version, updated_by from private.user_passwords where user_id = $1", [ines.userId]);
    expect(rows).toEqual([{ ciphertext: OTHER, key_version: 2, updated_by: admin.userId }]);
  });

  it("exige le secret d'automatisation ET un acteur administrateur", async () => {
    db = await LocalDb.create();
    const { admin, ines, sofia } = await db.seed();
    await db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: ines.userId, p_ciphertext: CIPHER });
    for (const name of ["server_set_user_password", "server_get_user_password"] as const) {
      const extra = name === "server_set_user_password" ? { p_ciphertext: CIPHER } : {};
      // Mauvais secret : refusé, même avec un acteur administrateur.
      await expect(db.automation(name, { p_actor: admin.userId, p_user_id: ines.userId, ...extra }, "mauvais-secret")).rejects.toThrow();
      // Bon secret, acteur client, inconnu ou absent : refusé.
      await expect(db.automation(name, { p_actor: sofia.userId, p_user_id: ines.userId, ...extra })).rejects.toThrow("forbidden");
      await expect(db.automation(name, { p_actor: ines.userId, p_user_id: ines.userId, ...extra })).rejects.toThrow("forbidden");
      await expect(db.automation(name, { p_actor: null, p_user_id: ines.userId, ...extra })).rejects.toThrow("forbidden");
    }
  });

  it("le mot de passe d'un administrateur n'est jamais conservé ni rendu ; un compte inconnu est refusé", async () => {
    db = await LocalDb.create();
    const { admin } = await db.seed();
    await expect(db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: admin.userId, p_ciphertext: CIPHER })).rejects.toThrow("not_a_client");
    await expect(db.automation("server_get_user_password", { p_actor: admin.userId, p_user_id: admin.userId })).rejects.toThrow("not_a_client");
    await expect(db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: "11111111-1111-4111-8111-111111111111", p_ciphertext: CIPHER })).rejects.toThrow("user_not_found");
    expect(await db.sql("select 1 from private.user_passwords")).toEqual([]);
  });

  it("refuse tout ce qui ne ressemble pas à un texte chiffré par le serveur : jamais un mot de passe en clair", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    for (const value of ["MotDePasseEnClair2030", "court", ""]) {
      await expect(db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: ines.userId, p_ciphertext: value })).rejects.toThrow();
    }
    expect(await db.sql("select 1 from private.user_passwords")).toEqual([]);
  });

  it("aucun rôle de l'API ne lit ni n'écrit la table : ni anonyme, ni client, ni même une session administrateur", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    await db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: ines.userId, p_ciphertext: CIPHER });
    for (const actor of ["anon", ines, admin] as const) {
      await expect(db.as(actor, "select ciphertext from private.user_passwords")).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "update private.user_passwords set ciphertext = $1", [OTHER])).rejects.toThrow(/permission denied/);
      await expect(db.as(actor, "delete from private.user_passwords")).rejects.toThrow(/permission denied/);
    }
    // Une session administrateur n'a pas le secret : elle ne peut pas appeler les fonctions du serveur à sa place.
    await expect(db.as(admin, "select public.server_get_user_password('', $1, $2)", [admin.userId, ines.userId])).rejects.toThrow();
  });

  it("le compte supprimé emporte son mot de passe ; la préparation au service annonce le niveau 0015", async () => {
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    await db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: ines.userId, p_ciphertext: CIPHER });
    const [{ schema_status: status }] = await db.automation<{ schema_status: { ready: boolean; checks: Record<string, boolean> } }>("schema_status", {});
    expect(status.ready).toBe(true);
    expect(status.checks["0015"]).toBe(true);
    await db.sql("delete from public.organization_members where user_id = $1", [ines.userId]);
    await db.sql("delete from public.profiles where id = $1", [ines.userId]);
    await db.sql("delete from auth.users where id = $1", [ines.userId]);
    expect(await db.sql("select 1 from private.user_passwords")).toEqual([]);
  });

  it("0015 exige 0014 et se rejoue sans erreur ni perte", async () => {
    db = await LocalDb.create("0013");
    await expect(db.migrate("0015_mots_de_passe_clients.sql")).rejects.toThrow(/0014 doit être appliquée/);
    await db.close();
    db = await LocalDb.create();
    const { admin, ines } = await db.seed();
    await db.automation("server_set_user_password", { p_actor: admin.userId, p_user_id: ines.userId, p_ciphertext: CIPHER });
    await db.migrate("0015_mots_de_passe_clients.sql");
    expect(await db.sql("select ciphertext from private.user_passwords")).toEqual([{ ciphertext: CIPHER }]);
  });
});
