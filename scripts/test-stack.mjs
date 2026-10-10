#!/usr/bin/env node
// Pile de test ISOLÉE pour les suites d'intégration (`npm run test:db`) et E2E (`npm run test:e2e`), sans toucher à
// la pile de test existante (conteneurs supabase_*_cadence-supabase-test) : base, Auth, Storage, API et passerelle
// neufs, migrations de supabase/migrations appliquées dans l'ordre, quatre comptes de démonstration.
//
//   node scripts/test-stack.mjs up      crée la pile et écrit <dossier>/env (0600, hors dépôt ; défaut ~/.cadence-test-stack,
//                                       ou CADENCE_STACK_DIR). Tous les secrets de la pile sont GÉNÉRÉS (aucun n'est lu d'ailleurs).
//   node scripts/test-stack.mjs down    supprime ce que `up` a créé (étiquette unique), rien d'autre
//   node scripts/test-stack.mjs status
//
// Puis, dans un shell : set -a; . ~/.cadence-test-stack/env; set +a; npm run test:db; npm run test:e2e
// Les variables TEST_* de l'environnement priment sur .env.test.local (tests/support/env.ts).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { docker, freePort, IsolatedStack, waitFor } from "./lib/stack.mjs";

// Garde la boucle d'événements vivante : les délais de fetch (AbortSignal.timeout) ne la retiennent pas, et un
// processus lancé avec une entrée standard ouverte sortait en silence (code 13) pendant l'attente d'un service.
// Les scripts se terminent toujours par process.exit.
setInterval(() => {}, 1000);

const command = process.argv[2];
// CADENCE_STACK_DIR : contexte distinct (plusieurs piles, ou état existant à ne pas écraser).
const dir = process.env.CADENCE_STACK_DIR ?? join(homedir(), ".cadence-test-stack");
const stateFile = join(dir, "state.json");
const envFile = join(dir, "env");

function down() {
  if (!existsSync(stateFile)) {
    console.log("Aucune pile de test isolée à supprimer.");
    return;
  }
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  if (state.gatewayPid) {
    try {
      process.kill(state.gatewayPid);
    } catch {
      /* déjà arrêtée */
    }
  }
  const stack = Object.assign(Object.create(IsolatedStack.prototype), state.stack, { cleaned: false });
  stack.cleanup();
  rmSync(stateFile, { force: true });
  rmSync(envFile, { force: true });
  console.log(`Pile ${state.stack.prefix} supprimée.`);
}

if (command === "down") {
  down();
  process.exit(0);
}
if (command === "status") {
  console.log(existsSync(stateFile) ? `Pile active : ${JSON.parse(readFileSync(stateFile, "utf8")).stack.prefix}` : "Aucune pile de test isolée.");
  process.exit(0);
}
if (command !== "up") {
  console.error("Usage : node scripts/test-stack.mjs up|down|status");
  process.exit(2);
}
if (existsSync(stateFile)) {
  console.error("Une pile isolée existe déjà : `node scripts/test-stack.mjs down` d'abord.");
  process.exit(2);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
// CADENCE_TEMPLATE_PREFIX : préfixe des conteneurs d'une pile isolée à copier (au lieu des conteneurs de la CLI Supabase).
const stack = new IsolatedStack({ name: "test", templatePrefix: process.env.CADENCE_TEMPLATE_PREFIX ?? null });
let ok = false;
try {
  console.log(`Pile isolée : ${stack.prefix}`);
  await stack.upBase();

  const sql = (query) => docker(["exec", "-i", stack.dbName, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], { input: query });
  // --upto 0009 : s'arrête à un niveau (essai « sauvegarde à 0009 puis montée au schéma final »).
  const upto = process.argv.includes("--upto") ? process.argv[process.argv.indexOf("--upto") + 1] : "9999";
  const migrations = readdirSync(resolve("supabase/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= upto).sort();
  // Historique des migrations, comme le fait la CLI Supabase : sert aux sauvegardes (manifeste) et aux contrôles.
  sql("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);");
  for (const file of migrations) {
    sql(readFileSync(resolve("supabase/migrations", file), "utf8"));
    const [, version, name] = /^(\d{4})_(.+)\.sql$/.exec(file);
    sql(`insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}') on conflict (version) do nothing;`);
    console.log(`  migration ${file} appliquée`);
  }
  await stack.startRest();

  const gatewayPort = await freePort();
  const gateway = spawn(process.execPath, [resolve("scripts/lib/gateway.mjs"), "--listen", String(gatewayPort), "--auth", String(stack.ports.auth), "--rest", String(stack.ports.rest), "--storage", String(stack.ports.storage)], {
    detached: true,
    stdio: "ignore",
  });
  gateway.unref();
  const url = `http://127.0.0.1:${gatewayPort}`;
  await waitFor("la passerelle", async () => (await fetch(`${url}/auth/v1/health`, { signal: AbortSignal.timeout(3000) })).ok);

  const password = () => `Test-${randomBytes(9).toString("base64url")}`;
  const accounts = [
    { key: "ADMIN", email: "alex@cadence.test", name: "Alex Martin", title: "Fondateur", role: "admin", org: null },
    { key: "INES", email: "ines@maison-colibri.example", name: "Inès Faure", title: "Responsable communication", role: "client", org: "maison-colibri" },
    { key: "HUGO", email: "hugo@maison-colibri.example", name: "Hugo Bernard", title: "Gérant", role: "client", org: "maison-colibri" },
    { key: "SOFIA", email: "sofia@nordwind-cycles.example", name: "Sofia Lemaire", title: "Directrice marketing", role: "client", org: "nordwind-cycles" },
  ].map((account) => ({ ...account, password: password() }));
  const automationSecret = randomBytes(30).toString("base64url");

  for (const account of accounts) {
    const response = await fetch(`http://127.0.0.1:${stack.ports.auth}/admin/users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stack.serviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password, email_confirm: true }),
    });
    if (!response.ok) throw new Error(`Création du compte ${account.key} refusée : HTTP ${response.status}`);
  }
  const quote = (value) => value.replace(/'/g, "''");
  sql(`
    insert into public.organizations (slug, name, sector, timezone, initials, color) values
      ('maison-colibri', 'Maison Colibri', 'Torréfacteur · Lyon', 'Europe/Paris', 'MC', '#2f7d5b'),
      ('nordwind-cycles', 'Nordwind Cycles', 'Vélos cargo · Nantes', 'Europe/Paris', 'NC', '#1f4f8f')
    on conflict (slug) do nothing;
    ${accounts.map((a) => `
    insert into public.profiles (id, full_name, job_title, role)
      select id, '${quote(a.name)}', '${quote(a.title)}', '${a.role}' from auth.users where email = '${a.email}'
      on conflict (id) do update set full_name = excluded.full_name, role = excluded.role;
    ${a.org ? `insert into public.organization_members (organization_id, user_id)
      select o.id, u.id from public.organizations o, auth.users u where o.slug = '${a.org}' and u.email = '${a.email}' on conflict do nothing;` : ""}`).join("\n")}
    insert into private.app_secrets (name, secret_hash) values ('automation', encode(extensions.digest('${automationSecret}', 'sha256'), 'hex'))
      on conflict (name) do update set secret_hash = excluded.secret_hash;
    notify pgrst, 'reload schema';
  `);

  const lines = [
    `TEST_SUPABASE_URL=${url}`,
    `TEST_SUPABASE_PUBLISHABLE_KEY=${stack.anonToken}`,
    `TEST_AUTOMATION_SECRET=${automationSecret}`,
    // Conteneur de base de CETTE pile : les tests y préparent des états (vieillissement d'une réservation) par docker exec.
    `TEST_DB_CONTAINER=${stack.dbName}`,
    // Clé de service ÉPHÉMÈRE de cette pile (signée avec le secret JWT généré) : sauvegarde du Storage, répétitions.
    `TEST_SERVICE_ROLE_KEY=${stack.serviceToken}`,
    // Ports de service (boucle locale de l'hôte) : passerelles supplémentaires d'essai (image Docker, proxy HTTPS).
    `TEST_PORT_AUTH=${stack.ports.auth}`, `TEST_PORT_REST=${stack.ports.rest}`, `TEST_PORT_STORAGE=${stack.ports.storage}`,
    ...accounts.flatMap((a) => [`TEST_DEMO_${a.key}_EMAIL=${a.email}`, `TEST_DEMO_${a.key}_PASSWORD=${a.password}`]),
  ];
  // Jeu de données SYNTHÉTIQUE pour les essais de sauvegarde et de restauration (option --fixture) : deux clients avec
  // des publications soumises, une décision, une demande de modification avec commentaire, un média par client.
  if (process.argv.includes("--fixture")) {
    const call = async (path, init) => {
      const response = await fetch(`${url}${path}`, init);
      if (!response.ok) throw new Error(`${path} : HTTP ${response.status} ${await response.text()}`);
      return response.status === 204 ? null : response.json().catch(() => null);
    };
    const anon = { apikey: stack.anonToken, "Content-Type": "application/json" };
    const rpc = (name, body, token) => call(`/rest/v1/rpc/${name}`, { method: "POST", headers: { ...anon, Authorization: `Bearer ${token ?? stack.anonToken}` }, body: JSON.stringify(body) });
    const channelsPayload = [
      { id: "mock-ch-fixture-colibri", service: "linkedin", name: "Fixture Colibri", organizationSlug: "maison-colibri" },
      { id: "mock-ch-fixture-nordwind", service: "instagram", name: "Fixture Nordwind", organizationSlug: "nordwind-cycles" },
    ];
    const post = (id, channel, text) => ({ id, channelId: channel, service: channel.includes("colibri") ? "linkedin" : "instagram", status: "draft", text, dueAt: "2031-05-12T09:00:00.000Z", hasReviewTag: true, assets: [] });
    await rpc("sync_buffer_posts", {
      p_secret: automationSecret,
      p_payload: {
        mode: "mock", triggeredBy: "fixture", complete: false, channels: channelsPayload,
        posts: [
          post("mock-fixture-colibri-1", "mock-ch-fixture-colibri", "Fixture Colibri : nouvelle récolte"),
          post("mock-fixture-colibri-2", "mock-ch-fixture-colibri", "Fixture Colibri : atelier dégustation"),
          post("mock-fixture-nordwind-1", "mock-ch-fixture-nordwind", "Fixture Nordwind : vélo cargo"),
          post("mock-fixture-nordwind-2", "mock-ch-fixture-nordwind", "Fixture Nordwind : sortie du dimanche"),
        ],
      },
    });
    const login = async (account) => {
      const body = await call("/auth/v1/token?grant_type=password", { method: "POST", headers: anon, body: JSON.stringify({ email: account.email, password: account.password }) });
      return body.access_token;
    };
    const byKey = Object.fromEntries(accounts.map((account) => [account.key, account]));
    const rows = async (token) => call("/rest/v1/posts?select=id,buffer_post_id,content_hash&buffer_post_id=like.mock-fixture-*", { headers: { ...anon, Authorization: `Bearer ${token}` } });
    const inesToken = await login(byKey.INES);
    const sofiaToken = await login(byKey.SOFIA);
    for (const [token, prefix] of [[inesToken, "colibri"], [sofiaToken, "nordwind"]]) {
      const own = (await rows(token)).filter((row) => row.buffer_post_id.includes(prefix));
      await rpc("decide_post", { p_post_id: own[0].id, p_decision: "approved", p_expected_hash: own[0].content_hash, p_comment: null }, token);
      await rpc("decide_post", { p_post_id: own[1].id, p_decision: "changes_requested", p_expected_hash: own[1].content_hash, p_comment: `Merci de revoir le texte (${prefix}).` }, token);
    }
    // Un média par client, déposé par l'administrateur (Storage réel) : octets reconnaissables, empreinte au manifeste.
    const orgs = await call("/rest/v1/organizations?select=id,slug", { headers: { ...anon, Authorization: `Bearer ${stack.serviceToken}` } });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    for (const org of orgs) {
      const target = `${url}/storage/v1/object/media/${org.id}/fixture-${org.slug}.png`;
      const response = await fetch(target, { method: "POST", headers: { Authorization: `Bearer ${stack.serviceToken}`, apikey: stack.anonToken, "Content-Type": "image/png", "x-upsert": "true" }, body: png });
      if (!response.ok) throw new Error(`média de fixture refusé (${org.slug}) : HTTP ${response.status}`);
    }
    // Enregistrement dans la bibliothèque de médias (administrateur) : les médias apparaissent dans l'application.
    const adminToken = await login(byKey.ADMIN);
    for (const org of orgs) {
      await rpc("studio_register_media", { p_organization_id: org.id, p_path: `${org.id}/fixture-${org.slug}.png`, p_file_name: `fixture-${org.slug}.png`, p_mime_type: "image/png", p_size_bytes: png.length, p_width: 1, p_height: 1 }, adminToken);
    }
    console.log("  jeu de données synthétique posé (2 clients, 4 publications, décisions, 2 médias enregistrés).");
  }

  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(stateFile, JSON.stringify({ gatewayPid: gateway.pid, stack: { prefix: stack.prefix, label: stack.label, network: stack.network, scratch: stack.scratch, containers: stack.containers, template: stack.template, storageImage: stack.storageImage } }), { mode: 0o600 });
  console.log(`Pile prête : ${url} (comptes : ${accounts.map((a) => a.key).join(", ")}).`);
  console.log(`Variables : ${envFile} (0600, hors dépôt). Retrait : node scripts/test-stack.mjs down`);
  ok = true;
} catch (error) {
  console.error(`Création de la pile interrompue : ${error.message}`);
} finally {
  if (!ok) stack.cleanup();
}
process.exit(ok ? 0 : 1);
