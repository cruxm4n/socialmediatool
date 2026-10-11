// Restauration d'une sauvegarde Cadence (scripts/backup.mjs) dans une base PostgreSQL d'un conteneur Docker.
// Partagé par scripts/restore-check.mjs (base jetable à côté de la base de test) et scripts/restore-drill.mjs
// (pile Supabase isolée complète).
//
// Règles :
//   - jamais de DROP ni de --clean : la cible doit être vide de données Cadence, sinon refus ;
//   - les droits sont restaurés avec le dump (GRANT/REVOKE) ; aucun droit n'est accordé « pour que ça marche » ;
//   - un schéma plateforme déjà présent dans la cible (auth, storage d'un projet Supabase neuf) reçoit les
//     DONNÉES seulement, déclencheurs désactivés ; les schémas de Cadence sont restaurés en entier ;
//   - toute erreur grave est rapportée, jamais masquée.
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readManifest(backup) {
  const path = join(backup, "manifest.json");
  if (!existsSync(path)) throw new Error(`manifest.json introuvable dans ${backup}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest.database?.file || !manifest.database?.sha256) throw new Error("manifest.json incomplet (dump absent).");
  return manifest;
}

/**
 * Tables dont l'absence est une ERREUR dès que l'historique de migrations de la sauvegarde les prévoit. Un compteur
 * `null` ou une table manquante n'est jamais « simplement absent » : soit la migration n'est pas dans l'historique
 * (table non attendue), soit la sauvegarde est incomplète.
 */
export const REQUIRED_SINCE = {
  "public.organizations": "0001", "public.profiles": "0001", "public.organization_members": "0001", "public.channels": "0001", "public.posts": "0001",
  "public.approval_decisions": "0001", "public.comments": "0001", "public.post_events": "0001", "public.sync_runs": "0006",
  "public.notifications": "0007", "public.notification_preferences": "0007",
  "public.media_assets": "0008", "public.studio_drafts": "0008", "public.studio_variants": "0008", "public.post_versions": "0008",
  "public.channel_owner_history": "0010", "public.studio_push_events": "0011",
  "public.provider_connections": "0012", "private.provider_credentials": "0012", "public.provider_connection_events": "0012", "private.user_passwords": "0015",
  "auth.users": "0000", "auth.identities": "0000", "storage.objects": "0000",
};
export const REQUIRED_SCHEMAS = ["public", "private", "auth", "storage", "supabase_migrations"];

/** Contrôle de cohérence du manifeste et des fichiers de la sauvegarde. Renvoie la liste des problèmes (vide : cohérente). */
export function validateBackup(backup, manifest) {
  const problems = [];
  const missing = (name) => problems.push(`manifeste incomplet : ${name} absent`);
  if (!Array.isArray(manifest.schemas)) missing("schemas");
  else for (const schema of REQUIRED_SCHEMAS) if (!manifest.schemas.includes(schema)) problems.push(`manifeste incomplet : schéma ${schema} non sauvegardé`);
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) missing("migrations (historique)");
  if (!manifest.rowCounts || typeof manifest.rowCounts !== "object") missing("rowCounts");
  if (!manifest.rowDigests || typeof manifest.rowDigests !== "object") problems.push("manifeste incomplet : empreintes de contenu (rowDigests) absentes — sauvegarde faite avec une version antérieure de l'outil, refaites-la");
  if (!manifest.acl?.file || !manifest.acl?.sha256) missing("acl (empreinte des droits)");
  else if (!existsSync(join(backup, manifest.acl.file))) problems.push(`fichier des droits manquant : ${manifest.acl.file}`);
  else if (sha256File(join(backup, manifest.acl.file)) !== manifest.acl.sha256) problems.push("empreinte du fichier des droits différente du manifeste : sauvegarde altérée");
  if (!Array.isArray(manifest.storage)) missing("storage (liste des fichiers)");
  if (problems.length > 0) return problems;

  const levels = manifest.migrations.map((version) => String(version).slice(0, 4));
  const latest = levels.length > 0 ? [...levels].sort().at(-1) : "0000";
  for (const [table, since] of Object.entries(REQUIRED_SINCE)) {
    const expected = since === "0000" || levels.includes(since) || latest >= since;
    if (expected && (manifest.rowCounts[table] === null || manifest.rowCounts[table] === undefined)) {
      problems.push(`table attendue absente de la sauvegarde : ${table} (prévue depuis la migration ${since})`);
    }
    if (expected && manifest.rowDigests && (manifest.rowDigests[table] === null || manifest.rowDigests[table] === undefined)) {
      problems.push(`empreinte de contenu absente : ${table}`);
    }
  }
  const objects = manifest.rowCounts["storage.objects"];
  if (typeof objects === "number" && objects !== manifest.storage.length) {
    problems.push(`fichiers du stockage incomplets : ${manifest.storage.length} sauvegardé(s) pour ${objects} objet(s) en base`);
  }
  for (const file of manifest.storage) {
    const path = join(backup, "storage", file.bucket, file.name);
    if (!existsSync(path)) problems.push(`fichier du stockage manquant : ${file.bucket}/${file.name}`);
    else if (sha256File(path) !== file.sha256) problems.push(`fichier du stockage altéré : ${file.bucket}/${file.name}`);
  }
  if (manifest.driftDetected) problems.push("sauvegarde prise pendant des écritures concurrentes (dérive signalée par le manifeste)");
  return problems;
}

export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Accès à un Postgres dans un conteneur : psql et pg_restore, en tant que `user` (superutilisateur de la cible). */
export function postgresIn(container, user = "postgres") {
  // stderr est capturé (et porté par l'exception) : un refus attendu ne doit pas polluer la sortie.
  const docker = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"], ...options });
  return {
    docker,
    psql: (database, query) =>
      docker(["exec", "-i", container, "psql", "-U", user, "-d", database, "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"], { input: query }).trim(),
    restoreArgs: (database, dumpInContainer, extra) =>
      ["exec", container, "pg_restore", "-U", user, "--no-owner", "-d", database, ...extra, dumpInContainer],
  };
}

/**
 * Restaure `backup` dans `database`. Renvoie { problems: string[], plan: { full: string[], dataOnly: string[] } }.
 * `problems` vide : la restauration s'est déroulée sans erreur grave (elle n'est pas pour autant « vérifiée »).
 */
export function restoreBackup({ pg, container, database, backup, log = console.log }) {
  const manifest = readManifest(backup);
  const problems = [];
  const dumpFile = join(backup, manifest.database.file);
  if (!existsSync(dumpFile)) {
    return { problems: [`dump manquant : ${manifest.database.file}`], plan: { full: [], dataOnly: [] } };
  }
  if (sha256File(dumpFile) !== manifest.database.sha256) {
    return { problems: ["empreinte du dump différente de celle du manifeste : sauvegarde altérée ou incomplète"], plan: { full: [], dataOnly: [] } };
  }
  // Manifeste et fichiers cohérents AVANT toute écriture dans la cible.
  const inconsistent = validateBackup(backup, manifest);
  if (inconsistent.length > 0) return { problems: inconsistent, plan: { full: [], dataOnly: [] } };

  // Rôles : une cible sans eux ferait échouer ou, pire, ignorer les GRANT.
  const present = pg.psql(database, "select rolname from pg_roles;").split("\n");
  const missingRoles = (manifest.requiredRoles ?? []).filter((role) => !present.includes(role));
  if (missingRoles.length > 0) problems.push(`rôles absents de la cible : ${missingRoles.join(", ")} (la cible doit être une instance Supabase)`);

  // La cible doit être vide de données Cadence : on ne mélange pas deux jeux de données.
  const plan = { full: [], dataOnly: [] };
  for (const schema of manifest.schemas) {
    const tables = Number(pg.psql(database, `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${schema}' and c.relkind = 'r';`));
    (tables > 0 ? plan.dataOnly : plan.full).push(schema);
  }
  for (const schema of plan.dataOnly) {
    const rows = pg.psql(database, `select coalesce(sum(n_live_tup), 0)::bigint from pg_stat_user_tables where schemaname = '${schema}';`);
    if (schema === "public" || schema === "private") problems.push(`le schéma ${schema} existe déjà dans la cible : refus de mélanger des données (cible non vide)`);
    else if (Number(rows) > 0 && schema === "storage") {
      const objects = Number(pg.psql(database, "select count(*) from storage.objects;"));
      if (objects > 0) problems.push("la cible contient déjà des objets de stockage : refus");
    }
  }
  if (problems.length > 0) return { problems, plan };

  const target = `/tmp/${database}.dump`;
  pg.docker(["cp", dumpFile, `${container}:${target}`]);
  const run = (extra, label) => {
    try {
      pg.docker(pg.restoreArgs(database, target, extra), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const stderr = String(error.stderr ?? error.message);
      // « already exists » : objets créés par l'initialisation de la plateforme (schémas, extensions) : sans conséquence.
      const serious = stderr.split("\n").filter((line) => /error:/i.test(line) && !/already exists/i.test(line));
      if (serious.length > 0) problems.push(`${label} : ${serious.slice(0, 3).join(" | ")}`);
    }
  };
  try {
    // Le sommaire du dump (pg_restore -l) est filtré entrée par entrée : -n ne reprendrait ni le CREATE SCHEMA ni les
    // droits du schéma, ce qui est précisément ce qui manquait.
    const toc = pg.docker(["exec", container, "pg_restore", "-l", target]).split("\n");
    const selection = selectTocEntries(toc, plan);
    log(`  restauration complète : ${plan.full.join(", ") || "—"} (${selection.full.length} entrées)`);
    log(`  données et politiques seules (schéma plateforme déjà présent) : ${plan.dataOnly.join(", ") || "—"} (${selection.data.length + selection.policies.length} entrées)`);
    const send = (name, lines) => {
      pg.docker(["exec", "-i", container, "sh", "-c", `cat > /tmp/${database}.${name}.list`], { input: lines.join("\n") + "\n" });
      return `/tmp/${database}.${name}.list`;
    };
    // Les politiques posées par Cadence sur des tables de la plateforme (storage.objects) font partie du schéma
    // de Cadence : elles sont restaurées, sans toucher aux tables elles-mêmes.
    const full = [...selection.full, ...selection.policies];
    // 1. Données des schémas plateforme d'abord (comptes, métadonnées de stockage) : les clés étrangères de
    //    public.profiles les référencent. Les déclencheurs sont suspendus : restaurer des événements ne doit créer
    //    ni notifications ni versions en double.
    if (selection.data.length > 0) {
      run(["--data-only", "--disable-triggers", "-L", send("data", selection.data)], "pg_restore (données)");
    }
    // 2. Schémas de Cadence. Les privilèges PAR DÉFAUT de la plateforme donneraient à anon/authenticated l'exécution
    //    de chaque fonction créée, et le dump ne retire pas ce que les défauts ont ajouté : on les neutralise le
    //    temps de la restauration ; les ALTER DEFAULT PRIVILEGES du dump les rétablissent ensuite à l'identique.
    if (full.length > 0) {
      pg.psql(database, neutralizeDefaultPrivilegesSql(plan.full));
      run(["-L", send("full", full)], "pg_restore (schémas complets)");
    }
  } finally {
    pg.docker(["exec", container, "sh", "-c", `rm -f ${target} /tmp/${database}.*.list`]);
  }
  return { problems, plan };
}

/** Retire, pour le rôle qui restaure, les privilèges par défaut des schémas donnés (rétablis ensuite par le dump). */
export function neutralizeDefaultPrivilegesSql(schemas) {
  const list = schemas.map((name) => `'${name.replace(/'/g, "''")}'`).join(", ");
  return `
do $$
declare r record;
begin
  for r in
    select n.nspname as schema, d.defaclobjtype as kind,
           case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as grantee
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole = current_user::regrole and n.nspname = any (array[${list}]) and a.grantee <> d.defaclrole
  loop
    execute format('alter default privileges for role %s in schema %I revoke all on %s from %s',
      current_user, r.schema,
      case r.kind when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types' else 'tables' end,
      r.grantee);
  end loop;
end $$;`;
}

const PLATFORM_MIGRATION_TABLES = new Set(["auth.schema_migrations", "storage.migrations"]);

const MULTIWORD = ["TABLE DATA", "SEQUENCE SET", "SEQUENCE OWNED BY", "FK CONSTRAINT", "CHECK CONSTRAINT", "ROW SECURITY", "DEFAULT ACL", "MATERIALIZED VIEW DATA", "EVENT TRIGGER", "FOREIGN TABLE", "PUBLICATION TABLE", "TEXT SEARCH", "ACCESS METHOD"];

/** Une ligne du sommaire pg_restore -l → { desc, schema } (schema null : objet global). */
export function parseTocLine(line) {
  const match = /^\d+; \d+ \d+ (.*)$/.exec(line);
  if (!match) return null;
  const body = match[1];
  const desc = MULTIWORD.find((item) => body.startsWith(`${item} `)) ?? body.split(" ")[0];
  const rest = body.slice(desc.length + 1).split(" ");
  let schema = rest[0] === "-" ? null : rest[0];
  if (schema === null && rest[1] === "SCHEMA" && rest[2]) schema = rest[2]; // ACL / COMMENT d'un schéma
  if (desc === "SCHEMA") schema = rest[1] ?? null; // « SCHEMA - private owner »
  const name = desc === "SCHEMA" ? null : (rest[1] ?? null);
  return { desc, schema, name };
}

/**
 * Répartition des entrées du sommaire :
 *   full     : tout ce qui appartient aux schémas restaurés en entier ;
 *   data     : les données (TABLE DATA, SEQUENCE SET) des schémas plateforme déjà présents ;
 *   policies : les politiques RLS posées par Cadence sur ces schémas plateforme.
 */
export function selectTocEntries(lines, plan) {
  const out = { full: [], data: [], policies: [] };
  for (const line of lines) {
    const entry = parseTocLine(line);
    if (!entry || !entry.schema) continue;
    if (plan.full.includes(entry.schema)) out.full.push(line);
    else if (plan.dataOnly.includes(entry.schema)) {
      // Les tables de suivi des migrations de la plateforme sont déjà remplies par la plateforme elle-même.
      if (PLATFORM_MIGRATION_TABLES.has(`${entry.schema}.${entry.name}`)) continue;
      if (entry.desc === "TABLE DATA" || entry.desc === "SEQUENCE SET") out.data.push(line);
      else if (entry.desc === "POLICY") out.policies.push(line);
    }
  }
  return out;
}

/**
 * Les clés Buffer restaurées sont-elles encore DÉCHIFFRABLES ? La clé maître n'est jamais dans la sauvegarde : elle
 * est lue dans l'environnement de ce script (CADENCE_CREDENTIALS_KEY, _KEY_VERSION, _PREVIOUS_KEYS), comme le fait
 * l'application (src/server/credentials.ts). Rien n'est affiché ni conservé des clés ; aucune clé de repli.
 * Renvoie { total, readable, unreadable: [identifiants de connexion], keyProvided }.
 * @param {{ psql: (database: string, query: string) => string }} pg
 * @param {string} database
 * @param {Record<string, string | undefined>} [env]
 */
export function verifyRestoredCredentials(pg, database, env = process.env) {
  const exists = pg.psql(database, "select to_regclass('private.provider_credentials') is not null;") === "t";
  if (!exists) return { total: 0, readable: 0, unreadable: [], keyProvided: Boolean(env.CADENCE_CREDENTIALS_KEY), applicable: false };
  const rows = pg.psql(database, "select connection_id || '|' || key_version || '|' || ciphertext from private.provider_credentials order by connection_id;").split("\n").filter(Boolean);
  const keyProvided = Boolean(env.CADENCE_CREDENTIALS_KEY);
  if (!keyProvided) return { total: rows.length, readable: 0, unreadable: [], keyProvided, applicable: true };
  const current = Number(env.CADENCE_CREDENTIALS_KEY_VERSION || 1);
  const keys = new Map([[current, Buffer.from(env.CADENCE_CREDENTIALS_KEY.trim(), "base64")]]);
  for (const item of (env.CADENCE_CREDENTIALS_PREVIOUS_KEYS ?? "").split(",")) {
    const separator = item.indexOf(":");
    if (separator > 0) keys.set(Number(item.slice(0, separator).trim()), Buffer.from(item.slice(separator + 1).trim(), "base64"));
  }
  const unreadable = [];
  for (const row of rows) {
    const [connectionId, version, ciphertext] = row.split("|");
    const [format, iv, tag, data] = ciphertext.split(".");
    const key = keys.get(Number(version));
    try {
      if (format !== "v1" || !key || key.length !== 32) throw new Error("clé ou format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(`cadence:provider-connection:${connectionId}`));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
    } catch {
      unreadable.push(connectionId);
    }
  }
  return { total: rows.length, readable: rows.length - unreadable.length, unreadable, keyProvided, applicable: true };
}
