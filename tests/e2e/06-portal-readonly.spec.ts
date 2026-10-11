import { expect, test } from "@playwright/test";

import { authFile, mockBuffer, postLink, syncViaApi } from "./helpers";

test("les anciens favoris Studio ouvrent les publications, sans éditeur ni navigation Studio", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("ADMIN") });
  const page = await context.newPage();
  for (const path of ["/admin/studio", "/admin/studio/nouveau", "/admin/studio/medias", "/admin/studio/11111111-1111-4111-8111-111111111111"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin\/publications$/);
    await expect(page.locator('a[href^="/admin/studio"]')).toHaveCount(0);
    await expect(page.getByLabel("Titre interne")).toHaveCount(0);
  }
  await context.close();
});

test("le calendrier administrateur permet de consulter sans déplacer ni programmer", async ({ browser, request }) => {
  await syncViaApi(request);
  const before = await mockBuffer(request, { action: "stats", key: "guji-li" });
  const context = await browser.newContext({ storageState: authFile("ADMIN") });
  const page = await context.newPage();
  await page.goto("/admin/calendrier");
  await expect(page.getByText("Les dates se modifient dans Buffer.", { exact: true })).toBeVisible();
  await expect(page.locator('[draggable="true"], [data-movable="true"]')).toHaveCount(0);
  const target = page.locator("[data-day]").first();
  await target.dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await page.getByRole("button", { name: "Semaine", exact: true }).click();
  await expect(page.locator('[draggable="true"], [data-movable="true"]')).toHaveCount(0);
  expect((await mockBuffer(request, { action: "stats", key: "guji-li" })).scheduleCalls).toBe(before.scheduleCalls);
  await page.goto("/admin/publications");
  await postLink(page, "guji-li").click();
  await expect(page.getByTestId("post-text")).toBeVisible();
  await expect(page.getByTestId("studio-link")).toHaveCount(0);
  // Les publications simulées ne proposent jamais de lien vers un vrai compte Buffer.
  await expect(page.getByTestId("buffer-link")).toHaveCount(0);
  await context.close();
});

test("le retrait du Studio conserve la protection administrateur", async ({ browser }) => {
  const context = await browser.newContext({ storageState: authFile("INES") });
  const page = await context.newPage();
  await page.goto("/admin/studio/nouveau");
  await expect(page).toHaveURL(/\/client\/maison-colibri/);
  await page.goto("/client/maison-colibri/calendrier");
  await expect(page.locator('[draggable="true"], [data-movable="true"]')).toHaveCount(0);
  await context.close();
});
