#!/usr/bin/env node
// Parcours RÉEL depuis l'IMAGE Docker (mission V3, C11) : l'image tourne sous les restrictions de production
// (utilisateur non root, système de fichiers en lecture seule, 512 Mio, 1 CPU, 200 processus, journaux bornés, aucune
// capacité), derrière un Caddy TEMPORAIRE avec certificat de test, dans un réseau Docker dédié, contre une pile
// Supabase isolée de test. Le Caddy et le réseau existants ne sont pas touchés ; tout ce qui est créé ici (étiquette
// cadence.image-journey) est supprimé à la fin.
//
//   node scripts/image-journey.mjs --image cadence-v3:<tag> --stack-env ~/.cadence-v3-stack/env [--keep]
//
// Contrôles : liveness et préparation (/api/ready, y compris sans configuration), administrateur et DEUX clients
// (connexion, pages, isolation), cookies, redirections, médias, en-têtes, protections d'automatisation.
// Sans clé Buffer, sans e-mail : Buffer est simulé, les notifications en simulation (profil pilote).
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

setInterval(() => {}, 1000);
const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const image = option("image");
const envFile = option("stack-env");
const keep = args.includes("--keep");
if (!image || !envFile) {
  console.error("Usage : node scripts/image-journey.mjs --image TAG --stack-env FICHIER [--keep]");
  process.exit(2);
}
const stackEnv = Object.fromEntries(readFileSync(resolve(envFile), "utf8").split("\n").map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
for (const key of ["TEST_SUPABASE_URL", "TEST_SUPABASE_PUBLISHABLE_KEY", "TEST_AUTOMATION_SECRET", "TEST_DB_CONTAINER"]) {
  if (!stackEnv[key]) {
    console.error(`Variable manquante dans ${envFile} : ${key} (recréez la pile avec scripts/test-stack.mjs up --fixture).`);
    process.exit(2);
  }
}

const id = Date.now().toString();
const label = `cadence.image-journey=${id}`;
const network = `cadence-img-${id}`;
const octet = 100 + Math.floor(Math.random() * 100);
const subnet = `172.29.${octet}`;
const hostRules = "MAP cadence.test 127.0.0.1";
const work = mkdtempSync(join(tmpdir(), "cadence-img-"));
chmodSync(work, 0o711);
// Dossiers montés dans les conteneurs (sans capacité DAC_OVERRIDE) : lisibles, et SANS secret. Le fichier de
// configuration de l'application, lui, reste en 0600 hors de tout montage.
const caDir = join(work, "ca");
const confDir = join(work, "conf");
for (const dir of [caDir, confDir]) {
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
}
const sh = (cmd, cmdArgs, options = {}) => execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const created = { containers: [] };
function cleanup() {
  if (keep) {
    console.log(`Ressources conservées (--keep) : étiquette ${label}, réseau ${network}`);
    return;
  }
  for (const name of created.containers) spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  rmSync(work, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (name, probe, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    try {
      if (await probe()) return;
    } catch {
      /* pas encore */
    }
    await pause(1000);
  }
  throw new Error(`${name} n'a pas démarré à temps`);
};

let exitCode = 1;
try {
  const imageInfo = JSON.parse(sh("docker", ["image", "inspect", image]))[0];
  console.log(`Image : ${image} (${imageInfo.Id.slice(0, 19)}…), utilisateur ${imageInfo.Config.User || "(racine)"}, révision ${imageInfo.Config.Labels?.["org.opencontainers.image.revision"] ?? "?"}, contexte ${imageInfo.Config.Labels?.["cadence.context.sha256"]?.slice(0, 16) ?? "?"}…`);
  check("l'image s'exécute sous un utilisateur non root", !!imageInfo.Config.User && imageInfo.Config.User !== "root" && imageInfo.Config.User !== "0", `utilisateur « ${imageInfo.Config.User} »`);
  check("l'image porte sa révision et l'empreinte de son contexte de construction", !!imageInfo.Config.Labels?.["org.opencontainers.image.revision"] && !!imageInfo.Config.Labels?.["cadence.context.sha256"] && imageInfo.Config.Labels["cadence.context.sha256"] !== "inconnue");

  // Réseau dédié. La passerelle Supabase tourne DANS un conteneur relié au réseau de la pile de test (aucun port publié,
  // aucune écoute sur l'hôte) : le pare-feu de l'hôte n'est ni sollicité ni modifié.
  sh("docker", ["network", "create", "--subnet", `${subnet}.0/24`, "--gateway", `${subnet}.1`, "--label", label, network]);
  const stackNetwork = `${stackEnv.TEST_DB_CONTAINER.replace(/-db$/, "")}-net`;
  const gatewayName = `${network}-gw`;
  const gatewayPort = 8000;
  sh("docker", ["run", "-d", "--name", gatewayName, "--label", label, "--network", network, "--ip", `${subnet}.5`, "--network-alias", "cadence-gw", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "100", "--entrypoint", "node",
    "-v", `${resolve("scripts/lib/gateway.mjs")}:/gw/gateway.mjs:ro`, image, "/gw/gateway.mjs", "--listen", String(gatewayPort), "--bind", "0.0.0.0",
    "--auth", "9999", "--auth-host", "cadence-auth", "--rest", "3000", "--rest-host", "cadence-rest", "--storage", "5000", "--storage-host", "cadence-storage"]);
  created.containers.push(gatewayName);
  sh("docker", ["network", "connect", stackNetwork, gatewayName]);

  // Caddy temporaire : certificat interne (CA locale), un seul domaine de test, tout vers l'application ou la passerelle.
  // Le port est le même dans le réseau et sur la boucle locale de l'hôte (le navigateur et l'application l'utilisent).
  const caddyPort = await freePort();
  const caddyfile = `{
  auto_https disable_redirects
  skip_install_trust
}
cadence.test:${caddyPort} {
  tls internal
  encode gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    -Server
  }
  @supabase path /auth/v1/* /rest/v1/* /storage/v1/*
  handle @supabase {
    reverse_proxy cadence-gw:${gatewayPort}
  }
  handle {
    reverse_proxy cadence-web:3000
  }
}
`;
  writeFileSync(join(confDir, "Caddyfile"), caddyfile, { mode: 0o644 }); // aucun secret
  const caddyName = `${network}-caddy`;
  sh("docker", ["run", "-d", "--name", caddyName, "--label", label, "--network", network, "--ip", `${subnet}.2`, "-p", `127.0.0.1:${caddyPort}:${caddyPort}`,
    "--read-only", "--tmpfs", "/data", "--tmpfs", "/config", "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "100",
    "-v", `${confDir}:/etc/caddy:ro`, "caddy:2-alpine"]);
  created.containers.push(caddyName);
  await waitFor("le certificat de test de Caddy", () => {
    // « docker cp » ne lit pas un tmpfs : le certificat racine de TEST est lu par exec (clé privée jamais copiée).
    const out = spawnSync("docker", ["exec", caddyName, "cat", "/data/caddy/pki/authorities/local/root.crt"], { encoding: "utf8" });
    if (out.status !== 0 || !out.stdout.includes("BEGIN CERTIFICATE")) return false;
    writeFileSync(join(caDir, "root.crt"), out.stdout, { mode: 0o644 });
    return true;
  });

  // L'application, sous les restrictions de production, avec une configuration SYNTHÉTIQUE (profil pilote).
  const runId = `img-${id}`;
  const appEnv = [
    `NEXT_PUBLIC_SUPABASE_URL=https://cadence.test:${caddyPort}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${stackEnv.TEST_SUPABASE_PUBLISHABLE_KEY}`,
    `AUTOMATION_SECRET=${stackEnv.TEST_AUTOMATION_SECRET}`,
    "BUFFER_MODE=mock", "CADENCE_ALLOW_SIMULATED_BUFFER=1", `MOCK_RUN_ID=${runId}`, "CADENCE_PROFILE=pilot", "NODE_EXTRA_CA_CERTS=/ca/root.crt", `APP_URL=https://cadence.test:${caddyPort}`,
  ].join("\n");
  writeFileSync(join(work, "app.env"), `${appEnv}\n`, { mode: 0o600 });
  const webName = `${network}-web`;
  const runApp = (name, extraEnv, ip) => {
    sh("docker", ["run", "-d", "--name", name, "--hostname", "cadence-web", "--network-alias", "cadence-web", "--label", label, "--network", network, "--ip", ip,
      "--add-host", `cadence.test:${subnet}.2`, "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/app/.next/cache",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "200", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--log-opt", "max-size=10m", "--log-opt", "max-file=3", ...extraEnv, "-v", `${caDir}:/ca:ro`, image]);
    created.containers.push(name);
  };
  runApp(webName, ["--env-file", join(work, "app.env")], `${subnet}.3`);
  await waitFor("l'application (liveness)", () => {
    const out = spawnSync("docker", ["exec", webName, "wget", "-q", "-O", "-", "http://127.0.0.1:3000/api/health"], { encoding: "utf8" });
    return out.status === 0 && out.stdout.includes('"ok":true');
  });
  const inspected = JSON.parse(sh("docker", ["inspect", webName]))[0];
  check("restrictions appliquées : lecture seule, 512 Mio, 1 CPU, 200 processus, aucune capacité, journaux bornés",
    inspected.HostConfig.ReadonlyRootfs === true && inspected.HostConfig.Memory === 512 * 1024 * 1024 && inspected.HostConfig.NanoCpus === 1_000_000_000
      && inspected.HostConfig.PidsLimit === 200 && inspected.HostConfig.CapDrop?.includes("ALL") && inspected.HostConfig.LogConfig?.Config?.["max-size"] === "10m");
  const uid = sh("docker", ["exec", webName, "id", "-u"]);
  check("le processus tourne sans privilège (uid ≠ 0)", uid !== "0", `uid ${uid}`);
  const write = spawnSync("docker", ["exec", webName, "sh", "-c", "touch /app/ecriture-interdite"], { encoding: "utf8" });
  check("le système de fichiers de l'image est en lecture seule", write.status !== 0);

  const base = `https://cadence.test:${caddyPort}`;
  const agent = async (path, options = {}) => {
    // Résolution locale du domaine de test : curl --resolve avec la CA temporaire.
    const out = spawnSync("curl", ["-sS", "-i", "--max-time", "20", "--cacert", join(caDir, "root.crt"), "--resolve", `cadence.test:${caddyPort}:127.0.0.1`,
      ...(options.method ? ["-X", options.method] : []), ...(options.secret ? ["-H", `x-automation-secret: ${options.secret}`] : []), `${base}${path}`], { encoding: "utf8" });
    const [head, ...rest] = out.stdout.split("\r\n\r\n");
    const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1] ?? 0);
    const headers = Object.fromEntries(head.split("\r\n").slice(1).map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
    return { status, headers, body: rest.join("\r\n\r\n") };
  };

  // Liveness ≠ préparation
  const live = await agent("/api/health");
  check("liveness /api/health : 200 sans configuration ni secret, derrière HTTPS", live.status === 200);
  const ready401 = await agent("/api/ready");
  check("préparation /api/ready : refusée sans secret (aucune information publique)", ready401.status === 401 && !/checks|migration|supabase/i.test(ready401.body));
  const ready = await agent("/api/ready", { secret: stackEnv.TEST_AUTOMATION_SECRET });
  const readyBody = JSON.parse(ready.body || "{}");
  check("préparation /api/ready avec secret : 200, migrations requises en place", ready.status === 200 && readyBody.ready === true,
    `${readyBody.checks?.length ?? 0} contrôles${readyBody.ready ? "" : ` ; en échec : ${(readyBody.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(" | ")}`}`);
  check("la réponse de préparation ne contient ni clé, ni URL, ni secret", !ready.body.includes(stackEnv.TEST_AUTOMATION_SECRET) && !ready.body.includes(stackEnv.TEST_SUPABASE_PUBLISHABLE_KEY) && !/https?:\/\//.test(ready.body));

  // Sans configuration : liveness oui, préparation non (échec explicite)
  const bare = `${network}-bare`;
  runApp(bare, [], `${subnet}.4`);
  await waitFor("l'application sans configuration (liveness)", () => {
    const out = spawnSync("docker", ["exec", bare, "wget", "-q", "-O", "-", "http://127.0.0.1:3000/api/health"], { encoding: "utf8" });
    return out.status === 0 && out.stdout.includes('"ok":true');
  });
  const bareReady = spawnSync("docker", ["exec", bare, "wget", "-S", "-q", "-O", "-", "http://127.0.0.1:3000/api/ready"], { encoding: "utf8" });
  check("sans configuration : liveness 200 mais préparation en échec explicite (503)", /HTTP\/1\.1 503/.test(bareReady.stderr), (bareReady.stderr.match(/HTTP\/1\.1 \d+/) ?? [""])[0]);
  spawnSync("docker", ["rm", "-f", "-v", bare], { stdio: "ignore" });
  created.containers.splice(created.containers.indexOf(bare), 1);

  // Protections d'automatisation et en-têtes
  const syncDenied = await agent("/api/automation/sync", { method: "POST" });
  check("synchronisation sans secret : refusée (401)", syncDenied.status === 401);
  const syncWrong = await agent("/api/automation/sync", { method: "POST", secret: "mauvais" });
  check("synchronisation avec un mauvais secret : refusée (401)", syncWrong.status === 401);
  const urgentDenied = await agent("/api/automation/urgent", { method: "POST" });
  check("traitement urgent sans secret : refusé (401)", urgentDenied.status === 401);
  const login = await agent("/connexion");
  check("en-têtes de sécurité conservés derrière le proxy (cadre interdit, nosniff, referrer, CSP)",
    login.headers["x-frame-options"] === "DENY" && login.headers["x-content-type-options"] === "nosniff" && !!login.headers["referrer-policy"] && /frame-ancestors 'none'/.test(login.headers["content-security-policy"] ?? ""));
  check("aucun en-tête révélant la pile (x-powered-by, server)", !login.headers["x-powered-by"] && !login.headers.server);
  check("HSTS posé par le proxy", /max-age=/.test(login.headers["strict-transport-security"] ?? ""));
  const root = await agent("/");
  check("un visiteur sans session est renvoyé vers la connexion (redirection conservée derrière HTTPS)", [302, 303, 307, 308].includes(root.status) && /\/connexion/.test(root.headers.location ?? ""), `HTTP ${root.status} → ${root.headers.location}`);
  check("la redirection reste sur le domaine HTTPS (pas de retour vers l'adresse interne)", !/cadence-web|172\.29\.|:3000/.test(root.headers.location ?? ""));

  // Synchronisation (Buffer simulé) puis parcours navigateur : administrateur + deux clients
  const sync = await agent("/api/automation/sync", { method: "POST", secret: stackEnv.TEST_AUTOMATION_SECRET });
  check("synchronisation autorisée (Buffer simulé)", sync.status === 200, `HTTP ${sync.status} ${sync.status === 200 ? "" : sync.body.slice(0, 300)}`);

  const browser = await chromium.launch({ args: [`--host-resolver-rules=${hostRules.replace("127.0.0.1", "127.0.0.1")}`] });
  const context = async () => browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
  const loginAs = async (page, user) => {
    page.on("console", (message) => message.type() === "error" && console.log(`  [console ${user}] ${message.text().slice(0, 200)}`));
    page.on("response", (response) => response.status() >= 400 && console.log(`  [http ${user}] ${response.status()} ${response.url().replace(base, "")}`));
    await page.goto("/connexion");
    await page.getByLabel("Adresse e-mail").fill(stackEnv[`TEST_DEMO_${user}_EMAIL`]);
    await page.getByLabel("Mot de passe").fill(stackEnv[`TEST_DEMO_${user}_PASSWORD`]);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 30_000 });
  };
  const problems = [];
  const track = (page, who) => page.on("pageerror", (error) => problems.push(`${who} : ${error.message}`));

  try {
    // Administrateur
    const adminContext = await context();
    const admin = await adminContext.newPage();
    track(admin, "admin");
    await loginAs(admin, "ADMIN");
    check("administrateur : connexion par mot de passe, tableau de bord", admin.url().includes("/admin"), admin.url().replace(base, ""));
    const cookies = await adminContext.cookies();
    const auth = cookies.filter((cookie) => cookie.name.startsWith("sb-"));
    check("cookies de session posés (Supabase)", auth.length > 0, `${auth.length} cookie(s)`);
    check("cookies de session : SameSite défini, chemin racine, domaine limité à l'application", auth.every((cookie) => ["Lax", "Strict"].includes(cookie.sameSite) && cookie.path === "/" && cookie.domain.replace(/^\./, "") === "cadence.test"),
      JSON.stringify(auth.map((cookie) => ({ n: cookie.name.slice(0, 12), s: cookie.secure, h: cookie.httpOnly, ss: cookie.sameSite }))));
    check("cookies de session : attribut Secure (transmis seulement en HTTPS)", auth.every((cookie) => cookie.secure === true));

    // Deux clients
    const pages = {};
    for (const [user, slug] of [["INES", "maison-colibri"], ["SOFIA", "nordwind-cycles"]]) {
      const ctx = await context();
      const page = await ctx.newPage();
      track(page, user);
      await loginAs(page, user);
      check(`client ${user} : connexion, redirigé vers son espace`, page.url().includes(`/client/${slug}`), page.url().replace(base, ""));
      await page.goto(`/client/${slug}/publications`);
      const links = await page.locator("[data-post]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-post")));
      check(`client ${user} : voit ses publications`, links.length > 0, `${links.length} publication(s)`);
      const hrefs = await page.locator(`a[href*="/client/${slug}/publications/"]`).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
      pages[user] = { page, slug, links, hrefs, ctx };
    }
    const ownHref = pages.INES.hrefs[0];
    const foreignId = ownHref?.split("/").pop();
    if (ownHref) {
      const own = await pages.INES.page.goto(ownHref);
      check("client INES : ouvre sa propre publication", own?.status() === 200);
      // L'autre client ouvre l'adresse de cette publication, sous SON espace puis sous celui de l'autre.
      const crossOwn = await pages.SOFIA.page.goto(`/client/nordwind-cycles/publications/${foreignId}`);
      const bodyA = await pages.SOFIA.page.locator("body").innerText();
      check("client SOFIA : la publication d'INES n'est pas affichée sous son espace", crossOwn?.status() === 404 || /introuvable|n'existe pas|not found/i.test(bodyA) || !pages.SOFIA.page.url().includes(foreignId));
      const crossOrg = await pages.SOFIA.page.goto(`/client/maison-colibri/publications/${foreignId}`);
      const bodyB = await pages.SOFIA.page.locator("body").innerText();
      check("client SOFIA : l'espace de l'autre client lui est refusé", crossOrg?.status() === 404 || !pages.SOFIA.page.url().includes("/client/maison-colibri") || /introuvable|accès|refus|interdit/i.test(bodyB), `HTTP ${crossOrg?.status()} ${pages.SOFIA.page.url().replace(base, "")}`);
    }
    // Médias : une URL signée est servie ; l'accès public à un objet privé est refusé.
    const mediaProbe = await admin.evaluate(async (origin) => {
      const response = await fetch(`${origin}/storage/v1/object/public/media/inexistant.png`);
      return response.status;
    }, base);
    check("média privé : l'accès public sans signature est refusé", mediaProbe >= 400, `HTTP ${mediaProbe}`);
    const signed = await admin.evaluate(async (origin) => {
      const urls = [...document.querySelectorAll("img")].map((img) => img.src).filter((src) => src.includes("/storage/v1/object/sign/"));
      if (urls.length === 0) return { found: false };
      const response = await fetch(urls[0]);
      return { found: true, status: response.status, type: response.headers.get("content-type"), origin: new URL(urls[0]).origin === origin };
    }, base);
    check("média : l'URL signée est servie, par le même domaine HTTPS, avec un type image", signed.found && signed.status === 200 && /^image\//.test(signed.type ?? "") && signed.origin, signed.found ? `HTTP ${signed.status} ${signed.type}` : "aucune image signée visible");
    // Un autre client ne reçoit pas ce média : sa session n'ouvre pas l'objet privé de l'autre espace.
    const signedUrl = await admin.evaluate(() => [...document.querySelectorAll("img")].map((img) => img.src).find((src) => src.includes("/storage/v1/object/sign/")) ?? null);
    if (signedUrl) {
      const path = new URL(signedUrl).pathname.replace("/storage/v1/object/sign/", "/storage/v1/object/authenticated/");
      const asSofia = await pages.SOFIA.page.evaluate(async (target) => (await fetch(target, { credentials: "include" })).status, `${base}${path}`);
      check("média privé : refusé à l'autre client (session sans jeton d'accès Storage)", asSofia >= 400, `HTTP ${asSofia}`);
    }
    check("aucune erreur JavaScript pendant le parcours", problems.length === 0, problems.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }

  const failed = results.filter((item) => !item.ok);
  console.log("");
  console.log(failed.length === 0 ? `PARCOURS DEPUIS L'IMAGE VALIDÉ (${results.length} contrôles).` : `PARCOURS EN ÉCHEC : ${failed.length} contrôle(s) sur ${results.length}.`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`Parcours interrompu : ${error.message}`);
  exitCode = 1;
}
process.exit(exitCode);
