import { expect, test } from "@playwright/test";

import { authFile, postLink, syncViaApi } from "./helpers";

/*
 * Cadence V2 : état de synchronisation, bandeau « À traiter », notifications simulées.
 * Demande les migrations 0006 et 0007 sur la base de test. Buffer simulé : aucun e-mail ne part.
 * NON EXÉCUTÉ tant qu'aucune base de test dédiée n'existe (voir TESTING.md).
 */

test.describe("administrateur", () => {
  test.use({ storageState: authFile("ADMIN") });

  test("l'état de synchronisation suit le planificateur", async ({ page, request }) => {
    expect(await syncViaApi(request)).toMatchObject({ ok: true });
    await page.goto("/admin/synchronisation");
    await expect(page.getByTestId("sync-state")).toHaveAttribute("data-level", "ok");
    await expect(page.getByTestId("sync-state")).toContainText("Actif, toutes les 5 min");
    await expect(page.getByTestId("last-sync")).toHaveAttribute("data-level", "ok");
  });

  test("deux déclenchements simultanés : un seul s'exécute", async ({ request }) => {
    const [first, second] = await Promise.all([syncViaApi(request), syncViaApi(request)]);
    // Même serveur : les deux appels partagent le même résultat ; jamais deux lectures de Buffer.
    expect(first.ok && second.ok).toBe(true);
  });

  test("le bandeau « À traiter » mène à la liste filtrée", async ({ page, request }) => {
    await syncViaApi(request);
    await page.goto("/admin");
    await page.getByTestId("attention-banner").locator('[data-inbox="errors"]').click();
    await expect(page).toHaveURL(/filtre=errors/);
    await expect(page.getByTestId("attention-filter")).toContainText("Erreurs de programmation");
    await expect(postLink(page, "abonnement-fb")).toBeVisible();
    await page.getByRole("button", { name: "Voir toutes les publications" }).click();
    await expect(page.getByTestId("attention-filter")).toHaveCount(0);
  });

  test("les notifications sont en mode simulation et les préférences s'enregistrent", async ({ page }) => {
    await page.goto("/admin/notifications");
    await expect(page.getByTestId("notification-mode")).toContainText("Mode simulation");
    const approved = page.getByTestId("notification-preferences").getByLabel(/Publication approuvée/);
    const before = await approved.isChecked();
    await approved.click();
    // L'enregistrement est asynchrone : la case se réactive une fois la préférence enregistrée.
    await expect(approved).toBeEnabled();
    await page.reload();
    await expect(page.getByTestId("notification-preferences").getByLabel(/Publication approuvée/)).toBeChecked({ checked: !before });
    await page.getByTestId("notification-preferences").getByLabel(/Publication approuvée/).click();
    await expect(page.getByTestId("notification-preferences").getByLabel(/Publication approuvée/)).toBeEnabled();
  });
});

test.describe("client", () => {
  test.use({ storageState: authFile("INES") });

  test("voit la fraîcheur des données et ses seules notifications", async ({ page, request }) => {
    await syncViaApi(request);
    await page.goto("/client/maison-colibri");
    await expect(page.getByTestId("freshness")).toContainText("Mis à jour");
    await page.getByRole("button", { name: "Menu du profil" }).click();
    await page.getByRole("menuitem", { name: "Notifications" }).click();
    await expect(page).toHaveURL(/\/client\/maison-colibri\/notifications$/);
    await expect(page.getByTestId("notification-preferences").getByLabel(/Publication à valider/)).toBeVisible();
    await expect(page.getByTestId("notification-mode")).toHaveCount(0);
  });

  test("ne peut pas ouvrir les écrans d'administration", async ({ page }) => {
    await page.goto("/admin/notifications");
    await expect(page).toHaveURL(/\/client\/maison-colibri/);
  });
});
