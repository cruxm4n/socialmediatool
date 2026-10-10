import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * (Mission V3, C12) scripts/lock-test-ports.sh éprouvé avec de FAUX iptables / ip6tables / ip : aucune règle réelle
 * n'est posée, le script n'est jamais exécuté contre le pare-feu de la machine. On vérifie l'idempotence, la
 * couverture IPv4/IPv6, le ciblage des seuls ports de test, et que « règle absente » ≠ « vérification impossible ».
 */
let dir: string;
const script = resolve("scripts/lock-test-ports.sh");

function fakeTool(name: string, family: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
state="${dir}/${family}.rules"
touch "$state"
case "\${FAKE_FAIL:-}" in
  permission) echo "${name}: can't initialize ${name} table 'filter': Permission denied (you must be root)" >&2; exit 4 ;;
  nochain) echo "${name}: No chain/target/match by that name." >&2; exit 1 ;;
  missing) echo "${name}: command not found" >&2; exit 127 ;;
esac
op="$1"; shift
chain="$1"; shift
case "$op" in
  -C) rule="$*"; if grep -qxF -- "$rule" "$state"; then exit 0; fi; echo "${name}: Bad rule (does a matching rule exist in that chain?)." >&2; exit 1 ;;
  -I) shift; echo "$*" >> "$state"; exit 0 ;;
  -D) rule="$*"; if grep -qxF -- "$rule" "$state"; then grep -vxF -- "$rule" "$state" > "$state.new"; mv "$state.new" "$state"; exit 0; fi; exit 1 ;;
esac
exit 2
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function fakeIp(): string {
  const path = join(dir, "ip");
  writeFileSync(
    path,
    `#!/bin/sh
cat <<'EOT'
1: lo: <LOOPBACK,UP> mtu 65536
2: enp0s6: <BROADCAST,MULTICAST,UP> mtu 9000
3: docker0: <BROADCAST,MULTICAST,UP> mtu 1500
4: br-1a2b3c4d5e6f: <BROADCAST,MULTICAST,UP> mtu 1500
5: veth9f8e7d@if6: <BROADCAST,MULTICAST,UP> mtu 1500
6: wg0: <POINTOPOINT,NOARP,UP> mtu 1420
EOT
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const run = (args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", IPTABLES: join(dir, "iptables"), IP6TABLES: join(dir, "ip6tables"), IP: join(dir, "ip"), ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};
const rules = (family: "v4" | "v6") => (existsSync(join(dir, `${family}.rules`)) ? readFileSync(join(dir, `${family}.rules`), "utf8").split("\n").filter(Boolean) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cadence-ports-"));
  fakeTool("iptables", "v4");
  fakeTool("ip6tables", "v6");
  fakeIp();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lock-test-ports.sh", () => {
  it("plan : n'exécute rien, couvre IPv4 et IPv6, uniquement les interfaces externes et les ports de test", () => {
    const result = run(["plan"]);
    expect(result.code).toBe(0);
    expect(rules("v4")).toEqual([]);
    expect(rules("v6")).toEqual([]);
    expect(result.out).toMatch(/IPv4 : .*-i enp0s6 .*54321:54322/);
    expect(result.out).toMatch(/IPv6 : .*-i enp0s6 .*54321:54322/);
    expect(result.out).toMatch(/-i wg0 /);
    for (const internal of ["-i lo ", "-i docker0 ", "-i br-1a2b3c4d5e6f ", "-i veth9f8e7d "]) expect(result.out).not.toContain(internal);
    expect(result.out).not.toMatch(/\b(80|443|5678)\b/);
  });

  it("apply exige une confirmation explicite du propriétaire", () => {
    const result = run(["apply"]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("CADENCE_FIREWALL_CONFIRM=oui");
    expect(rules("v4")).toEqual([]);
  });

  it("apply est idempotent : une seule règle par interface externe et par famille, jamais de doublon", () => {
    const env = { CADENCE_FIREWALL_CONFIRM: "oui" };
    expect(run(["apply"], env).code).toBe(0);
    const once = [rules("v4"), rules("v6")];
    expect(once[0]).toHaveLength(2); // enp0s6, wg0
    expect(once[1]).toHaveLength(2);
    expect(run(["apply"], env).code).toBe(0);
    expect([rules("v4"), rules("v6")]).toEqual(once);
    for (const rule of [...once[0], ...once[1]]) {
      expect(rule).toContain("--ctorigdstport 54321:54322");
      expect(rule).toContain("-p tcp");
      expect(rule).toContain("-j DROP");
    }
  });

  it("check : présente → 0 ; absente → 1 ; les deux sont distingués de « impossible » → 3", () => {
    expect(run(["check"]).code).toBe(1);
    expect(run(["check"]).out).toContain("règle ABSENTE");
    run(["apply"], { CADENCE_FIREWALL_CONFIRM: "oui" });
    const present = run(["check"]);
    expect(present.code).toBe(0);
    expect(present.out).toContain("règle PRÉSENTE");
  });

  it("droits insuffisants, chaîne inexistante, outil absent : « vérification impossible », jamais « règle absente »", () => {
    for (const fail of ["permission", "nochain", "missing"]) {
      const result = run(["check"], { FAKE_FAIL: fail });
      expect(result.code, fail).toBe(3);
      expect(result.out, fail).toContain("vérification IMPOSSIBLE");
      expect(result.out, fail).not.toContain("règle ABSENTE");
    }
  });

  it("IPv6 non vérifiable : l'IPv4 reste rapporté, le code global est 3 (jamais un faux « tout est fermé »)", () => {
    run(["apply"], { CADENCE_FIREWALL_CONFIRM: "oui" });
    const result = run(["check"], { IP6TABLES: join(dir, "absent-ip6tables") });
    expect(result.code).toBe(3);
    expect(result.out).toContain("IPv4 enp0s6 : règle PRÉSENTE");
    expect(result.out).toMatch(/IPv6 .*IMPOSSIBLE/);
  });

  it("remove retire exactement ces règles (idempotent) et rien d'autre", () => {
    writeFileSync(join(dir, "v4.rules"), "-i enp0s6 -p tcp --dport 443 -j ACCEPT\n");
    run(["apply"], { CADENCE_FIREWALL_CONFIRM: "oui" });
    expect(rules("v4")).toHaveLength(3);
    expect(run(["remove"]).code).toBe(0);
    expect(rules("v4")).toEqual(["-i enp0s6 -p tcp --dport 443 -j ACCEPT"]);
    expect(rules("v6")).toEqual([]);
    expect(run(["remove"]).code).toBe(0);
    expect(rules("v4")).toEqual(["-i enp0s6 -p tcp --dport 443 -j ACCEPT"]);
  });

  it("refuse tout port hors de la plage de test (80, 443…)", () => {
    for (const ports of ["80", "443", "54321:55000", "1:65535", "abc"]) {
      const result = run(["plan"], { PORTS: ports });
      expect(result.code, ports).toBe(2);
    }
  });
});
