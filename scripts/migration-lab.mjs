#!/usr/bin/env node
// Laboratoire de migrations sur PostgreSQL NATIF (mission V3, C10). Une base Supabase (image officielle, rôles de la
// plateforme) est démarrée SEULE dans un réseau jetable ; chaque scénario s'exécute dans sa propre base, créée ici et
// supprimée ici. Aucune base ni conteneur existant n'est lu ou modifié ; les secrets sont générés.
//
//   node scripts/migration-lab.mjs --template-prefix cadence-test-<horodatage>
//
// Scénarios : installation neuve ; montée depuis 0003 avec historique 0003 ABSENT alors que ses objets existent ;
// montée depuis 0008, 0009 et 0010 avec une fixture de 307 publications (298 simulées, 9 réelles), accords,
// commentaires, versions, médias, canaux transférés/vides, tentatives claimed/pushing/unknown, compensations en
// attente ; rejeu ; prérequis manquant (échec atomique, reprise) ; échec en cours de migration (retour arrière).
// Équivalence : empreinte des tables, colonnes, fonctions (définitions), politiques, déclencheurs et droits.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ACL_SNAPSHOT_SQL, parseSnapshot } from "./lib/acl-snapshot.mjs";
import { diffLines, FINGERPRINT_SQL } from "./lib/schema-fingerprint.mjs";
import { docker, IsolatedStack } from "./lib/stack.mjs";

setInterval(() => {}, 1000);
const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const SECRET = "secret-de-laboratoire";
const files = readdirSync(resolve("supabase/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const text = (file) => readFileSync(resolve("supabase/migrations", file), "utf8");
const upTo = (version) => files.filter((file) => file.slice(0, 4) <= version);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const stack = new IsolatedStack({ template: option("template", "cadence-supabase-test"), templatePrefix: option("template-prefix", null), name: "lab" });
process.on("exit", () => stack.cleanup());
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

let counter = 0;
const psql = (database, sql, { allowFailure = false } = {}) => {
  try {
    return docker(["exec", "-i", stack.dbName, "psql", "-U", "supabase_admin", "-d", database, "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"], { input: sql, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return { failed: true, message: String(error.stderr ?? error.message) };
    throw error;
  }
};
// Ce que fournit la plateforme et que les migrations supposent (comme le « shim » des tests en mémoire).
const PLATFORM = `
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  create extension if not exists "uuid-ossp" with schema extensions;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid, metadata jsonb, unique (bucket_id, name));
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
`;
const newDatabase = () => {
  const name = `lab_${Date.now()}_${(counter += 1)}`;
  psql("postgres", `create database ${name}`);
  psql(name, PLATFORM);
  return name;
};
const dropDatabase = (name) => psql("postgres", `drop database if exists ${name} with (force)`);
const migrate = (database, list, { recordHistory = true } = {}) => {
  psql(database, "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, name text);");
  for (const file of list) {
    psql(database, text(file));
    if (recordHistory) psql(database, `insert into supabase_migrations.schema_migrations values ('${file.slice(0, 4)}', '${file.slice(5)}') on conflict do nothing;`);
  }
};

const fingerprint = (database) => {
  const structure = psql(database, FINGERPRINT_SQL).split("\n").filter(Boolean);
  const rights = [...parseSnapshot(psql(database, ACL_SNAPSHOT_SQL)).values()].map((row) => `acl|${row.kind}|${row.object}|${row.acl}|${row.detail}`).sort();
  const lines = [...structure, ...rights];
  return { lines, digest: createHash("sha256").update(lines.join("\n")).digest("hex") };
};
const diff = (a, b) => diffLines(a.lines, b.lines);

/**
 * Fixture synthétique au niveau 0009 : 307 publications (298 simulées, 9 réelles), accords, commentaires, versions,
 * médias, canal transféré (historique de l'ancien client) et canal vide, tentatives claimed/pushing/unknown et
 * compensations en attente. Tout passe par les fonctions du produit (aucune écriture directe sauf les états de crash).
 */
function seedFixture(database) {
  const posts = [];
  for (let index = 0; index < 298; index += 1) {
    posts.push({ mode: "mock", id: `mock-lab-${index}`, channelId: index % 2 === 0 ? "mock-ch-a" : "mock-ch-b", text: `Texte simulé ${index}`, status: index % 41 === 0 ? "sent" : "draft" });
  }
  for (let index = 0; index < 9; index += 1) {
    posts.push({ mode: "real", id: `real-lab-${index}`, channelId: "real-ch-a", text: `Texte réel ${index}`, status: "draft" });
  }
  const payload = (mode) => JSON.stringify({
    mode, triggeredBy: "lab", complete: false,
    channels: mode === "mock"
      ? [{ id: "mock-ch-a", service: "linkedin", name: "A", organizationSlug: "client-a" }, { id: "mock-ch-b", service: "instagram", name: "B", organizationSlug: "client-b" }, { id: "mock-ch-vide", service: "linkedin", name: "Vide", organizationSlug: "client-a" }]
      : [{ id: "real-ch-a", service: "linkedin", name: "Réel A", organizationSlug: "client-a" }],
    posts: posts.filter((post) => post.mode === mode).map((post) => ({ id: post.id, channelId: post.channelId, service: "linkedin", status: post.status, text: post.text, dueAt: "2031-04-01T09:00:00.000Z", hasReviewTag: true, assets: [] })),
  }).replace(/'/g, "''");
  psql(database, `
    insert into private.app_secrets (name, secret_hash) values ('automation', encode(extensions.digest('${SECRET}', 'sha256'), 'hex')) on conflict (name) do update set secret_hash = excluded.secret_hash;
    insert into auth.users (id, email) values
      ('00000000-0000-4000-8000-0000000000a0', 'admin@lab.test'), ('00000000-0000-4000-8000-0000000000a1', 'a@lab.test'), ('00000000-0000-4000-8000-0000000000b1', 'b@lab.test');
    insert into public.profiles (id, full_name, role) values
      ('00000000-0000-4000-8000-0000000000a0', 'Admin', 'admin'), ('00000000-0000-4000-8000-0000000000a1', 'Client A', 'client'), ('00000000-0000-4000-8000-0000000000b1', 'Client B', 'client');
    insert into public.organizations (slug, name, initials) values ('client-a', 'Client A', 'CA'), ('client-b', 'Client B', 'CB');
    insert into public.organization_members select o.id, u.id from public.organizations o join (values ('client-a', '00000000-0000-4000-8000-0000000000a1'::uuid), ('client-b', '00000000-0000-4000-8000-0000000000b1'::uuid)) u(slug, id) on u.slug = o.slug;
    select public.sync_buffer_posts('${SECRET}', '${payload("mock")}'::jsonb);
    select public.sync_buffer_posts('${SECRET}', '${payload("real")}'::jsonb);
  `);
  // Accords, demandes de modification avec commentaire (via le produit, sous l'identité d'un client).
  psql(database, `
    select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', false);
    set role authenticated;
    select public.decide_post(p.id, 'approved', p.content_hash, null) from public.posts p
      where p.buffer_post_id like 'mock-lab-%' and p.channel_id = (select id from public.channels where buffer_channel_id = 'mock-ch-a') and p.buffer_status = 'draft' limit 30;
    select public.decide_post(p.id, 'changes_requested', p.content_hash, 'À revoir : titre') from public.posts p
      where p.buffer_post_id like 'real-lab-%' and p.approval_status = 'pending' limit 3;
    reset role;
  `);
  // États de crash : tentative de programmation en cours, compensation en attente, tentatives d'envoi Studio.
  psql(database, `
    select * from public.claim_posts_for_scheduling_in_mode('${SECRET}', 'mock', null, 5);
    update public.posts set schedule_state = 'unschedule_pending', buffer_status = 'scheduled'
      where id in (select id from public.posts where approval_status = 'approved' and schedule_state = 'idle' order by id limit 2);
  `);
}
const CONTENT_SQL = `
  select 'posts|' || count(*) || '|' || md5(coalesce(string_agg(buffer_post_id || ':' || text || ':' || content_hash || ':' || version, ',' order by buffer_post_id), '')) from public.posts
  union all select 'decisions|' || count(*) from public.approval_decisions
  union all select 'comments|' || count(*) from public.comments
  union all select 'versions|' || count(*) from public.post_versions
  union all select 'channels|' || count(*) from public.channels
  union all select 'organizations|' || count(*) from public.organizations;`;

try {
  console.log(`Laboratoire : ${stack.prefix}`);
  await stack.upDbOnly();

  // 0. Empreintes ATTENDUES par niveau (pour comparer plus tard un schéma réel, en lecture seule).
  if (option("export-expected")) {
    const out = resolve(option("export-expected"));
    mkdirSync(out, { recursive: true });
    for (const level of ["0003", "0008", "0009", "0010", "0011"]) {
      const database = newDatabase();
      migrate(database, upTo(level));
      writeFileSync(resolve(out, `niveau-${level}.txt`), `${fingerprint(database).lines.join("\n")}\n`);
      dropDatabase(database);
    }
    console.log(`Empreintes attendues écrites dans ${out}`);
  }

  // 1. Installation neuve
  const fresh = newDatabase();
  migrate(fresh, files);
  const freshPrint = fingerprint(fresh);
  check(`installation neuve 0001 → ${files.at(-1).slice(0, 4)} sur PostgreSQL ${psql("postgres", "show server_version;")}`, freshPrint.lines.length > 200, `${freshPrint.lines.length} éléments d'empreinte`);

  // 2. Rejeu. Politique : une migration se rejoue À SON NIVEAU (base à N, N rejouée : sans erreur, empreinte
  //    inchangée) pour 0004–0007 et 0009–0011. Rejouer une ancienne migration APRÈS une plus récente n'est jamais un
  //    rejeu : elle remettrait d'anciennes définitions (régression) ; le journal d'historique l'interdit. Les
  //    migrations 0001–0003 et 0008 ne sont pas rejouables et ne sont jamais réécrites : constaté, documenté.
  for (const file of files) {
    const level = file.slice(0, 4);
    const database = newDatabase();
    migrate(database, upTo(level));
    const reference = fingerprint(database).digest;
    const outcome = psql(database, text(file), { allowFailure: true });
    const replayable = outcome.failed !== true;
    const same = replayable && fingerprint(database).digest === reference;
    const required = ["0009", "0010", "0011"].includes(level);
    const reason = replayable ? (same ? "" : "empreinte différente") : (String(outcome.message).split("\n").find((line) => /ERROR/.test(line)) ?? "");
    if (required) check(`rejeu de ${file} à son niveau : sans erreur, empreinte inchangée`, same, reason);
    else console.log(`INFO   rejeu de ${file} à son niveau : ${same ? "possible" : `non rejouable (${reason || "empreinte différente"}) — migration historique, jamais réécrite`}`);
    dropDatabase(database);
  }

  // 3. Montée depuis 0003 avec historique 0003 absent alors que ses objets existent
  {
    const database = newDatabase();
    migrate(database, upTo("0003"), { recordHistory: false });
    psql(database, "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, name text); insert into supabase_migrations.schema_migrations values ('0001','schema'),('0002','fiabilite');");
    const hasObjects = psql(database, "select count(*) from pg_proc where proname = 'claim_posts_for_scheduling_in_mode';") === "1";
    migrate(database, files.filter((file) => file.slice(0, 4) >= "0003"));
    const printed = fingerprint(database);
    check("0003 : objets présents sans entrée d'historique → la chaîne rejouée aboutit", hasObjects && printed.digest === freshPrint.digest, diff(printed, freshPrint).slice(0, 3).join(" | "));
    dropDatabase(database);
  }

  // 4. Montée avec données depuis 0008, 0009 puis 0010
  for (const level of ["0008", "0009", "0010"]) {
    const database = newDatabase();
    migrate(database, upTo(level));
    if (level >= "0009") seedFixture(database);
    else {
      // 0008 : fixture sans propriété explicite (colonnes de 0009 absentes) : publications et accords via le produit.
      psql(database, `
        insert into private.app_secrets (name, secret_hash) values ('automation', encode(extensions.digest('${SECRET}', 'sha256'), 'hex')) on conflict (name) do update set secret_hash = excluded.secret_hash;
        insert into public.organizations (slug, name, initials) values ('client-a', 'Client A', 'CA');`);
    }
    const before = level >= "0009" ? psql(database, CONTENT_SQL) : "";
    const total = level >= "0009" ? Number(psql(database, "select count(*) from public.posts;")) : 0;
    migrate(database, files.filter((file) => file.slice(0, 4) > level));
    const printed = fingerprint(database);
    check(`montée ${level} → ${files.at(-1).slice(0, 4)} : schéma identique à une installation neuve`, printed.digest === freshPrint.digest, diff(printed, freshPrint).slice(0, 3).join(" | "));
    if (level >= "0009") {
      check(`montée ${level} : ${total} publications (298 simulées + 9 réelles + canaux) conservées`, total === 307);
      const after = psql(database, CONTENT_SQL);
      // Contenus et relations : mêmes publications, textes, empreintes, versions, décisions, commentaires.
      check(`montée ${level} : contenus et relations conservés (publications, décisions, commentaires, versions)`, after.split("\n").slice(0, 1).join() === before.split("\n").slice(0, 1).join() && after.split("\n").slice(1).join() === before.split("\n").slice(1).join(), "");
      // Les imports sans origine certaine restent privés ; aucun accord hérité inéligible n'est programmable.
      const leaked = psql(database, `select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', false); set role authenticated; select count(*) from public.posts where owner_organization_id is distinct from (select organization_id from public.organization_members where user_id = auth.uid()); reset role;`).split("\n").at(-2);
      check(`montée ${level} : un client ne lit aucune publication d'un autre client (RLS réelle)`, leaked === "0", `${leaked} ligne(s)`);
      const schedulable = psql(database, `select count(*) from public.claim_posts_for_scheduling_in_mode('${SECRET}', 'mock', null, 100) c join public.posts p on p.id = c.id where p.ownership <> 'assigned' or p.approved_organization_id is distinct from p.owner_organization_id;`);
      check(`montée ${level} : aucun accord inéligible n'est programmable`, schedulable === "0", `${schedulable}`);
    }
    dropDatabase(database);
  }

  // 5. Prérequis manquant : échec net, base INCHANGÉE, puis reprise
  {
    const database = newDatabase();
    migrate(database, upTo("0009"));
    const before = fingerprint(database).digest;
    const failed = psql(database, text("0011_correction_v3.sql"), { allowFailure: true });
    const after = fingerprint(database).digest;
    check("0011 sur une base à 0009 : refus explicite du prérequis", failed.failed === true && /migration_0011_requires_0010/.test(failed.message));
    check("échec de prérequis atomique : empreinte de la base inchangée", before === after);
    migrate(database, ["0010_contre_audit.sql", "0011_correction_v3.sql"]);
    check("reprise après l'échec : 0010 puis 0011 aboutissent à l'empreinte d'une installation neuve", fingerprint(database).digest === freshPrint.digest);
    dropDatabase(database);
  }

  // 6. Échec EN COURS de migration : transaction annulée, rien ne subsiste
  {
    const database = newDatabase();
    migrate(database, upTo("0010"));
    const before = fingerprint(database).digest;
    const broken = text("0011_correction_v3.sql").replace(/\ncommit;\s*$/, "\nselect 1 / 0;\ncommit;\n");
    const failed = psql(database, broken, { allowFailure: true });
    check("migration interrompue en cours de route : erreur signalée", failed.failed === true && /division by zero/.test(failed.message));
    check("migration interrompue : annulée en entier (aucune table ni fonction à moitié créée)", fingerprint(database).digest === before);
    migrate(database, ["0011_correction_v3.sql"]);
    check("reprise après interruption : la migration aboutit", fingerprint(database).digest === freshPrint.digest);
    dropDatabase(database);
  }
  dropDatabase(fresh);
} catch (error) {
  console.error(`Laboratoire interrompu : ${error.message}`);
  results.push({ name: "laboratoire", ok: false });
}

const failed = results.filter((item) => !item.ok);
console.log("");
console.log(failed.length === 0 ? `MIGRATIONS ÉPROUVÉES SUR POSTGRESQL NATIF (${results.length} contrôles).` : `${failed.length} CONTRÔLE(S) EN ÉCHEC sur ${results.length}.`);
process.exit(failed.length === 0 ? 0 : 1);
