#!/usr/bin/env node
// Sauvegarde de Cadence : base de données (données métier + comptes), stockage des médias, manifeste de contrôle.
//
// Ce que contient une sauvegarde (voir docs/SAUVEGARDE.md) :
//   database.dump      pg_dump (format personnalisé) des schémas public, auth, storage, private,
//                      supabase_migrations : publications, validations, commentaires, clients, comptes
//                      (auth.users, auth.identities), métadonnées du stockage, ET les droits (GRANT/REVOKE,
//                      privilèges par défaut) : sans eux, une restauration « réussit » mais l'application reçoit
//                      « permission denied for table posts ». Les propriétaires, eux, ne sont pas repris.
//   storage/<bucket>/… les fichiers du stockage (médias), téléchargés par l'API Storage.
//   acl.json           empreinte des droits, des politiques RLS et de l'activation de la RLS à la source :
//                      la restauration est comparée à elle (scripts/restore-check.mjs).
//   manifest.json      date, version du code, migrations, nombre de lignes par table, empreinte de chaque fichier.
//
// Ce script ne MODIFIE RIEN : il lit la base et le stockage. Il n'écrit que dans le dossier de sortie.
//
// Usage (base de TEST locale, conteneur Docker) :
//   node scripts/backup.mjs --container supabase_db_cadence-supabase-test --api-url http://127.0.0.1:54321 --out ~/cadence-backups-test
// avec SUPABASE_SERVICE_ROLE_KEY dans l'environnement (jamais en argument), ou TEST_SERVICE_ROLE_KEY.
//
// Usage (projet distant) : le dump est exécuté depuis un conteneur qui possède pg_dump 17 (celui de la base
// de test convient : il sert de simple client), la chaîne de connexion passe par l'environnement.
//   DATABASE_URL=postgresql://… SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/backup.mjs --container supabase_db_cadence-supabase-test --remote --out /chemin/sauvegardes
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { ACL_SNAPSHOT_SQL, parseSnapshot, snapshotToJson } from "./lib/acl-snapshot.mjs";

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const container = option("container");
const remote = flag("remote");
const apiUrl = option("api-url") ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.TEST_SERVICE_ROLE_KEY;
const outRoot = resolve(option("out") ?? "backups");
// Utilisateur SQL du conteneur : « postgres » (base de test CLI) ou « supabase_admin » (pile isolée de test-stack.mjs).
const sqlUser = option("user", "postgres");
const SCHEMAS = ["public", "auth", "storage", "private", "supabase_migrations"];
const COUNTED_TABLES = [
  "public.organizations", "public.profiles", "public.organization_members", "public.channels", "public.posts",
  "public.approval_decisions", "public.comments", "public.post_events", "public.post_versions", "public.sync_runs",
  "public.notifications", "public.notification_preferences", "public.media_assets", "public.studio_drafts", "public.studio_variants",
  "public.channel_owner_history", "public.studio_push_events",
  "auth.users", "auth.identities", "storage.objects",
];

if (!container) {
  console.error("Indiquez --container NOM (conteneur Postgres : il porte pg_dump et psql).");
  process.exit(2);
}
if (remote && !process.env.DATABASE_URL) {
  console.error("Mode --remote : la variable d'environnement DATABASE_URL est requise.");
  process.exit(2);
}

function psql(query) {
  if (remote) {
    return execFileSync("docker", ["exec", "-i", "-e", "DATABASE_URL", container, "sh", "-c", 'psql "$DATABASE_URL" -At -F "|" -v ON_ERROR_STOP=1'], { input: query, encoding: "utf8" }).trim();
  }
  return execFileSync("docker", ["exec", "-i", container, "psql", "-U", sqlUser, "-d", "postgres", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"], { input: query, encoding: "utf8" }).trim();
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const dir = join(outRoot, `cadence-backup-${stamp}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);

/**
 * Empreinte du CONTENU (pas seulement du nombre de lignes) de chaque table suivie : md5 des lignes ordonnées. Relevée
 * avant et après la sauvegarde : une différence prouve qu'une écriture a eu lieu entre-temps (dérive). Une table
 * absente donne `null` ; c'est la restauration qui décide si cette absence est acceptable (selon les migrations).
 */
function contentDigests() {
  const result = {};
  for (const table of COUNTED_TABLES) {
    try {
      result[table] = psql(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from ${table} t;`);
    } catch {
      result[table] = null;
    }
  }
  return result;
}
const digestsBefore = contentDigests();

// 1. Base de données
console.log("Sauvegarde de la base…");
const dumpPath = join(dir, "database.dump");
// Pas de --no-privileges : les droits font partie de ce qu'on sauvegarde (contre-audit du 10 octobre 2026).
const dumpArgs = ["-Fc", "--no-owner", ...SCHEMAS.flatMap((schema) => ["-n", schema])];
const fd = openSync(dumpPath, "w", 0o600);
try {
  const envArgs = remote ? ["-e", "DATABASE_URL"] : [];
  const command = remote ? ["sh", "-c", `pg_dump ${dumpArgs.join(" ")} "$DATABASE_URL"`] : ["pg_dump", "-U", sqlUser, ...dumpArgs, "postgres"];
  execFileSync("docker", ["exec", "-i", ...envArgs, container, ...command], { stdio: ["ignore", fd, "inherit"], maxBuffer: 1 << 30 });
} finally {
  closeSync(fd);
}
if (statSync(dumpPath).size < 1000) throw new Error("Le dump est vide ou tronqué : sauvegarde abandonnée.");
// Contrôle de dérive en situation d'essai : laisse à un test le temps d'écrire pendant la sauvegarde (jamais en production).
const testDelay = Number(process.env.CADENCE_BACKUP_TEST_DELAY_MS ?? 0);
if (testDelay > 0) await new Promise((done) => setTimeout(done, testDelay));

// 2. Manifeste : migrations, nombre de lignes, droits
const aclSource = parseSnapshot(psql(ACL_SNAPSHOT_SQL));
if (aclSource.size === 0) throw new Error("Aucun droit relevé : la lecture de la base est anormale, sauvegarde abandonnée.");
const aclPath = join(dir, "acl.json");
writeFileSync(aclPath, JSON.stringify(snapshotToJson(aclSource), null, 1), { mode: 0o600 });
const requiredRoles = psql("select string_agg(rolname, ',' order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator','supabase_auth_admin','supabase_storage_admin');").split(",").filter(Boolean);
const serverVersion = psql("show server_version;");
const migrations = psql("select version from supabase_migrations.schema_migrations order by version;").split("\n").filter(Boolean);
const counts = {};
for (const table of COUNTED_TABLES) {
  try {
    counts[table] = Number(psql(`select count(*) from ${table};`));
  } catch {
    counts[table] = null; // table absente (migration non appliquée)
  }
}

// 3. Stockage : chaque objet est téléchargé par l'API puis empreinte
const files = [];
const objects = psql("select bucket_id, name from storage.objects order by bucket_id, name;")
  .split("\n").filter(Boolean).map((line) => line.split("|"));
if (objects.length > 0) {
  if (!apiUrl || !serviceKey) {
    throw new Error("Des fichiers existent dans le stockage : fournissez --api-url et SUPABASE_SERVICE_ROLE_KEY pour les sauvegarder.");
  }
  console.log(`Sauvegarde de ${objects.length} fichier(s) du stockage…`);
  for (const [bucket, name] of objects) {
    const target = join(dir, "storage", bucket, name);
    if (!resolve(target).startsWith(join(dir, "storage") + "/")) throw new Error(`Chemin de stockage refusé : ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    const url = `${apiUrl.replace(/\/$/, "")}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${name.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } });
    if (!response.ok || !response.body) throw new Error(`Téléchargement impossible (${bucket}/${name}) : HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { mode: 0o600 }));
    files.push({ bucket, name, bytes: statSync(target).size, sha256: sha256(target) });
  }
}

let commit = "inconnu";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* hors dépôt */
}
// Dérive : le dump, les compteurs et les fichiers ne partagent pas un instant atomique. On le CONSTATE (ce n'est pas
// une garantie d'atomicité) : le contenu de chaque table suivie, relevé avant puis après, doit être identique.
const digestsAfter = contentDigests();
const drifted = COUNTED_TABLES.filter((table) => digestsBefore[table] !== digestsAfter[table]);
const driftDetected = drifted.length > 0;
if (driftDetected) console.warn(`ATTENTION : le contenu de ${drifted.join(", ")} a changé pendant la sauvegarde. Recommencez en suspendant les écritures (synchronisations, validations).`);

const manifest = {
  createdAt: new Date().toISOString(),
  codeCommit: commit,
  postgresVersion: serverVersion,
  requiredRoles,
  acl: { file: "acl.json", entries: aclSource.size, sha256: sha256(aclPath) },
  driftDetected,
  driftedTables: drifted,
  rowDigests: digestsBefore,
  // Hors dump : à inventorier et à restaurer séparément (voir docs/SAUVEGARDE.md, « Ce que le dump ne contient pas »).
  excludedFromDump: [
    "réglages Auth du projet (URL de redirection, durées de session, fournisseurs, modèles d'e-mail)",
    "paramètres SMTP et secrets associés",
    "clés d'API et secrets JWT du projet",
    "variables d'environnement de l'application (.env.production) et secret d'automatisation",
    "configuration de Caddy, n8n et du planificateur",
    "tâches planifiées (pg_cron) et extensions non Cadence",
    "propriétaires SQL des objets (--no-owner)",
  ],
  source: remote ? "distant" : `conteneur ${container}`,
  migrations,
  schemas: SCHEMAS,
  rowCounts: counts,
  database: { file: "database.dump", bytes: statSync(dumpPath).size, sha256: sha256(dumpPath) },
  storage: files,
  note: "Une sauvegarde n'est validée qu'une fois restaurée : scripts/restore-check.mjs (base, droits, RLS) puis scripts/restore-drill.mjs (Auth, API, Storage). Voir docs/SAUVEGARDE.md.",
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(`Sauvegarde écrite dans ${dir}`);
console.log(`  ${migrations.length} migration(s), ${counts["public.posts"] ?? "?"} publication(s), ${files.length} fichier(s).`);
console.log(`  ${aclSource.size} entrée(s) de droits/politiques relevées.`);
console.log("  NON VALIDÉE tant qu'une restauration n'a pas été vérifiée (node scripts/restore-check.mjs puis scripts/restore-drill.mjs).");
if (driftDetected) process.exitCode = 3;
