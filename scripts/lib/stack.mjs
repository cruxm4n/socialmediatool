// Pile Supabase locale ISOLÉE et jetable : base, Auth, Storage, API REST, dans un réseau Docker dédié, ports publiés
// sur 127.0.0.1 seulement. Utilisée par scripts/restore-drill.mjs (répétition de restauration) et
// scripts/test-stack.mjs (suites d'intégration et E2E sans toucher à la pile de test existante).
//
// La configuration (image, variables, commande) est COPIÉE des conteneurs modèles supabase_<service>_<modèle> par
// `docker inspect` (lecture seule). Aucun conteneur, volume ni réseau existant n'est modifié ; seules les ressources
// portant l'étiquette unique de la pile sont créées puis supprimées.
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stdin n'est jamais hérité (un terminal ou un tube ouvert faisait sortir le processus sans message, code 13, pendant
// l'attente d'un conteneur) : sans « input », l'entrée standard des commandes Docker est fermée.
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28, ...("input" in options || "stdio" in options ? {} : { stdio: ["ignore", "pipe", "inherit"] }), ...options });
export const docker = (args, options) => run("docker", args, options);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const b64url = (value) => Buffer.from(value).toString("base64url");
export function signJwt(secret, claims, lifetimeSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: "cadence-local-stack", iat: now, exp: now + lifetimeSeconds, ...claims }));
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

export async function waitFor(label, probe, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if (await probe()) return;
    } catch {
      /* pas encore prêt */
    }
    await sleep(1000);
  }
  throw new Error(`${label} n'a pas démarré à temps.`);
}

/*
 * Variables du conteneur modèle qui peuvent être recopiées : réglages sans secret (liste blanche). Toute autre
 * variable est ABANDONNÉE, et les secrets (mots de passe, clés JWT, URL de base contenant un mot de passe, clés S3)
 * sont GÉNÉRÉS pour la pile : la pile ne reçoit ni ne réutilise aucun secret d'une pile existante (mission V3).
 */
const COPIED_ENV = {
  db: ["JWT_EXP", "LANG", "LANGUAGE", "LC_ALL", "LOCALE_ARCHIVE", "PATH", "PGDATA", "POSTGRES_DB", "POSTGRES_HOST", "POSTGRES_INITDB_ARGS", "POSTGRES_USER", "GRN_PLUGINS_DIR"],
  auth: (key) => key.startsWith("GOTRUE_") && !/SECRET|JWT_KEYS|DATABASE_URL|SMTP_HOST|SMS_TEST_OTP/.test(key) || key === "API_EXTERNAL_URL" || key === "PATH",
  rest: ["PGRST_ADMIN_SERVER_PORT", "PGRST_DB_ANON_ROLE", "PGRST_DB_EXTRA_SEARCH_PATH", "PGRST_DB_MAX_ROWS", "PGRST_DB_SCHEMAS"],
  storage: [
    "DB_MIGRATIONS_FREEZE_AT", "ENABLE_IMAGE_TRANSFORMATION", "FILE_SIZE_LIMIT", "FILE_STORAGE_BACKEND_PATH", "GLOBAL_S3_BUCKET",
    "IMAGE_TRANSFORMATION_ENABLED", "IMGPROXY_URL", "NODE_VERSION", "PATH", "S3_PROTOCOL_ENABLED", "S3_PROTOCOL_PREFIX",
    "SIGNED_UPLOAD_URL_EXPIRATION_TIME", "STORAGE_BACKEND", "STORAGE_S3_REGION", "TENANT_ID", "TUS_URL_PATH", "UPLOAD_FILE_SIZE_LIMIT",
    "UPLOAD_FILE_SIZE_LIMIT_STANDARD", "VECTOR_BUCKET_PROVIDER", "VECTOR_ENABLED", "VECTOR_STORE_MIGRATIONS_ENABLED", "VERSION", "YARN_VERSION",
  ],
};
const allowed = (service, key) => {
  const rule = COPIED_ENV[service];
  return typeof rule === "function" ? rule(key) : rule.includes(key);
};

export class IsolatedStack {
  /**
   * `template` : suffixe des conteneurs modèles « supabase_<service>_<template> » (pile CLI).
   * `templatePrefix` : préfixe de conteneurs « <préfixe>-db|auth|rest|storage » (une pile isolée de cette mission
   * sert alors de modèle : aucune pile préexistante n'est lue).
   */
  constructor({ template = "cadence-supabase-test", templatePrefix = null, name = "stack", minFreeGb = 3 } = {}) {
    const free = statfsSync(tmpdir());
    const freeGb = (free.bavail * free.bsize) / 1024 ** 3;
    if (freeGb < minFreeGb) throw new Error(`Espace disque insuffisant (${freeGb.toFixed(1)} Go libres) : ~${minFreeGb} Go requis.`);
    this.template = template;
    this.templatePrefix = templatePrefix;
    // Secrets propres à cette pile, jamais copiés d'ailleurs (voir COPIED_ENV).
    this.jwtSecret = randomBytes(32).toString("hex");
    this.dbPassword = randomBytes(24).toString("base64url");
    this.stamp = Date.now();
    this.prefix = `cadence-${name}-${this.stamp}`;
    this.label = `cadence.stack=${this.stamp}`;
    this.network = `${this.prefix}-net`;
    this.scratch = mkdtempSync(join(tmpdir(), `cadence-${name}-`));
    this.containers = [];
    this.ports = {};
    this.cleaned = false;
  }

  config(service) {
    const name = this.templatePrefix ? `${this.templatePrefix}-${service}` : `supabase_${service}_${this.template}`;
    let info;
    try {
      info = JSON.parse(docker(["inspect", name]))[0];
    } catch {
      throw new Error(`Conteneur modèle introuvable : ${name}. Démarrez la pile de test locale (supabase start) ou passez --template.`);
    }
    const service_ = service;
    const env = [];
    for (const item of info.Config.Env) {
      const key = item.slice(0, item.indexOf("="));
      if (allowed(service_, key)) env.push(item);
    }
    env.push(...this.generatedEnv(service_, name));
    return { name, image: info.Config.Image, env, entrypoint: info.Config.Entrypoint ?? [], cmd: info.Config.Cmd ?? [] };
  }

  /** Secrets et URL de la pile (générés), par service. `alias` : nom réseau du conteneur de base. */
  generatedEnv(service) {
    const dbHost = "cadence-db";
    const url = (role) => `postgres://${role}:${this.dbPassword}@${dbHost}:5432/postgres`;
    switch (service) {
      case "db":
        return [`POSTGRES_PASSWORD=${this.dbPassword}`, `PGPASSWORD=${this.dbPassword}`, `JWT_SECRET=${this.jwtSecret}`];
      case "auth":
        return [`GOTRUE_JWT_SECRET=${this.jwtSecret}`, `GOTRUE_DB_DATABASE_URL=${url("supabase_auth_admin")}`, "GOTRUE_SMTP_HOST=disabled.invalid"];
      case "rest":
        return [`PGRST_DB_URI=${url("authenticator")}`, `PGRST_JWT_SECRET=${this.jwtSecret}`];
      case "storage":
        return [
          `ANON_KEY=${signJwt(this.jwtSecret, { role: "anon" }, 86400)}`, `SERVICE_KEY=${signJwt(this.jwtSecret, { role: "service_role" }, 86400)}`,
          `AUTH_JWT_SECRET=${this.jwtSecret}`, `DATABASE_URL=${url("supabase_storage_admin")}`, `VECTOR_DATABASE_URL=${url("postgres")}`, "VECTOR_ENABLED=false", "VECTOR_STORE_MIGRATIONS_ENABLED=false",
          `S3_PROTOCOL_ACCESS_KEY_ID=${randomBytes(12).toString("hex")}`, `S3_PROTOCOL_ACCESS_KEY_SECRET=${randomBytes(24).toString("hex")}`,
        ];
      default:
        return [];
    }
  }

  start(service, config, { ports = [], mounts = [], envPatch = (env) => env } = {}) {
    const name = `${this.prefix}-${service}`;
    const envFile = join(this.scratch, `${service}.env`);
    // Valeurs écrites dans un dossier temporaire privé (0700) supprimé à la fin ; jamais affichées.
    run("sh", ["-c", `umask 077; cat > "${envFile}"`], { input: envPatch(config.env).join("\n") + "\n" });
    const args = ["run", "-d", "--name", name, "--label", this.label, "--network", this.network, "--network-alias", `cadence-${service}`, "--env-file", envFile];
    for (const port of ports) args.push("-p", port);
    for (const [source, target] of mounts) args.push("-v", `${source}:${target}`);
    if (config.entrypoint.length > 0) args.push("--entrypoint", config.entrypoint[0]);
    args.push(config.image, ...config.entrypoint.slice(1), ...config.cmd);
    docker(args);
    this.containers.push(name);
    return name;
  }

  /** Démarre la base, puis Auth et Storage (qui migrent leurs schémas). L'API REST se démarre séparément (startRest). */
  async upBase() {
    this.db = this.config("db");
    this.authConfig = this.config("auth");
    this.restConfig = this.config("rest");
    this.storageConfig = this.config("storage");
    // Image retenue pour vider le dossier du Storage (écrit en root) même après une reconstruction de l'objet depuis l'état.
    this.storageImage = this.storageConfig.image;

    docker(["network", "create", "--label", this.label, this.network]);
    this.ports = { auth: await freePort(), storage: await freePort(), rest: await freePort() };
    const storageDir = join(this.scratch, "storage");
    run("mkdir", ["-m", "700", storageDir]);

    this.dbName = this.start("db", this.db);
    // Le serveur « final » : le premier démarrage de l'image initialise (serveur temporaire, socket seulement) puis
    // redémarre PostgreSQL, qui écoute alors en TCP. On attend ce second serveur.
    await waitFor("la base", () => spawnSync("docker", ["exec", this.dbName, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-q"]).status === 0, 240);

    this.authName = this.start("auth", this.authConfig, {
      ports: [`127.0.0.1:${this.ports.auth}:9999`],
    });
    this.storageName = this.start("storage", this.storageConfig, { ports: [`127.0.0.1:${this.ports.storage}:5000`], mounts: [[storageDir, "/mnt"]] });
    await this.waitAuthStorage();
  }

  /** Dernières lignes du journal d'un conteneur de cette pile (diagnostic ; les journaux ne contiennent pas les secrets). */
  tail(name, lines = 12) {
    try {
      return docker(["logs", "--tail", String(lines), name], { stdio: ["ignore", "pipe", "pipe"] }).slice(-1200);
    } catch {
      return "(journal indisponible)";
    }
  }

  /** Démarre la base SEULE (laboratoire de migrations : aucun service Auth, Storage ni API). */
  async upDbOnly() {
    this.db = this.config("db");
    docker(["network", "create", "--label", this.label, this.network]);
    this.dbName = this.start("db", this.db);
    await waitFor("la base", () => spawnSync("docker", ["exec", this.dbName, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-q"], { stdio: "ignore" }).status === 0, 240);
  }

  async waitAuthStorage() {
    try {
      await waitFor("le service Auth", async () => (await fetch(`http://127.0.0.1:${this.ports.auth}/health`, { signal: AbortSignal.timeout(5000) })).ok);
    } catch (error) {
      throw new Error(`${error.message}\n${this.tail(this.authName)}`);
    }
    try {
      await waitFor("le service Storage", async () => (await fetch(`http://127.0.0.1:${this.ports.storage}/status`, { signal: AbortSignal.timeout(5000) })).status < 500);
    } catch (error) {
      throw new Error(`${error.message}\n${this.tail(this.storageName)}`);
    }
  }

  async startRest() {
    this.restName = this.start("rest", this.restConfig, { ports: [`127.0.0.1:${this.ports.rest}:3000`] });
    await waitFor("l'API REST", async () =>
      (await fetch(`http://127.0.0.1:${this.ports.rest}/`, { headers: { Authorization: `Bearer ${this.anonToken}` }, signal: AbortSignal.timeout(5000) })).status < 500);
  }

  get anonToken() {
    return signJwt(this.jwtSecret, { role: "anon" }, 86400);
  }

  get serviceToken() {
    return signJwt(this.jwtSecret, { role: "service_role" }, 86400);
  }

  /** Cleanup idempotent et synchrone : seules les ressources créées ici (étiquette unique) sont supprimées. */
  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const name of this.containers) {
      try {
        docker(["rm", "-f", "-v", name], { stdio: "ignore" });
      } catch {
        /* déjà absent */
      }
    }
    try {
      docker(["network", "rm", this.network], { stdio: "ignore" });
    } catch {
      /* déjà absent */
    }
    // Le Storage écrit en root dans son dossier : on le vide avec la même image avant de supprimer le dossier temporaire.
    try {
      const image = this.storageImage ?? this.storageConfig?.image;
      if (image) docker(["run", "--rm", "--entrypoint", "sh", "-v", `${this.scratch}:/scratch`, image, "-c", "rm -rf /scratch/storage"], { stdio: "ignore" });
    } catch {
      /* le dossier temporaire reste : à supprimer à la main */
    }
    try {
      rmSync(this.scratch, { recursive: true, force: true });
    } catch {
      console.error(`Dossier temporaire à supprimer à la main : ${this.scratch}`);
    }
  }
}
