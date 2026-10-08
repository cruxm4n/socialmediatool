import { expect, test } from "@playwright/test";

import { authFile, login, postLink } from "./helpers";

test.describe("accès et connexion", () => {
  test("un visiteur non connecté est renvoyé vers la connexion", async ({ page }) => {
    for (const path of ["/", "/admin", "/admin/publications", "/client/maison-colibri"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/connexion$/);
    }
  });

  test("un mauvais mot de passe est refusé sans détail", async ({ page }) => {
    await page.goto("/connexion");
    await page.getByLabel("Adresse e-mail").fill("ines@maison-colibri.example");
    await page.getByLabel("Mot de passe").fill("mauvais-mot-de-passe");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.getByText("Adresse e-mail ou mot de passe incorrect.")).toBeVisible();
    await expect(page).toHaveURL(/\/connexion$/);
  });

  test("chaque rôle arrive dans son espace et peut se déconnecter", async ({ page }) => {
    await login(page, "ADMIN");
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole("button", { name: "Menu du profil" }).click();
    await page.getByRole("menuitem", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL(/\/connexion$/);

    await login(page, "SOFIA");
    await expect(page).toHaveURL(/\/client\/nordwind-cycles$/);
    await expect(page.getByRole("heading", { level: 1, name: "Bonjour Sofia" })).toBeVisible();
  });

  test("les réponses portent les en-têtes de sécurité", async ({ request }) => {
    const headers = (await request.get("/connexion")).headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("une session expirée renvoie vers la connexion au lieu d'agir", async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile("HUGO") });
    const page = await context.newPage();
    await page.goto("/client/maison-colibri/publications");
    await page.locator("[data-post]").first().click();
    await expect(page.getByLabel("Ajouter un commentaire")).toBeVisible();

    // La session disparaît (expiration, déconnexion depuis un autre onglet…).
    await context.clearCookies();
    await page.getByLabel("Ajouter un commentaire").fill("Commentaire envoyé sans session.");
    await page.getByRole("button", { name: "Commenter" }).click();
    await expect(page).toHaveURL(/\/connexion$/);

    // Rien n'a été enregistré.
    const check = await browser.newContext({ storageState: authFile("INES") });
    const checkPage = await check.newPage();
    await checkPage.goto("/client/maison-colibri/historique");
    await expect(checkPage.getByText("Commentaire envoyé sans session.")).toHaveCount(0);
    await check.close();
    await context.close();
  });

  test("les routes d'automatisation refusent un appel sans secret", async ({ request }) => {
    expect((await request.post("/api/automation/sync")).status()).toBe(401);
    expect((await request.post("/api/automation/sync", { headers: { "x-automation-secret": "faux" } })).status()).toBe(401);
    expect((await request.post("/api/automation/mock", { data: { action: "stats" } })).status()).toBe(401);
  });
});

test.describe("isolation entre clients", () => {
  test.use({ storageState: authFile("INES") });

  test("un client ne voit que les publications soumises de son organisation", async ({ page }) => {
    await page.goto("/client/maison-colibri/publications");
    await expect(postLink(page, "guji-li")).toBeVisible();
    await expect(postLink(page, "atelier-ig")).toBeVisible();
    // Brouillon de sa propre organisation, non soumis (pas de tag) :
    await expect(postLink(page, "coldbrew-ig")).toHaveCount(0);
    // Publications de l'autre client :
    await expect(postLink(page, "fjord3-li")).toHaveCount(0);
    await expect(page.getByText("Fjord 3")).toHaveCount(0);
  });

  test("l'espace d'un autre client et l'espace admin lui sont fermés", async ({ page }) => {
    const response = await page.goto("/client/nordwind-cycles");
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Cette page n'existe pas.")).toBeVisible();

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/client\/maison-colibri$/);
    await page.goto("/admin/publications");
    await expect(page).toHaveURL(/\/client\/maison-colibri$/);
  });
});

test.describe("isolation : adresse directe d'une publication", () => {
  test("l'adresse d'une publication d'un autre client ne révèle rien", async ({ browser }) => {
    // Sofia (Nordwind) récupère l'identifiant d'une de ses publications…
    const sofia = await browser.newContext({ storageState: authFile("SOFIA") });
    const sofiaPage = await sofia.newPage();
    await sofiaPage.goto("/client/nordwind-cycles/publications");
    const href = await postLink(sofiaPage, "fjord3-li").getAttribute("href");
    const id = href!.split("/").pop()!;
    await sofia.close();

    // … et Inès (Maison Colibri) tente de l'ouvrir dans son propre espace.
    const ines = await browser.newContext({ storageState: authFile("INES") });
    const inesPage = await ines.newPage();
    await inesPage.goto(`/client/maison-colibri/publications/${id}`);
    await expect(inesPage.getByText("Cette page n'existe pas.")).toBeVisible();
    await expect(inesPage.getByText("Fjord 3")).toHaveCount(0);
    await ines.close();
  });
});
