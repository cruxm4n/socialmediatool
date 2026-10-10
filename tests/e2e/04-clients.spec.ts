import { expect, test } from "@playwright/test";

import { authFile } from "./helpers";

/*
 * Gestion des clients par l'administrateur. Demande la migration 0005 sur la base de test.
 * Le transfert de canal entre clients n'est pas rejoué ici : il masquerait durablement l'historique
 * des clients de démonstration. Il est couvert par tests/sql/gestion-clients.test.ts.
 */

test.use({ storageState: authFile("ADMIN") });

test.describe("gestion des clients", () => {
  test("crée un client, le modifie, l'archive puis le restaure", async ({ page }) => {
    const name = `Client essai ${Date.now()}`;
    await page.goto("/admin/clients");
    await page.getByRole("button", { name: "Nouveau client" }).click();
    await page.getByLabel("Nom", { exact: true }).fill(name);
    await page.getByLabel("Secteur d'activité").fill("Essais");
    await page.getByRole("button", { name: "Créer le client" }).click();

    await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText("Aucun canal attribué")).toBeVisible();
    await expect(page.getByText("Aucun utilisateur n'a accès")).toBeVisible();

    await page.getByRole("button", { name: "Modifier" }).click();
    await page.getByLabel("Nom", { exact: true }).fill(`${name} bis`);
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `${name} bis` })).toBeVisible();

    await page.getByRole("button", { name: "Archiver" }).click();
    await page.getByRole("button", { name: "Archiver le client" }).click();
    await expect(page.getByText("Client archivé : ses utilisateurs")).toBeVisible();

    await page.goto("/admin/clients");
    await expect(page.getByRole("link", { name: new RegExp(`${name} bis`) })).toHaveCount(0);
    await page.getByRole("button", { name: /Archivés/ }).click();
    await page.getByRole("link", { name: new RegExp(`${name} bis`) }).click();
    await page.getByRole("button", { name: "Restaurer" }).click();
    await expect(page.getByText("Client restauré.")).toBeVisible();
    // Laisse la base propre pour les séries suivantes : le client d'essai reste archivé.
    await page.getByRole("button", { name: "Archiver" }).click();
    await page.getByRole("button", { name: "Archiver le client" }).click();
    await expect(page.getByText("Client archivé : ses utilisateurs")).toBeVisible();
  });

  test("refuse un nom déjà pris et un e-mail inconnu, avec un message clair", async ({ page }) => {
    await page.goto("/admin/clients");
    await page.getByRole("button", { name: "Nouveau client" }).click();
    await page.getByLabel("Nom", { exact: true }).fill("maison colibri");
    await page.getByRole("button", { name: "Créer le client" }).click();
    await expect(page.getByRole("alert")).toContainText("Un client porte déjà ce nom.");
    await page.getByRole("button", { name: "Annuler" }).click();

    await page.locator('[data-org="maison-colibri"]').click();
    await expect(page.getByRole("heading", { level: 1, name: "Maison Colibri" })).toBeVisible();
    await page.getByLabel("Donner accès à un nouveau compte").fill("personne@inconnu.example");
    await page.getByRole("button", { name: "Donner accès" }).click();
    await expect(page.getByText("Aucun compte ne correspond à cet e-mail.")).toBeVisible();
  });

  test("la fiche client ne déborde pas sur mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/clients");
    await page.locator('[data-org="maison-colibri"]').click();
    await expect(page.getByRole("heading", { level: 1, name: "Maison Colibri" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe("accès à la gestion des clients", () => {
  test.use({ storageState: authFile("INES") });

  test("un client n'accède ni à la liste ni à une fiche client", async ({ page }) => {
    await page.goto("/admin/clients");
    await expect(page).toHaveURL(/\/client\/maison-colibri/);
    await page.goto("/admin/clients/00000000-0000-0000-0000-000000000000");
    await expect(page).toHaveURL(/\/client\/maison-colibri/);
  });
});
