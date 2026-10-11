import { expect, test, type Browser, type Page } from "@playwright/test";

import { authFile } from "./helpers";

/*
 * Création du compte d'un utilisateur client par l'administrateur, avec le vrai service des comptes de la pile de test :
 * mot de passe généré, affiché à l'administrateur, réaffichable, renouvelable. Sans clé d'administration des comptes
 * dans l'environnement de test, le parcours est ignoré (et le dit).
 */

const EMAIL = `camille.${Date.now()}@test.example`;
const NAME = "Camille Durand";

async function openClient(page: Page) {
  await page.goto("/admin/clients");
  await page.getByRole("link", { name: /Nordwind Cycles/ }).first().click();
  await expect(page.getByRole("heading", { name: "Utilisateurs" })).toBeVisible();
}

async function signIn(browser: Browser, password: string) {
  // Session vierge : sans cela le contexte hérite de la session administrateur du fichier.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(EMAIL);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  return { context, page };
}

test.describe.serial("comptes des utilisateurs clients", () => {
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, "clé d'administration des comptes absente de la pile de test");
  test.use({ storageState: authFile("ADMIN") });
  let password = "";

  test("l'administrateur crée un compte : le mot de passe généré lui est montré, et la personne se connecte à SON espace seulement", async ({ page, browser }) => {
    await openClient(page);
    await page.getByLabel("Donner accès à un nouveau compte").fill(EMAIL);
    await page.getByLabel("Prénom et nom").fill(NAME);
    await page.getByLabel("Fonction").fill("Marketing");
    await page.getByRole("button", { name: "Donner accès" }).click();

    const dialog = page.getByTestId("mot-de-passe");
    await expect(dialog).toContainText(EMAIL);
    password = (await dialog.getByTestId("mot-de-passe-valeur").innerText()).trim();
    expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
    await dialog.getByRole("button", { name: "Fermer" }).first().click();
    await expect(page.locator(`[data-member="${EMAIL}"]`)).toContainText(NAME);

    const session = await signIn(browser, password);
    await expect(session.page).toHaveURL(/\/client\/nordwind-cycles/);
    // L'espace d'un autre client et l'administration lui sont fermés.
    expect((await session.page.goto("/client/maison-colibri"))?.status()).toBe(404);
    await session.page.goto("/admin");
    await expect(session.page).toHaveURL(/\/client\/nordwind-cycles/);
    await session.context.close();
  });

  test("le mot de passe se réaffiche à l'identique, puis se renouvelle : l'ancien ne fonctionne plus", async ({ page, browser }) => {
    await openClient(page);
    await page.locator(`[data-member="${EMAIL}"]`).getByRole("button", { name: `Mot de passe de ${NAME}` }).click();
    const dialog = page.getByTestId("mot-de-passe");
    await expect(dialog.getByTestId("mot-de-passe-valeur")).toHaveText(password);

    await dialog.getByRole("button", { name: "Générer un nouveau mot de passe" }).click();
    await dialog.getByRole("button", { name: /Confirmer/ }).click();
    await expect(dialog).toContainText("L'ancien ne fonctionne plus");
    const renewed = (await dialog.getByTestId("mot-de-passe-valeur").innerText()).trim();
    expect(renewed).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
    expect(renewed).not.toBe(password);

    const old = await signIn(browser, password);
    await expect(old.page.getByText("Adresse e-mail ou mot de passe incorrect.")).toBeVisible();
    await old.context.close();
    const fresh = await signIn(browser, renewed);
    await expect(fresh.page).toHaveURL(/\/client\/nordwind-cycles/);
    await fresh.context.close();
  });

  test("la même adresse ne crée pas un second compte et ne change pas le mot de passe en place", async ({ page }) => {
    // Accès retiré, puis redonné avec la même adresse : le compte existant est réutilisé tel quel.
    await openClient(page);
    await page.locator(`[data-member="${EMAIL}"]`).getByRole("button", { name: `Retirer l'accès de ${NAME}` }).click();
    await page.getByRole("button", { name: "Retirer l'accès" }).click();
    await expect(page.locator(`[data-member="${EMAIL}"]`)).toHaveCount(0);
    await page.getByLabel("Donner accès à un nouveau compte").fill(EMAIL);
    await page.getByRole("button", { name: "Donner accès" }).click();
    await expect(page.getByText("Accès accordé à ce compte existant. Son mot de passe n'a pas été changé.")).toBeVisible();
    await expect(page.getByTestId("mot-de-passe")).toHaveCount(0);
    await expect(page.locator(`[data-member="${EMAIL}"]`)).toContainText(NAME);
  });

  test("un client ne peut ni créer un compte ni lire un mot de passe", async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile("INES") });
    const page = await context.newPage();
    await page.goto("/admin/clients");
    await expect(page).toHaveURL(/\/client\//);
    await expect(page.getByRole("button", { name: "Donner accès" })).toHaveCount(0);
    await context.close();
  });
});
