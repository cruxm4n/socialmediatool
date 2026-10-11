import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

// Vite est déjà fourni par Vitest. Aucune base, clé, application distante ou serveur Next n'est chargé.
const result = await build({
  configFile: false,
  logLevel: "error",
  resolve: { alias: { "@": resolve("src"), "next/link": resolve("tests/ui/link.tsx") } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { write: false, minify: false, lib: { entry: resolve("tests/ui/calendar-entry.tsx"), name: "CalendarTest", formats: ["iife"] } },
});
const compiled = Array.isArray(result) ? result[0] : result;
const script = compiled.output.find((item) => item.type === "chunk").code;
const chunks = resolve(".next-test/static/chunks");
const styles = (await readdir(chunks)).filter((file) => file.endsWith(".css"));
assert.ok(styles.length, "Compiler d'abord avec ISOLATED_BUILD=1 BUFFER_MODE=mock npm run build");
const css = (await Promise.all(styles.map((file) => readFile(resolve(chunks, file), "utf8")))).join("\n");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Interdire tout réseau dans ce test : les seuls styles sont injectés depuis la compilation locale.
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<html lang="fr"><body><main id="root" style="padding:16px"></main></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  const day = page.getByRole("button", { name: "vendredi 9 octobre 2026 · 1 publication", exact: true });
  await day.waitFor();
  assert.equal(await page.locator('[draggable="true"], [data-movable="true"]').count(), 0, "Le calendrier ne propose aucun déplacement de publication");
  await day.focus();
  await page.keyboard.press("Enter");
  assert.equal(await day.getAttribute("aria-pressed"), "true", "Sélection du jour au clavier");
  assert.ok(await page.getByRole("region", { name: "Publications du jour sélectionné" }).getByRole("link", { name: /Publication dated/ }).isVisible(), "Carte du jour visible sur mobile");
  await page.getByRole("button", { name: "Instagram", exact: true }).click();
  assert.equal(await page.getByText(/publication.*sans date prévue/).count(), 0, "Le compteur sans date respecte le filtre réseau");
  await page.getByRole("button", { name: "Période suivante" }).click();
  assert.equal(await page.getByTestId("calendar-title").innerText(), "Novembre 2026", "Navigation mensuelle");
  await page.getByRole("button", { name: "Aujourd'hui", exact: true }).click();
  assert.equal(await page.getByTestId("calendar-title").innerText(), "Octobre 2026", "Retour à aujourd'hui");
  await page.getByRole("button", { name: "Semaine", exact: true }).click();
  assert.equal(await page.locator('[draggable="true"], [data-movable="true"]').count(), 0, "La vue semaine reste en consultation");
  assert.ok((await page.getByTestId("calendar-title").innerText()).includes("5 – 11 octobre 2026"), "Navigation hebdomadaire");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Absence de débordement en vue semaine à ${width}px`);
  }
  await page.getByRole("button", { name: "Mois", exact: true }).click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Absence de débordement en vue mois à ${width}px`);
  }
  assert.deepEqual(errors, [], "Aucune erreur JavaScript navigateur");
  console.log("Calendrier : clavier, sélection mobile, filtres, navigation mois/semaine, 8 contrôles de largeur (320–1440 px) réussis. Aucun réseau.");
} finally {
  await browser.close();
}
