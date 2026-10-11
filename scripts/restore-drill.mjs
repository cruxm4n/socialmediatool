#!/usr/bin/env node
// Répétition de restauration COMPLÈTE d'une sauvegarde Cadence, dans une pile Supabase ISOLÉE et jetable :
// base, service Auth, API REST, Storage, avec des données et des fichiers rechargés depuis la sauvegarde.
//
//   1. une pile neuve (base + Auth + Storage + API) démarre dans son propre réseau Docker, ports en 127.0.0.1 seulement ;
//   2. la sauvegarde y est restaurée (scripts/lib/restore.mjs) et ses droits sont comparés à la source ;
//   3. les médias sont renvoyés dans le Storage NEUF par son API ;
//   4. on se connecte réellement (Auth), on lit une publication autorisée, on tente celle d'un autre client,
//      on télécharge un média autorisé, on tente un média non autorisé.
//
// Ce script ne modifie AUCUN service existant : la pile d'origine (conteneurs supabase_*_<modèle>) n'est lue que
// par `docker inspect` (image, variables, commande) pour copier sa configuration. Il n'écrit ni dans sa base ni dans
// son stockage, ne touche à aucun volume existant, et ne supprime à la fin que ce qu'il a créé (étiquette cadence.drill).
// Aucun secret n'est affiché ni écrit dans le dépôt.
//
// Usage :
//   DRILL_ADMIN_EMAIL=… DRILL_ADMIN_PASSWORD=… DRILL_CLIENT_A_EMAIL=… DRILL_CLIENT_A_PASSWORD=… \
//   DRILL_CLIENT_B_EMAIL=… DRILL_CLIENT_B_PASSWORD=… \
//     node scripts/restore-drill.mjs --backup <dossier> [--template-prefix cadence-test-<horodatage> | --template cadence-supabase-test] [--keep]
//   Les identifiants sont ceux de la SOURCE (synthétiques) : jamais réinitialisés, jamais affichés.
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ACL_SNAPSHOT_SQL, diffSnapshots, parseSnapshot, snapshotFromJson } from "./lib/acl-snapshot.mjs";
import { postgresIn, readManifest, restoreBackup, verifyRestoredCredentials } from "./lib/restore.mjs";
import { docker, IsolatedStack } from "./lib/stack.mjs";

// Garde la boucle d'événements vivante : les délais de fetch (AbortSignal.timeout) ne la retiennent pas, et un
// processus lancé avec une entrée standard ouverte sortait en silence (code 13) pendant l'attente d'un service.
// Les scripts se terminent toujours par process.exit.
setInterval(() => {}, 1000);

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const backup = option("backup") ? resolve(option("backup")) : null;
const template = option("template", "cadence-supabase-test");
// Préfixe des conteneurs d'une pile isolée à utiliser comme modèle (ex. cadence-test-1791…) : aucune pile CLI lue.
const templatePrefix = option("template-prefix", null);
const keep = args.includes("--keep");
if (!backup) {
  console.error("Usage : node scripts/restore-drill.mjs --backup DOSSIER [--template-prefix cadence-test-<horodatage> | --template cadence-supabase-test] [--keep] [--reset-passwords]");
  process.exit(2);
}

const manifest = readManifest(backup);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${name}${detail ? ` — ${detail}` : ""}`);
};

let stack;
try {
  stack = new IsolatedStack({ template, templatePrefix, name: "drill" });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
/** Idempotent, synchrone : appelé en fin normale, en cas d'erreur, et à la sortie du processus (quel que soit le code). */
function cleanup() {
  if (stack.cleaned) return;
  if (keep) {
    stack.cleaned = true;
    console.log(`Pile conservée (--keep) : conteneurs ${stack.prefix}-*, réseau ${stack.network}. Retrait : docker rm -f -v $(docker ps -aq --filter label=${stack.label}) ; docker network rm ${stack.network}`);
    return;
  }
  stack.cleanup();
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

let exitCode = 1;
try {
  console.log(`Répétition de restauration : ${stack.prefix}`);
  console.log(`  sauvegarde : ${backup} (${manifest.rowCounts?.["public.posts"] ?? "?"} publication(s), ${manifest.storage.length} fichier(s))`);

  console.log("1. démarrage de la pile neuve…");
  // Auth et Storage migrent leurs propres schémas à leur premier démarrage : on leur laisse le faire avant de
  // restaurer les données (même situation qu'un projet Supabase neuf).
  await stack.upBase();
  const pg = postgresIn(stack.dbName, "supabase_admin");

  console.log("2. restauration de la base…");
  docker(["stop", stack.authName, stack.storageName]);
  const restored = restoreBackup({ pg, container: stack.dbName, database: "postgres", backup });
  check("restauration sans erreur grave", restored.problems.length === 0, restored.problems.slice(0, 3).join(" | "));

  if (manifest.acl) {
    const source = snapshotFromJson(JSON.parse(readFileSync(join(backup, manifest.acl.file), "utf8")));
    const actual = parseSnapshot(pg.psql("postgres", ACL_SNAPSHOT_SQL));
    const differences = diffSnapshots(source, actual);
    check(`droits, politiques RLS et fonctions identiques à la source (${source.size} entrées)`, differences.length === 0, differences.slice(0, 4).join(" | "));
  } else {
    check("empreinte des droits présente dans la sauvegarde", false, "refaites la sauvegarde avec scripts/backup.mjs actuel");
  }
  for (const [table, expected] of Object.entries(manifest.rowCounts)) {
    if (expected === null) continue;
    const actual = Number(pg.psql("postgres", `select count(*) from ${table};`));
    check(`lignes restaurées : ${table}`, actual === expected, `attendu ${expected}, obtenu ${actual}`);
  }

  for (const [table, expected] of Object.entries(manifest.rowDigests ?? {})) {
    if (expected === null) continue;
    const actual = pg.psql("postgres", `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from ${table} t;`);
    check(`contenu restauré à l'identique : ${table}`, actual === expected);
  }
  const credentials = verifyRestoredCredentials(pg, "postgres");
  if (credentials.applicable && credentials.total > 0) {
    if (!credentials.keyProvided) console.log(`NON VÉRIFIÉ  ${credentials.total} clé(s) Buffer chiffrée(s) restaurée(s) : clé maître non fournie (CADENCE_CREDENTIALS_KEY), déchiffrement non contrôlé.`);
    else check(`clés Buffer restaurées déchiffrables avec la clé maître fournie (${credentials.total})`, credentials.unreadable.length === 0, `illisibles : ${credentials.unreadable.join(", ")}`);
  }
  const restoredMigrations = pg.psql("postgres", "select version from supabase_migrations.schema_migrations order by version;").split("\n").filter(Boolean);
  check("historique des migrations restauré à l'identique", JSON.stringify(restoredMigrations) === JSON.stringify(manifest.migrations));

  // Montée après restauration (option --then-migrate) : une sauvegarde d'un niveau ancien (0009) est restaurée telle
  // quelle (c'est son niveau), puis les migrations manquantes sont appliquées dans l'ordre, sans perte.
  if (args.includes("--then-migrate")) {
    const last = manifest.migrations.at(-1);
    const missing = readdirSync(resolve("supabase/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) > last).sort();
    console.log(`  montée après restauration : ${missing.length ? missing.join(", ") : "aucune migration manquante"} (niveau de la sauvegarde : ${last})`);
    const before = Number(pg.psql("postgres", "select count(*) from public.posts;"));
    for (const file of missing) {
      try {
        pg.psql("postgres", readFileSync(resolve("supabase/migrations", file), "utf8"));
        pg.psql("postgres", `insert into supabase_migrations.schema_migrations (version, name) values ('${file.slice(0, 4)}', '${file.slice(5)}') on conflict do nothing;`);
        check(`migration ${file} appliquée sur la base restaurée`, true);
      } catch (error) {
        check(`migration ${file} appliquée sur la base restaurée`, false, String(error.stderr ?? error.message).split("\n").find((line) => /ERROR/.test(line)) ?? "");
      }
    }
    check("publications conservées par la montée", Number(pg.psql("postgres", "select count(*) from public.posts;")) === before, `${before}`);
    if (missing.length > 0) {
      const objects = pg.psql("postgres", "select (to_regclass('public.studio_push_events') is not null)::text || ',' || (to_regprocedure('public.begin_urgent_run(text, text, integer)') is not null)::text || ',' || (to_regprocedure('public.schema_status(text)') is not null)::text;");
      check("objets de la dernière migration présents après la montée", objects === "true,true,true", objects);
    }
  }

  docker(["start", stack.authName, stack.storageName]);
  await stack.waitAuthStorage();
  await stack.startRest();

  const serviceToken = stack.serviceToken;
  const anonToken = stack.anonToken;
  const authUrl = `http://127.0.0.1:${stack.ports.auth}`;
  const restUrl = `http://127.0.0.1:${stack.ports.rest}`;
  const storageUrl = `http://127.0.0.1:${stack.ports.storage}`;

  // 3. Stockage : les fichiers sont renvoyés dans le Storage neuf par son API (la base ne contient que leurs métadonnées).
  console.log("3. médias dans le Storage neuf…");
  const mimeOf = new Map(
    pg.psql("postgres", "select bucket_id || '/' || name, coalesce(metadata ->> 'mimetype', 'application/octet-stream') from storage.objects;")
      .split("\n").filter(Boolean).map((line) => line.split("|")),
  );
  let uploaded = 0;
  for (const file of manifest.storage) {
    const bytes = readFileSync(join(backup, "storage", file.bucket, file.name));
    const target = `${storageUrl}/object/${encodeURIComponent(file.bucket)}/${file.name.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(target, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": mimeOf.get(`${file.bucket}/${file.name}`) ?? "application/octet-stream", "x-upsert": "true" },
      body: bytes,
    });
    if (response.ok) uploaded += 1;
    else console.log(`  envoi refusé (${file.bucket}/${file.name}) : HTTP ${response.status} ${await response.text()}`);
  }
  check(`médias envoyés dans le Storage neuf (${manifest.storage.length})`, uploaded === manifest.storage.length, `${uploaded} envoyé(s)`);

  // 4. Connexions RÉELLES par mot de passe, avec les identifiants d'origine de la source (jamais réinitialisés : un
  //    mot de passe qui ne passe plus trahit une restauration Auth défectueuse, pas un détail à masquer).
  //    Variables d'environnement : DRILL_ADMIN_EMAIL/PASSWORD, DRILL_CLIENT_A_EMAIL/PASSWORD, DRILL_CLIENT_B_EMAIL/PASSWORD.
  console.log("4. connexions et lectures réelles (administrateur, deux clients, anonyme)…");
  const env = process.env;
  const accounts = {
    admin: { email: env.DRILL_ADMIN_EMAIL, password: env.DRILL_ADMIN_PASSWORD },
    a: { email: env.DRILL_CLIENT_A_EMAIL, password: env.DRILL_CLIENT_A_PASSWORD },
    b: { email: env.DRILL_CLIENT_B_EMAIL, password: env.DRILL_CLIENT_B_PASSWORD },
  };
  const complete = Object.values(accounts).every((item) => item.email && item.password);
  const resetPasswords = args.includes("--reset-passwords");
  const signIn = async (email, password) => {
    const response = await fetch(`${authUrl}/token?grant_type=password`, { method: "POST", headers: { apikey: anonToken, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    return response.ok ? (await response.json()).access_token : null;
  };
  const userIdOf = (email) => pg.psql("postgres", `select id from auth.users where email = '${email.replace(/'/g, "''")}';`);
  const get = async (path, token, extra = {}) => {
    const response = await fetch(`${restUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, apikey: anonToken, ...extra } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  let tokens = { admin: null, a: null, b: null };

  if (!complete && !resetPasswords) {
    check("identifiants de connexion des comptes de la source fournis (DRILL_*)", false, "sans eux, Auth n'est pas éprouvé ; --reset-passwords (non probant pour Auth) existe pour un essai dégradé");
  } else {
    if (!complete) {
      // Mode dégradé explicite : trois comptes de la sauvegarde reçoivent un mot de passe de test. NON PROBANT pour Auth.
      const rows = pg.psql("postgres", `
        select (select u.id || '|' || u.email from auth.users u join public.profiles p on p.id = u.id where p.role = 'admin' and u.email is not null order by u.created_at limit 1)
        union all
        select u.id || '|' || u.email from (
          select distinct on (m.organization_id) m.user_id from public.organization_members m join public.profiles pr on pr.id = m.user_id and pr.role = 'client' order by m.organization_id, m.user_id
        ) x join auth.users u on u.id = x.user_id and u.email is not null limit 2;`).split("\n").filter(Boolean);
      const password = `Drill-${randomBytes(12).toString("hex")}`;
      const keys = ["admin", "a", "b"];
      for (const [index, row] of rows.entries()) {
        const [id, email] = row.split("|");
        await fetch(`${authUrl}/admin/users/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ password, email_confirm: true }) });
        accounts[keys[index]] = { email, password };
      }
      console.log("AVERTISSEMENT  mots de passe réinitialisés dans la copie : la connexion ci-dessous ne prouve PAS la restauration des empreintes de mot de passe d'Auth.");
    }
    for (const key of ["admin", "a", "b"]) {
      const { email, password } = accounts[key];
      if (!email) {
        check(`un compte « ${key} » existe dans la sauvegarde`, false);
        continue;
      }
      tokens[key] = await signIn(email, password);
      check(`connexion par mot de passe : ${key === "admin" ? "administrateur" : `client ${key.toUpperCase()}`} (service Auth restauré${complete ? ", mot de passe d'origine" : ", mot de passe réinitialisé"})`, !!tokens[key]);
    }

    // Publications : une du client, une d'un autre client ; nombre exact de ses publications visibles.
    const idOfPost = (userId, own) =>
      pg.psql("postgres", `
        select p.id from public.posts p
        where p.ownership = 'assigned' and p.approval_status <> 'none' and p.removed_at is null
          and ${own ? "" : "not"} (p.owner_organization_id in (select organization_id from public.organization_members where user_id = '${userId}'))
        order by p.created_at limit 1;`);
    const visibleCount = (userId) =>
      Number(pg.psql("postgres", `select count(*) from public.posts p where p.approval_status <> 'none' and p.removed_at is null and p.ownership = 'assigned' and p.owner_organization_id in (select organization_id from public.organization_members where user_id = '${userId}');`));
    const posts = {};
    for (const key of ["a", "b"]) {
      if (!tokens[key]) continue;
      const userId = userIdOf(accounts[key].email);
      const own = idOfPost(userId, true);
      const other = idOfPost(userId, false);
      posts[key] = { own, other };
      if (!own || !other) {
        check(`client ${key.toUpperCase()} : une publication à lui et une d'un autre client existent pour l'essai`, false);
        continue;
      }
      const mine = await get(`/posts?select=id&id=eq.${own}`, tokens[key]);
      check(`client ${key.toUpperCase()} lit une de ses publications par l'API`, mine.status === 200 && mine.body?.length === 1, `HTTP ${mine.status}`);
      const foreign = await get(`/posts?select=id&id=eq.${other}`, tokens[key]);
      check(`client ${key.toUpperCase()} ne lit pas la publication d'un autre client`, foreign.status === 200 && foreign.body?.length === 0, `HTTP ${foreign.status}`);
      const all = await get("/posts?select=id", tokens[key], { Prefer: "count=exact" });
      check(`client ${key.toUpperCase()} : exactement ses publications visibles (${visibleCount(userId)})`, all.status === 200 && all.body?.length === visibleCount(userId), `${all.body?.length ?? "?"} lue(s)`);
      const write = await fetch(`${restUrl}/posts?id=eq.${other}`, { method: "PATCH", headers: { Authorization: `Bearer ${tokens[key]}`, apikey: anonToken, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ text: "ÉCRITURE-NON-AUTORISÉE" }) });
      const wrote = await write.json().catch(() => null);
      check(`client ${key.toUpperCase()} n'écrit pas dans la publication d'un autre client`, !write.ok || (Array.isArray(wrote) && wrote.length === 0), `HTTP ${write.status}`);
      const decision = await fetch(`${restUrl}/rpc/decide_post`, { method: "POST", headers: { Authorization: `Bearer ${tokens[key]}`, apikey: anonToken, "Content-Type": "application/json" }, body: JSON.stringify({ p_post_id: other, p_decision: "approved", p_expected_hash: "x", p_comment: null }) });
      check(`client ${key.toUpperCase()} ne décide pas pour un autre client`, !decision.ok, `HTTP ${decision.status}`);
      const admin = await fetch(`${restUrl}/rpc/admin_set_post_owner`, { method: "POST", headers: { Authorization: `Bearer ${tokens[key]}`, apikey: anonToken, "Content-Type": "application/json" }, body: JSON.stringify({ p_post_ids: [], p_organization_id: "00000000-0000-0000-0000-000000000000" }) });
      check(`une fonction d'administration est refusée au client ${key.toUpperCase()}`, !admin.ok, `HTTP ${admin.status}`);
      for (const table of ["studio_drafts", "channel_owner_history", "sync_state", "media_assets"]) {
        const probe = await get(`/${table}?select=*&limit=1`, tokens[key]);
        check(`client ${key.toUpperCase()} ne lit rien de « ${table} »`, (probe.status === 200 && probe.body?.length === 0) || probe.status === 401 || probe.status === 403, `HTTP ${probe.status}`);
      }
    }
    if (tokens.admin) {
      const all = await get("/posts?select=id", tokens.admin);
      const total = Number(pg.psql("postgres", "select count(*) from public.posts;"));
      check("l'administrateur lit toutes les publications par l'API", all.status === 200 && all.body?.length === total, `${all.body?.length ?? "?"}/${total}`);
      const rpc = await fetch(`${restUrl}/rpc/admin_set_post_owner`, { method: "POST", headers: { Authorization: `Bearer ${tokens.admin}`, apikey: anonToken, "Content-Type": "application/json" }, body: JSON.stringify({ p_post_ids: [], p_organization_id: "00000000-0000-0000-0000-000000000000" }) });
      check("l'administrateur appelle une fonction d'administration (refus applicatif, pas de refus de droit)", rpc.status !== 401 && rpc.status !== 403, `HTTP ${rpc.status}`);
    }
    const anon = await get("/posts?select=id", anonToken);
    check("un visiteur anonyme ne lit aucune publication", anon.status === 401 || anon.status === 403 || (anon.status === 200 && anon.body?.length === 0), `HTTP ${anon.status}`);
  }

  console.log("5. médias : téléchargement et octets…");
  if (manifest.storage.length === 0) {
    check("la sauvegarde contient au moins un média à éprouver", false, "aucun fichier : le Storage n'est pas éprouvé");
  } else {
    const urlOf = (file) => `${storageUrl}/object/authenticated/${encodeURIComponent(file.bucket)}/${file.name.split("/").map(encodeURIComponent).join("/")}`;
    const download = async (file, token) => fetch(urlOf(file), { headers: { Authorization: `Bearer ${token}`, apikey: anonToken } });
    let identical = 0;
    let deniedClients = 0;
    let deniedAnon = 0;
    for (const file of manifest.storage) {
      if (tokens.admin) {
        const response = await download(file, tokens.admin);
        const digest = response.ok ? createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex") : null;
        if (digest === file.sha256) identical += 1;
      }
      let clientsDenied = true;
      for (const key of ["a", "b"]) if (tokens[key] && (await download(file, tokens[key])).ok) clientsDenied = false;
      if (clientsDenied) deniedClients += 1;
      if (!(await download(file, anonToken)).ok) deniedAnon += 1;
    }
    check(`l'administrateur télécharge chaque média octet pour octet (${manifest.storage.length})`, tokens.admin !== null && identical === manifest.storage.length, `${identical} identique(s)`);
    check("aucun client n'obtient un média privé", deniedClients === manifest.storage.length, `${deniedClients}/${manifest.storage.length} refusé(s)`);
    check("un visiteur anonyme n'obtient aucun média privé", deniedAnon === manifest.storage.length, `${deniedAnon}/${manifest.storage.length} refusé(s)`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log("");
  if (failed.length === 0) console.log(`RESTAURATION COMPLÈTE VÉRIFIÉE (${results.length} contrôles : base, droits, Auth, API, Storage).`);
  else console.log(`RESTAURATION NON VALIDÉE : ${failed.length} contrôle(s) en échec sur ${results.length}.`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`Répétition interrompue : ${error.message}`);
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
