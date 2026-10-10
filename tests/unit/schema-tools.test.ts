import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ACL_SNAPSHOT_SQL } from "../../scripts/lib/acl-snapshot.mjs";
import { FINGERPRINT_SQL } from "../../scripts/lib/schema-fingerprint.mjs";

/*
 * (Mission V3, C10) Outils d'inventaire en lecture seule : le fichier SQL à lancer plus tard sur un projet réel est
 * identique à la requête du laboratoire, ne contient aucune écriture, et la comparaison hors ligne distingue les niveaux.
 */
const inventory = readFileSync(resolve("supabase/outils/inventaire_lecture_seule.sql"), "utf8");
const expectedDir = resolve("supabase/outils/schema-attendu");

describe("inventaire en lecture seule", () => {
  it("contient exactement la requête d'empreinte du laboratoire et celle des droits", () => {
    expect(inventory).toContain(FINGERPRINT_SQL.trim());
    expect(inventory).toContain(ACL_SNAPSHOT_SQL.trim().replace(/^select set_config[^\n]*\n/, ""));
  });

  it("ne modifie rien : aucune instruction d'écriture, de DDL ni de réparation", () => {
    const code = inventory.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").toLowerCase();
    for (const forbidden of [/\binsert\b/, /\bupdate\b/, /\bdelete\b/, /\bdrop\b/, /\balter\b/, /\bcreate\b/, /\bgrant\b/, /\brevoke\b/, /\btruncate\b/, /migration repair/]) {
      expect(code).not.toMatch(forbidden);
    }
  });

  it("des empreintes attendues existent pour les niveaux 0003, 0008, 0009, 0010, 0011 et 0012", () => {
    expect(readdirSync(expectedDir).sort()).toEqual(["niveau-0003.txt", "niveau-0008.txt", "niveau-0009.txt", "niveau-0010.txt", "niveau-0011.txt", "niveau-0012.txt"]);
  });
});

describe("fraîcheur des empreintes attendues", () => {
  it("le niveau le plus récent contient chaque fonction publique et privée créée par les migrations (régénérer avec migration-lab --export-expected sinon)", () => {
    const migrations = readdirSync(resolve("supabase/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name));
    const created = new Set<string>();
    for (const file of migrations) {
      const text = readFileSync(resolve("supabase/migrations", file), "utf8");
      for (const match of text.matchAll(/create (?:or replace )?function ((?:public|private)\.[a-z_0-9]+)\(/gi)) created.add(match[1].toLowerCase());
    }
    const latest = readFileSync(join(expectedDir, "niveau-0012.txt"), "utf8");
    const present = new Set([...latest.matchAll(/^function\|((?:public|private)\.[a-z_0-9]+)\(/gm)].map((match) => match[1]));
    // Fonctions supprimées par une migration plus récente (drop function) : absentes du niveau final.
    const dropped = new Set<string>();
    for (const file of migrations) {
      const text = readFileSync(resolve("supabase/migrations", file), "utf8");
      for (const match of text.matchAll(/drop function(?: if exists)? ((?:public|private)\.[a-z_0-9]+)\(/gi)) dropped.add(match[1].toLowerCase());
    }
    const missing = [...created].filter((name) => !present.has(name) && !dropped.has(name));
    expect(missing).toEqual([]);
  });
});

describe("comparaison hors ligne", () => {
  const run = (structure: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-schema-"));
    try {
      const path = join(dir, "structure.txt");
      writeFileSync(path, `${structure.join("\n")}\n`);
      const out = spawnSync(process.execPath, [resolve("scripts/schema-compare.mjs"), "--structure", path], { encoding: "utf8" });
      return { code: out.status, text: out.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const structureOf = (level: string) => readFileSync(join(expectedDir, `niveau-${level}.txt`), "utf8").split("\n").filter((line) => /^(column|function|trigger|constraint)\|/.test(line));

  it("reconnaît un schéma équivalent à un niveau précis", () => {
    const result = run(structureOf("0010"));
    expect(result.code).toBe(0);
    expect(result.text).toContain("équivalent au niveau 0010");
  });

  it("un schéma sans la dernière migration n'est jamais déclaré équivalent à la dernière", () => {
    const result = run(structureOf("0010"));
    expect(result.text).toContain("0011 :");
    expect(result.text).not.toContain("0011 : ÉQUIVALENT");
  });

  it("signale les différences d'un schéma modifié à la main, sans rien réparer", () => {
    const altered = structureOf("0011").filter((line) => !line.startsWith("function|public.begin_urgent_run"));
    const result = run(altered);
    expect(result.code).toBe(1);
    expect(result.text).toContain("Aucune réparation n'est appliquée");
    expect(result.text).toContain("begin_urgent_run");
  });
});

