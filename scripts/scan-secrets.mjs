#!/usr/bin/env node
// Contrôle de secrets SANS AFFICHAGE DE VALEUR (mission V3, C13). Parcourt (1) les fichiers du dossier de travail
// (suivis, modifiés et nouveaux non ignorés) et (2) tous les blobs accessibles de l'historique Git, à la recherche de
// classes de secrets à forte signature. Il rapporte UNIQUEMENT : classe de risque, chemin, identifiant court du blob,
// commit (le plus ancien qui le porte) et nombre d'occurrences. Aucune ligne, aucune valeur n'est imprimée ni stockée.
//
// Limites (dites au rapport) : motifs, pas une preuve d'absence ; une clé sans signature connue n'est pas vue ; les
// fichiers binaires sont ignorés.
//   node scripts/scan-secrets.mjs [--history] [--worktree]   (les deux par défaut)
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const doHistory = args.includes("--history") || !args.includes("--worktree");
const doWorktree = args.includes("--worktree") || !args.includes("--history");

const CLASSES = [
  ["jeton JWT (signé)", /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g],
  ["clé secrète Supabase (sb_secret_)", /sb_secret_[A-Za-z0-9_-]{16,}/g],
  ["clé privée PEM", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["clé d'accès AWS", /\bAKIA[0-9A-Z]{16}\b/g],
  ["URL de base avec mot de passe", /postgres(?:ql)?:\/\/[^:\s/@$`]+:(?![^@\s/]*\$\{)[^@\s/]{6,}@/g],
  ["jeton Slack/GitHub", /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,})\b/g],
  // Affectation de style .env : NOM=valeur longue qui n'est pas un gabarit.
  ["variable d'environnement sensible renseignée", /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|API_KEY|TOKEN|SERVICE_ROLE_KEY)[A-Z0-9_]*[ \t]*=[ \t]*(?!\s*$)(?![\"']?(?:xxx|\$\{|<|votre|your|changeme|exemple|example|\.\.\.|…))[\"']?[A-Za-z0-9_\-+/=.]{20,}/gm],
];
const MAX_BYTES = 2 * 1024 * 1024;

function scan(buffer) {
  if (buffer.length === 0 || buffer.length > MAX_BYTES || buffer.includes(0)) return [];
  const text = buffer.toString("utf8");
  const found = [];
  for (const [name, pattern] of CLASSES) {
    const matches = text.match(pattern);
    if (matches?.length) found.push({ name, count: matches.length });
  }
  return found;
}

const findings = [];
if (doWorktree) {
  const listing = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\0").filter(Boolean);
  for (const path of listing) {
    try {
      for (const hit of scan(readFileSync(path))) findings.push({ where: "dossier de travail", path, ...hit });
    } catch {
      /* fichier supprimé */
    }
  }
  console.log(`Dossier de travail : ${listing.length} fichier(s) examiné(s).`);
}
if (doHistory) {
  const objects = execFileSync("git", ["rev-list", "--objects", "--all"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
  const blobs = new Map();
  for (const line of objects) {
    const space = line.indexOf(" ");
    const sha = space < 0 ? line : line.slice(0, space);
    const path = space < 0 ? "" : line.slice(space + 1);
    if (path) blobs.set(sha, path);
  }
  const shas = [...blobs.keys()];
  const batch = spawnSync("git", ["cat-file", "--batch"], { input: `${shas.join("\n")}\n`, maxBuffer: 1 << 30 });
  const out = batch.stdout;
  let offset = 0;
  let examined = 0;
  while (offset < out.length) {
    const newline = out.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = out.subarray(offset, newline).toString("utf8").split(" ");
    if (header[1] === "missing") {
      offset = newline + 1;
      continue;
    }
    const size = Number(header[2]);
    const content = out.subarray(newline + 1, newline + 1 + size);
    offset = newline + 1 + size + 1;
    if (header[1] !== "blob") continue;
    examined += 1;
    for (const hit of scan(content)) findings.push({ where: "historique", path: blobs.get(header[0]), blob: header[0].slice(0, 10), ...hit });
  }
  console.log(`Historique accessible : ${examined} blob(s) examiné(s).`);
}

const grouped = new Map();
for (const finding of findings) {
  const key = `${finding.where}|${finding.name}|${finding.path}|${finding.blob ?? ""}`;
  grouped.set(key, (grouped.get(key) ?? 0) + finding.count);
}
if (grouped.size === 0) {
  console.log("Aucune classe de secret détectée par ces motifs (ce n'est pas une preuve d'absence).");
} else {
  console.log("Détections (classe, chemin, blob, occurrences — aucune valeur n'est affichée) :");
  for (const [key, count] of grouped) {
    const [where, name, path, blob] = key.split("|");
    console.log(`  [${where}] ${name} — ${path}${blob ? ` (blob ${blob})` : ""} × ${count}`);
  }
}
process.exit(grouped.size === 0 ? 0 : 1);
