#!/usr/bin/env node
// Prépare une base Supabase de TEST LOCALE : comptes de démonstration, clients fictifs, secret d'automatisation.
// Écrit .env.test.local (ignoré par Git) avec les variables TEST_* attendues par `npm run test:db` et `npm run test:e2e`.
//
// Garde-fous : refuse toute adresse autre que la boucle locale ; n'ouvre jamais .env.local ;
// ne lit ni n'écrit aucun secret de production.
//
// Usage (pile lancée par `supabase start`, voir docs/BASE_DE_TEST.md) :
//   node scripts/setup-test-db.mjs
// Variables facultatives : TEST_DB_CONTAINER (conteneur Postgres), TEST_API_URL.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const CONTAINER = process.env.TEST_DB_CONTAINER ?? "supabase_db_cadence-supabase-test";
const WORKDIR = process.env.TEST_SUPABASE_WORKDIR ?? `${process.env.HOME}/cadence-supabase-test`;
const OUT = ".env.test.local";

function status() {
  const raw = execFileSync("npx", ["-y", "supabase@latest", "status", "-o", "env"], { cwd: WORKDIR, encoding: "utf8" });
  return Object.fromEntries(raw.split("\n").map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

const info = status();
const url = process.env.TEST_API_URL ?? info.API_URL;
const anon = info.ANON_KEY ?? info.PUBLISHABLE_KEY;
const service = info.SERVICE_ROLE_KEY ?? info.SECRET_KEY;
if (!url || !anon || !service) throw new Error("Pile Supabase locale introuvable : lancez d'abord `supabase start`.");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error(`Refusé : ${url} n'est pas une base locale.`);

const sql = (query) => execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], { input: query, encoding: "utf8" });

const password = () => `Test-${randomBytes(9).toString("base64url")}`;
const accounts = [
  { key: "ADMIN", email: "alex@cadence.test", name: "Alex Martin", title: "Fondateur", role: "admin", org: null },
  { key: "INES", email: "ines@maison-colibri.example", name: "Inès Faure", title: "Responsable communication", role: "client", org: "maison-colibri" },
  { key: "HUGO", email: "hugo@maison-colibri.example", name: "Hugo Bernard", title: "Gérant", role: "client", org: "maison-colibri" },
  { key: "SOFIA", email: "sofia@nordwind-cycles.example", name: "Sofia Lemaire", title: "Directrice marketing", role: "client", org: "nordwind-cycles" },
].map((account) => ({ ...account, password: password() }));
const automationSecret = randomBytes(30).toString("base64url");

const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
for (const account of accounts) {
  const { data, error } = await admin.auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true });
  if (error && !/already|registered/i.test(error.message)) throw error;
  if (error) {
    // Compte déjà créé par un lancement précédent : on remet un mot de passe connu.
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
    const existing = list.users.find((user) => user.email === account.email);
    await admin.auth.admin.updateUserById(existing.id, { password: account.password });
  }
  void data;
}

sql(`
  insert into public.organizations (slug, name, sector, timezone, initials, color) values
    ('maison-colibri', 'Maison Colibri', 'Torréfacteur · Lyon', 'Europe/Paris', 'MC', '#2f7d5b'),
    ('nordwind-cycles', 'Nordwind Cycles', 'Vélos cargo · Nantes', 'Europe/Paris', 'NC', '#1f4f8f')
  on conflict (slug) do nothing;
  ${accounts
    .map(
      (a) => `
  insert into public.profiles (id, full_name, job_title, role)
    select id, '${a.name.replace(/'/g, "''")}', '${a.title.replace(/'/g, "''")}', '${a.role}' from auth.users where email = '${a.email}'
    on conflict (id) do update set full_name = excluded.full_name, role = excluded.role;
  ${a.org ? `insert into public.organization_members (organization_id, user_id)
    select o.id, u.id from public.organizations o, auth.users u where o.slug = '${a.org}' and u.email = '${a.email}' on conflict do nothing;` : ""}`,
    )
    .join("\n")}
  insert into private.app_secrets (name, secret_hash) values ('automation', encode(extensions.digest('${automationSecret}', 'sha256'), 'hex'))
    on conflict (name) do update set secret_hash = excluded.secret_hash;
`);

const lines = [
  "# Généré par scripts/setup-test-db.mjs — base de TEST LOCALE uniquement. Ne jamais y mettre de secret de production.",
  `TEST_SUPABASE_URL=${url}`,
  `TEST_SUPABASE_PUBLISHABLE_KEY=${anon}`,
  `TEST_AUTOMATION_SECRET=${automationSecret}`,
  ...accounts.flatMap((a) => [`TEST_DEMO_${a.key}_EMAIL=${a.email}`, `TEST_DEMO_${a.key}_PASSWORD=${a.password}`]),
];
if (existsSync(OUT)) console.log(`${OUT} remplacé.`);
writeFileSync(OUT, `${lines.join("\n")}\n`, { mode: 0o600 });
console.log(`Base de test prête : ${url}\nComptes : ${accounts.map((a) => a.key).join(", ")}. Variables écrites dans ${OUT}.`);
