import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { diffSnapshots, normalizeAcl, parseSnapshot } from "../../scripts/lib/acl-snapshot.mjs";

/*
 * Outils de contrôle de restauration (règles pures). L'essai complet — Auth, Storage, API — est dans
 * scripts/restore-drill.mjs (voir docs/SAUVEGARDE.md) : il exige Docker.
 */

describe("empreinte des droits", () => {
  it("ignore le grantor et les droits du propriétaire, compare le reste dans un ordre stable", () => {
    expect(normalizeAcl("{postgres=arwdDxtm/postgres,authenticated=r/postgres,anon=r/postgres}", "postgres")).toBe("anon=r,authenticated=r");
    expect(normalizeAcl("{supabase_admin=arwdDxtm/supabase_admin,anon=r/supabase_admin,authenticated=r/supabase_admin}", "supabase_admin")).toBe("anon=r,authenticated=r");
    expect(normalizeAcl("", "postgres")).toBe("");
  });

  it("détecte la perte de droits, de politiques et un droit en trop", () => {
    const source = parseSnapshot([
      "table|public.posts|{postgres=arwdDxtm/postgres,authenticated=r/postgres}|postgres|r:rls",
      "policy|public.posts.posts_select|||abc",
      "function|public.admin_set_post_owner(uuid[], uuid)|{postgres=X/postgres,authenticated=X/postgres}|postgres|definer",
    ].join("\n"));
    // Le défaut constaté par le contre-audit : « permission denied for table posts », exécution publique rétablie.
    const lost = parseSnapshot([
      "table|public.posts||supabase_admin|r:rls",
      "policy|public.posts.posts_select|||abc",
      "function|public.admin_set_post_owner(uuid[], uuid)|{=X/supabase_admin,supabase_admin=X/supabase_admin}|supabase_admin|definer",
    ].join("\n"));
    const problems = diffSnapshots(source, lost);
    expect(problems.join("\n")).toContain("droits différents : table:public.posts");
    expect(problems.join("\n")).toContain("droits différents : function:public.admin_set_post_owner");
  });

  it("une restauration identique (autre propriétaire) ne signale rien", () => {
    const source = parseSnapshot("table|public.posts|{postgres=arwdDxtm/postgres,authenticated=r/postgres}|postgres|r:rls\npolicy|public.posts.p|||h");
    const restored = parseSnapshot("table|public.posts|{supabase_admin=arwdDxtm/supabase_admin,authenticated=r/supabase_admin}|supabase_admin|r:rls\npolicy|public.posts.p|||h");
    expect(diffSnapshots(source, restored)).toEqual([]);
  });

  it("signale une politique absente, une RLS désactivée et un objet en trop", () => {
    const source = parseSnapshot("table|public.posts||postgres|r:rls\npolicy|public.posts.p|||h");
    const restored = parseSnapshot("table|public.posts||postgres|r:norls\ntable|public.autre||postgres|r:rls");
    const text = diffSnapshots(source, restored).join("\n");
    expect(text).toContain("manquant après restauration : policy:public.posts.p");
    expect(text).toContain("réglage différent : table:public.posts");
    expect(text).toContain("en trop après restauration : table:public.autre");
  });
});

describe("sommaire du dump (pg_restore -l)", () => {
  const toc = [
    "16; 2615 16457 SCHEMA - auth supabase_admin",
    "4537; 0 0 ACL - SCHEMA auth supabase_admin",
    "14; 2615 17558 SCHEMA - private postgres",
    "4538; 0 0 ACL - SCHEMA private postgres",
    "4539; 0 0 COMMENT - SCHEMA public pg_database_owner",
    "300; 1259 17600 TABLE public posts postgres",
    "5100; 0 17600 TABLE DATA public posts postgres",
    "5101; 0 16400 TABLE DATA auth users supabase_auth_admin",
    "5102; 0 16401 SEQUENCE SET auth refresh_tokens_id_seq supabase_auth_admin",
    "400; 1259 16402 TABLE auth users supabase_auth_admin",
    "2460; 826 16452 DEFAULT ACL public DEFAULT PRIVILEGES FOR FUNCTIONS postgres",
    "4100; 3256 17700 POLICY storage objects cadence_media_select postgres",
    "4200; 2606 17800 FK CONSTRAINT public posts posts_channel_fk postgres",
  ];

  it("lit le schéma de chaque entrée, y compris les droits et commentaires d'un schéma", async () => {
    const { parseTocLine } = await import("../../scripts/lib/restore.mjs");
    expect(parseTocLine(toc[1])).toMatchObject({ desc: "ACL", schema: "auth" });
    expect(parseTocLine(toc[2])).toMatchObject({ desc: "SCHEMA", schema: "private" });
    expect(parseTocLine(toc[6])).toMatchObject({ desc: "TABLE DATA", schema: "public", name: "posts" });
    expect(parseTocLine(toc[10])).toMatchObject({ desc: "DEFAULT ACL", schema: "public" });
    expect(parseTocLine(toc[12])).toMatchObject({ desc: "FK CONSTRAINT", schema: "public" });
  });

  it("restaure en entier les schémas de Cadence (droits de schéma compris) et seulement les données du schéma plateforme", async () => {
    const { selectTocEntries } = await import("../../scripts/lib/restore.mjs");
    const selection = selectTocEntries(toc, { full: ["public", "private"], dataOnly: ["auth", "storage"] });
    expect(selection.full).toEqual(expect.arrayContaining([toc[2], toc[3], toc[4], toc[5], toc[6], toc[10], toc[12]]));
    expect(selection.full).not.toContain(toc[0]);
    expect(selection.full).not.toContain(toc[1]);
    expect(selection.data).toEqual([toc[7], toc[8]]);
    expect(selection.policies).toEqual([toc[11]]);
  });
});

describe("clés Buffer restaurées : encore déchiffrables ?", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  /** Faux accès à la base restaurée : la table existe et contient ces lignes (identifiant|version|texte chiffré). */
  const database = (rows: string[] | null) => ({ psql: (_database: string, query: string) => (query.includes("to_regclass") ? (rows === null ? "f" : "t") : (rows ?? []).join("\n")) });

  it("déchiffre avec la clé maître FOURNIE (jamais lue dans la sauvegarde), version par version ; une clé absente ou fausse est signalée", async () => {
    const { verifyRestoredCredentials } = await import("../../scripts/lib/restore.mjs");
    const { encryptCredential } = await import("@/server/credentials");
    const [k1, k2] = [randomBytes(32).toString("base64"), randomBytes(32).toString("base64")];
    process.env.CADENCE_CREDENTIALS_KEY = k1;
    const rowA = `${A}|1|${encryptCredential(A, "cle-synthetique-a")}`;
    Object.assign(process.env, { CADENCE_CREDENTIALS_KEY: k2, CADENCE_CREDENTIALS_KEY_VERSION: "2" });
    const rowB = `${B}|2|${encryptCredential(B, "cle-synthetique-b")}`;
    const pg = database([rowA, rowB]);

    // Clé courante + ancienne clé : tout se lit.
    expect(verifyRestoredCredentials(pg, "x", { CADENCE_CREDENTIALS_KEY: k2, CADENCE_CREDENTIALS_KEY_VERSION: "2", CADENCE_CREDENTIALS_PREVIOUS_KEYS: `1:${k1}` })).toMatchObject({ total: 2, readable: 2, unreadable: [], keyProvided: true });
    // Ancienne clé maître perdue : la clé chiffrée avec elle est signalée, par son identifiant de connexion seulement.
    expect(verifyRestoredCredentials(pg, "x", { CADENCE_CREDENTIALS_KEY: k2, CADENCE_CREDENTIALS_KEY_VERSION: "2" })).toMatchObject({ readable: 1, unreadable: [A] });
    // Mauvaise clé maître courante : la clé chiffrée avec elle ne se lit pas ; aucune autre clé n'est essayée à sa place.
    expect(verifyRestoredCredentials(pg, "x", { CADENCE_CREDENTIALS_KEY: randomBytes(32).toString("base64"), CADENCE_CREDENTIALS_KEY_VERSION: "2", CADENCE_CREDENTIALS_PREVIOUS_KEYS: `1:${k1}` })).toMatchObject({ readable: 1, unreadable: [B] });
    // Clé maître non fournie : le contrôle n'est PAS déclaré réussi.
    expect(verifyRestoredCredentials(pg, "x", {})).toMatchObject({ total: 2, readable: 0, keyProvided: false, applicable: true });
    // Un texte chiffré recopié sur une autre connexion ne se déchiffre pas.
    const grafted = database([`${B}|1|${rowA.split("|")[2]}`]);
    expect(verifyRestoredCredentials(grafted, "x", { CADENCE_CREDENTIALS_KEY: k1 })).toMatchObject({ unreadable: [B] });
    // Sauvegarde d'avant la migration 0012 : sans objet.
    expect(verifyRestoredCredentials(database(null), "x", { CADENCE_CREDENTIALS_KEY: k1 })).toMatchObject({ applicable: false, total: 0 });
  });

  it("une sauvegarde au niveau 0012 ou plus doit contenir les trois tables de connexions", async () => {
    const { REQUIRED_SINCE } = await import("../../scripts/lib/restore.mjs");
    expect(REQUIRED_SINCE).toMatchObject({ "public.provider_connections": "0012", "private.provider_credentials": "0012", "public.provider_connection_events": "0012" });
  });
});
