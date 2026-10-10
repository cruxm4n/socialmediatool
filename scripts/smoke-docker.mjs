#!/usr/bin/env node
// Vérification rapide d'une instance de Cadence déjà démarrée (image Docker, par exemple) contre la base de TEST :
// connexion, proxy, Studio, dépôt d'un média dans le stockage. Aucun appel à Buffer réel (le mode « mock » est exigé).
// Usage : BASE_URL=http://127.0.0.1:3200 node scripts/smoke-docker.mjs   (variables TEST_* lues dans .env.test.local)
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const env = Object.fromEntries(readFileSync(".env.test.local", "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const base = process.env.BASE_URL ?? "http://127.0.0.1:3200";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Refusé : ce contrôle ne vise que l'instance locale.");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`erreur JavaScript : ${e.message}`));
const step = (label) => console.log(`✓ ${label}`);
try {
  await page.goto(`${base}/connexion`);
  await page.getByLabel("Adresse e-mail").fill(env.TEST_DEMO_ADMIN_EMAIL);
  await page.getByLabel("Mot de passe").fill(env.TEST_DEMO_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL(`${base}/admin`);
  step("connexion administrateur, redirection vers /admin (le rafraîchissement de session fonctionne)");

  await page.goto(`${base}/admin/studio/medias`);
  await page.getByRole("button", { name: "Maison Colibri" }).click();
  await page.getByLabel("Choisir des fichiers à déposer").setInputFiles({ name: `smoke-${Date.now()}.png`, mimeType: "image/png", buffer: PNG });
  await page.getByText(/smoke-\d+\.png/).first().waitFor({ timeout: 20_000 });
  step("dépôt d'un média dans le stockage depuis le navigateur");

  const page2 = await browser.newPage();
  const response = await page2.goto(`${base}/admin`);
  if (!page2.url().includes("/connexion")) throw new Error("Un visiteur sans session n'a pas été renvoyé vers la connexion.");
  step(`visiteur sans session renvoyé vers la connexion (HTTP ${response?.status()})`);
  if (problems.length) throw new Error(problems.join("\n"));
  console.log("Contrôle réussi.");
} finally {
  await browser.close();
}
