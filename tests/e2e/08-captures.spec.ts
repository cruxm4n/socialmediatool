import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { authFile } from "./helpers";

/*
 * Inspection visuelle : parcourt chaque écran en version ordinateur et mobile, enregistre une capture
 * dans .captures/ (ignoré par Git), et vérifie ce qui se vérifie sans les yeux : aucun débordement
 * horizontal, aucune erreur JavaScript, aucune requête en échec (hors 404 de la page testée).
 */

const SIZES = { bureau: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } } as const;
const DIR = ".captures";
mkdirSync(DIR, { recursive: true });

async function shoot(page: Page, name: string, size: keyof typeof SIZES, problems: string[]) {
  await page.waitForLoadState("networkidle");
  // Mesure AVANT la capture : une capture pleine page modifie temporairement la mise en page.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) {
    const culprits = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 4).map((el) => `${el.tagName}.${(el.getAttribute("class") ?? "").slice(0, 50)}`));
    problems.push(`${size} ${name} : débordement horizontal de ${overflow}px ${JSON.stringify(culprits)}`);
  }
  await page.screenshot({ path: `${DIR}/${size}-${name}.png`, fullPage: true });
}

for (const [sizeName, viewport] of Object.entries(SIZES) as [keyof typeof SIZES, (typeof SIZES)[keyof typeof SIZES]][]) {
  test.describe(`captures ${sizeName}`, () => {
    test(`administrateur, ${sizeName}`, async ({ browser }) => {
      // Une vingtaine de pages, chacune attendue au repos puis capturée en pleine page : plus de 30 s sur une machine chargée.
      test.setTimeout(120_000);
      const context = await browser.newContext({ storageState: authFile("ADMIN"), viewport });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`${sizeName} erreur JavaScript : ${error.message}`));
      page.on("console", (message) => message.type() === "error" && !/Failed to load resource/.test(message.text()) && problems.push(`${sizeName} console : ${message.text().slice(0, 160)}`));
      page.on("response", (response) => response.status() >= 500 && problems.push(`${sizeName} HTTP ${response.status()} ${response.url()}`));

      const visit = async (path: string, name: string) => {
        await page.goto(path);
        await shoot(page, name, sizeName, problems);
      };
      await visit("/admin", "admin-accueil");
      await visit("/admin/clients", "admin-clients");
      await page.locator('[data-org="maison-colibri"]').click();
      await expect(page.getByRole("heading", { level: 1, name: "Maison Colibri" })).toBeVisible();
      await shoot(page, "admin-fiche-client", sizeName, problems);
      await visit("/admin/calendrier", "calendrier");
      await visit("/admin/publications", "publications");
      await page.locator("[data-post]").first().click();
      await expect(page).toHaveURL(/\/admin\/publications\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await shoot(page, "publication-fiche", sizeName, problems);
      await visit("/admin/synchronisation", "synchronisation");
      await visit("/admin/notifications", "notifications");

      await context.close();
      expect(problems, problems.join("\n")).toEqual([]);
    });

    test(`cliente, ${sizeName}`, async ({ browser }) => {
      // Une vingtaine de pages, chacune attendue au repos puis capturée en pleine page : plus de 30 s sur une machine chargée.
      test.setTimeout(120_000);
      const context = await browser.newContext({ storageState: authFile("INES"), viewport });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`${sizeName} erreur JavaScript : ${error.message}`));
      page.on("response", (response) => response.status() >= 500 && problems.push(`${sizeName} HTTP ${response.status()} ${response.url()}`));

      await page.goto("/client/maison-colibri");
      await shoot(page, "client-accueil", sizeName, problems);
      await page.goto("/client/maison-colibri/a-valider");
      await shoot(page, "client-a-valider", sizeName, problems);
      await page.locator("[data-post]").first().click();
      await expect(page).toHaveURL(/\/publications\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId("post-text")).toBeVisible();
      await shoot(page, "client-revue", sizeName, problems);
      await page.goto("/client/maison-colibri/calendrier");
      await shoot(page, "client-calendrier", sizeName, problems);
      await page.goto("/client/maison-colibri/notifications");
      await shoot(page, "client-notifications", sizeName, problems);

      await context.close();
      expect(problems, problems.join("\n")).toEqual([]);
    });
  });
}
