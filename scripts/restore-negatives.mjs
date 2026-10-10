#!/usr/bin/env node
// Contrôles NÉGATIFS de la restauration (mission V3, C09) : prouve que les contrôles de scripts/restore-check.mjs
// DÉTECTENT les défauts qu'ils prétendent détecter. Chaque contrôle fabrique une copie défectueuse de la sauvegarde,
// lance restore-check dessus et exige un code de sortie non nul ; la destination existante n'est ni modifiée ni supprimée.
//
//   node scripts/restore-negatives.mjs --container <conteneur Postgres> --user supabase_admin --backup <sauvegarde bonne> [--api-url …]
//
// Les copies défectueuses vivent dans un dossier temporaire privé (0700) supprimé à la fin. Les bases de contrôle
// créées par restore-check portent le préfixe cadence_restore_ et sont supprimées par lui. Aucune base existante n'est
// touchée ; la base « canari » du contrôle « destination existante » est créée ici, vérifiée intacte, puis supprimée.
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, openSync, closeSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const container = option("container");
const user = option("user", "postgres");
const good = option("backup") ? resolve(option("backup")) : null;
const apiUrl = option("api-url");
if (!container || !good) {
  console.error("Usage : node scripts/restore-negatives.mjs --container NOM [--user supabase_admin] --backup DOSSIER [--api-url URL]");
  process.exit(2);
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const work = mkdtempSync(join(tmpdir(), "cadence-negatives-"));
const psql = (database, sql) =>
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", user, "-d", database, "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const writeManifest = (dir, manifest) => writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
const copyBackup = (name) => {
  const target = join(work, name);
  cpSync(good, target, { recursive: true });
  return target;
};
const runCheck = (dir, extra = []) => {
  const run = spawnSync(process.execPath, [resolve("scripts/restore-check.mjs"), "--container", container, "--user", user, "--backup", dir, ...extra], { encoding: "utf8" });
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
};

const results = [];
/** Détecté = code de sortie non nul ET le motif attendu apparaît (un plantage sans rapport ne compte pas). */
const expectFailure = (name, outcome, pattern, why = "") => {
  const detected = outcome.code !== 0 && pattern.test(outcome.output);
  results.push({ name, detected });
  console.log(`${detected ? "DÉTECTÉ " : "NON DÉTECTÉ"} ${name} — code ${outcome.code}${why ? ` — ${why}` : ""}`);
  if (!detected) console.log(outcome.output.split("\n").slice(-8).join("\n"));
};

const base = manifestOf(good);

// 1. Dump privé de ses droits (le défaut du contre-audit : --no-privileges)
{
  const dir = copyBackup("sans-droits");
  const dumpPath = join(dir, "database.dump");
  const fd = openSync(dumpPath, "w", 0o600);
  try {
    const schemas = base.schemas.flatMap((schema) => ["-n", schema]);
    execFileSync("docker", ["exec", "-i", container, "pg_dump", "-U", user, "-Fc", "--no-owner", "--no-privileges", ...schemas, "postgres"], { stdio: ["ignore", fd, "inherit"], maxBuffer: 1 << 30 });
  } finally {
    closeSync(fd);
  }
  const manifest = manifestOf(dir);
  manifest.database = { ...manifest.database, bytes: statSync(dumpPath).size, sha256: sha(dumpPath) };
  writeManifest(dir, manifest);
  expectFailure("dump privé de ses droits (pg_dump --no-privileges)", runCheck(dir), /droits différents|manquant après restauration/, "les droits restaurés diffèrent de la source");
}

// 2. Dump altéré
{
  const dir = copyBackup("dump-altere");
  const path = join(dir, "database.dump");
  const bytes = readFileSync(path);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(path, bytes);
  expectFailure("dump altéré (octet modifié)", runCheck(dir), /ÉCHEC dump présent et empreinte conforme|empreinte du dump différente/);
}

// 3-4. Fichiers du stockage manquant / altéré
if (base.storage.length > 0) {
  const first = base.storage[0];
  {
    const dir = copyBackup("fichier-manquant");
    rmSync(join(dir, "storage", first.bucket, first.name));
    expectFailure("fichier du stockage manquant", runCheck(dir), /fichier du stockage manquant/);
  }
  {
    const dir = copyBackup("fichier-altere");
    appendFileSync(join(dir, "storage", first.bucket, first.name), "x");
    expectFailure("fichier du stockage altéré", runCheck(dir), /fichier du stockage altéré/);
  }
} else {
  results.push({ name: "fichiers du stockage manquant/altéré", detected: false });
  console.log("NON ÉPROUVÉ  la sauvegarde ne contient aucun fichier de stockage : créez-en pour éprouver ces deux contrôles.");
}

// 5. Manifeste incomplet (droits, empreintes de contenu, schémas)
for (const key of ["acl", "rowDigests", "schemas", "rowCounts"]) {
  const dir = copyBackup(`manifeste-sans-${key}`);
  const manifest = manifestOf(dir);
  delete manifest[key];
  writeManifest(dir, manifest);
  expectFailure(`manifeste incomplet : « ${key} » supprimé`, runCheck(dir), /manifeste incomplet/);
}

// 6. Table attendue absente
{
  const dir = copyBackup("table-absente");
  const manifest = manifestOf(dir);
  manifest.rowCounts["public.posts"] = null;
  writeManifest(dir, manifest);
  expectFailure("table attendue absente (public.posts sans compteur)", runCheck(dir), /table attendue absente de la sauvegarde : public\.posts/);
}

// 7. Politique trop large : la source déclarait une politique de moins que ce qui est restauré
{
  const dir = copyBackup("politique-large");
  const aclPath = join(dir, "acl.json");
  const acl = JSON.parse(readFileSync(aclPath, "utf8"));
  const index = acl.findIndex((row) => row.kind === "policy" && row.object.startsWith("public.posts."));
  if (index < 0) {
    results.push({ name: "politique trop large", detected: false });
    console.log("NON ÉPROUVÉ  aucune politique public.posts dans l'empreinte.");
  } else {
    acl.splice(index, 1);
    writeFileSync(aclPath, JSON.stringify(acl, null, 1));
    const manifest = manifestOf(dir);
    manifest.acl.sha256 = sha(aclPath);
    writeManifest(dir, manifest);
    expectFailure("politique RLS en trop après restauration (plus large que la source)", runCheck(dir), /en trop après restauration : policy:public\.posts\./);
  }
}

// 8. Destination existante : refus net, sans modification ni suppression
{
  const name = `cadence_restore_existante_${Date.now()}`;
  psql("postgres", `create database ${name}`);
  psql(name, "create table canari (valeur text); insert into canari values ('intact');");
  const outcome = runCheck(good, ["--db", name]);
  const intact = psql(name, "select valeur from canari;") === "intact";
  psql("postgres", `drop database ${name}`);
  expectFailure("destination existante : refus", outcome, /existe déjà/, intact ? "base et données du canari intactes" : "CANARI MODIFIÉ");
  if (!intact) results.push({ name: "destination existante intacte", detected: false });
}

// 9. Dérive pendant la sauvegarde : une écriture survient entre le dump et la fin de la sauvegarde
{
  const out = join(work, "derive");
  const env = { ...process.env, CADENCE_BACKUP_TEST_DELAY_MS: "6000" };
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [resolve("scripts/backup.mjs"), "--container", container, "--user", user, ...(apiUrl ? ["--api-url", apiUrl] : []), "--out", out], { env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  child.stderr.on("data", (chunk) => (text += chunk));
  await new Promise((done) => setTimeout(done, 3000));
  psql("postgres", `insert into public.organizations (slug, name, initials) values ('derive-${Date.now()}', 'Dérive de contrôle', 'DC');`);
  const code = await new Promise((done) => child.on("close", done));
  const dir = text.match(/Sauvegarde écrite dans (.+)/)?.[1];
  const backupDetected = code === 3 && /a changé pendant la sauvegarde/.test(text);
  results.push({ name: "dérive pendant la sauvegarde : l'outil de sauvegarde sort en erreur", detected: backupDetected });
  console.log(`${backupDetected ? "DÉTECTÉ " : "NON DÉTECTÉ"} dérive pendant la sauvegarde : code ${code}`);
  if (dir && existsSync(dir)) expectFailure("sauvegarde dérivée : restauration refusée", runCheck(dir), /dérive|écritures concurrentes/);
}

rmSync(work, { recursive: true, force: true });
const missed = results.filter((item) => !item.detected);
console.log("");
console.log(missed.length === 0 ? `TOUS LES CONTRÔLES NÉGATIFS ONT DÉTECTÉ LE DÉFAUT (${results.length}).` : `${missed.length} CONTRÔLE(S) NÉGATIF(S) N'ONT RIEN DÉTECTÉ : ${missed.map((item) => item.name).join(" ; ")}`);
process.exit(missed.length === 0 ? 0 : 1);
