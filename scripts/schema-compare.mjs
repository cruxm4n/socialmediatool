#!/usr/bin/env node
// Compare un schéma RÉEL (résultat des deux requêtes de supabase/outils/inventaire_lecture_seule.sql, enregistré dans
// des fichiers texte) aux empreintes ATTENDUES de chaque migration (supabase/outils/schema-attendu/niveau-XXXX.txt,
// produites par scripts/migration-lab.mjs --export-expected). Lecture de fichiers locaux uniquement : aucune connexion,
// aucune réparation. Il dit quel niveau le schéma réel égale, ou duquel il s'écarte le moins, et ce qui diffère.
//
//   node scripts/schema-compare.mjs --structure structure.txt --droits droits.txt
//
// Équivalence du schéma ≠ inscription dans l'historique ≠ exécution d'une migration : voir docs/ALIGNEMENT_SUPABASE.md.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseSnapshot } from "./lib/acl-snapshot.mjs";
import { diffLines } from "./lib/schema-fingerprint.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const structureFile = option("structure");
const rightsFile = option("droits");
const expectedDir = resolve(option("attendu") ?? "supabase/outils/schema-attendu");
if (!structureFile) {
  console.error("Usage : node scripts/schema-compare.mjs --structure FICHIER [--droits FICHIER] [--attendu DOSSIER]");
  process.exit(2);
}
const lines = (path) => readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
const actualStructure = lines(structureFile).filter((line) => /^(column|function|trigger|constraint)\|/.test(line));
const actualRights = rightsFile
  ? [...parseSnapshot(readFileSync(rightsFile, "utf8")).values()].map((row) => `acl|${row.kind}|${row.object}|${row.acl}|${row.detail}`)
  : [];
const actual = [...actualStructure, ...actualRights].sort();

const levels = readdirSync(expectedDir).filter((name) => /^niveau-\d{4}\.txt$/.test(name)).sort();
let best = null;
for (const file of levels) {
  const expectedAll = lines(resolve(expectedDir, file));
  // Sans fichier de droits, seules les lignes de structure sont comparées.
  const expected = (rightsFile ? expectedAll : expectedAll.filter((line) => !line.startsWith("acl|"))).sort();
  const differences = diffLines(expected, actual);
  console.log(`${file.slice(7, 11)} : ${differences.length === 0 ? "ÉQUIVALENT" : `${differences.length} différence(s)`}`);
  if (!best || differences.length < best.differences.length) best = { level: file.slice(7, 11), differences };
}
console.log("");
if (best.differences.length === 0) console.log(`Le schéma réel est équivalent au niveau ${best.level}. (Cela ne dit rien de l'historique de migrations ni des données.)`);
else {
  console.log(`Niveau le plus proche : ${best.level} (${best.differences.length} différence(s)). Aucune réparation n'est appliquée par cet outil.`);
  for (const line of best.differences.slice(0, 40)) console.log(`  ${line}`);
}
process.exit(best.differences.length === 0 ? 0 : 1);
