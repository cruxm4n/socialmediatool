import { expect, test } from "@playwright/test";

import { authFile, postLink, syncViaApi } from "./helpers";

test.use({ storageState: authFile("ADMIN") });

const DETAIL_URL = /\/admin\/publications\/[0-9a-f-]{36}$/;

test.describe("espace administrateur", () => {
  test("navigue entre toutes les sections", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Bonjour Alex" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Navigation principale" });
    for (const section of ["Calendrier", "Publications", "Clients", "Synchronisation", "Paramètres"]) {
      await nav.getByRole("link", { name: section }).click();
      await expect(page.getByRole("heading", { level: 1, name: section })).toBeVisible();
      await expect(nav.getByRole("link", { name: section })).toHaveAttribute("aria-current", "page");
    }
  });

  test("un indicateur de la vue d'ensemble ouvre la liste filtrée sur ce statut", async ({ page }) => {
    await page.goto("/admin");
    await page.locator('a[href$="statut=error"]').click();
    await expect(page).toHaveURL(/\/admin\/publications\?statut=error$/);
    await expect(page.getByRole("tab", { name: /Erreur/ })).toHaveAttribute("aria-selected", "true");
    await expect(postLink(page, "abonnement-fb")).toBeVisible();
    await expect(postLink(page, "guji-ig")).toHaveCount(0);
  });

  test("le menu mobile donne accès à toutes les sections", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin");
    await expect(page.getByRole("navigation", { name: "Navigation principale" })).toBeHidden();
    await page.getByRole("button", { name: "Ouvrir le menu" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Synchronisation" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Synchronisation" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("aucune page admin ne déborde de l'écran sur mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/admin", "/admin/calendrier", "/admin/publications", "/admin/clients", "/admin/synchronisation", "/admin/parametres"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
    }
  });

  test("chaque publication n'apparaît qu'une fois dans la liste", async ({ page }) => {
    await page.goto("/admin/publications");
    const ids = await page.locator("[data-post]").evaluateAll((links) => links.map((link) => link.getAttribute("data-post")));
    expect(ids.length).toBe(16);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("ne propose plus aucun outil de création de publication", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("button", { name: /Créer une publication|Nouvelle publication/ })).toHaveCount(0);
    await page.goto("/admin/calendrier");
    await expect(page.getByRole("button", { name: /Créer une publication/ })).toHaveCount(0);
    await expect(page.getByText("Glissez un brouillon sur un autre jour pour changer sa date.")).toBeVisible();
  });

  test("le bouton Synchroniser relit Buffer et l'enregistre au journal", async ({ page }) => {
    await page.goto("/admin/synchronisation");
    const before = await page.getByTestId("sync-runs").locator("li").count();
    await page.getByRole("button", { name: "Synchroniser maintenant" }).click();
    await expect(page.getByText("Synchronisation terminée")).toBeVisible();
    await expect(page.getByTestId("sync-runs").locator("li")).toHaveCount(Math.min(before + 1, 25));
    await expect(page.getByTestId("sync-runs").locator("li").first()).toContainText("manuel");
  });

  test("liste les publications avec filtre par client, par statut et recherche", async ({ page }) => {
    await page.goto("/admin/publications");
    await expect(postLink(page, "guji-li")).toBeVisible();
    await expect(postLink(page, "fjord3-li")).toBeVisible();

    await page.getByRole("button", { name: "Sélectionner un client" }).click();
    await page.getByRole("menuitem", { name: "Nordwind Cycles" }).click();
    await expect(postLink(page, "fjord3-li")).toBeVisible();
    await expect(postLink(page, "guji-li")).toHaveCount(0);

    await page.getByRole("tab", { name: /Publié/ }).click();
    await expect(postLink(page, "salon-li")).toBeVisible();
    await expect(postLink(page, "fjord3-li")).toHaveCount(0);

    await page.getByRole("tab", { name: /Toutes/ }).click();
    await page.getByRole("searchbox", { name: "Rechercher une publication" }).fill("boulangerie");
    await expect(postLink(page, "temoignage-fb")).toBeVisible();
    await expect(postLink(page, "fjord3-li")).toHaveCount(0);
  });

  test("un brouillon non tagué explique comment le soumettre", async ({ page }) => {
    await page.goto("/admin/publications");
    await postLink(page, "coldbrew-ig").click();
    await expect(page).toHaveURL(DETAIL_URL);
    await expect(page.locator('[data-status="draft"]')).toBeVisible();
    await expect(page.getByText("ajoutez le tag « À valider » à ce brouillon dans Buffer")).toBeVisible();
    await expect(page.getByText("Aperçu simulé")).toBeVisible();
  });

  test("signale une publication programmée dans Buffer sans validation et une erreur Buffer", async ({ page }) => {
    await page.goto("/admin/publications");
    await postLink(page, "abonnement-li").click();
    await expect(page).toHaveURL(DETAIL_URL);
    await expect(page.getByRole("alert").filter({ hasText: "Programmé dans Buffer sans validation du client" })).toBeVisible();

    await page.goto("/admin/publications");
    await postLink(page, "abonnement-fb").click();
    await expect(page).toHaveURL(DETAIL_URL);
    await expect(page.locator('[data-status="error"]')).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Canal Facebook à reconnecter" })).toBeVisible();
  });

  test("l'admin commente une publication", async ({ page }) => {
    await page.goto("/admin/publications");
    await postLink(page, "essai-li").click();
    await page.getByLabel("Ajouter un commentaire").fill("Visuel définitif attendu lundi.");
    await page.getByRole("button", { name: "Commenter" }).click();
    await expect(page.getByText("Visuel définitif attendu lundi.")).toBeVisible();
    await expect(page.getByText("Alex Martin a commenté")).toBeVisible();
  });
});

test.describe("calendrier", () => {
  test("bascule entre mois et semaine, filtre, et ouvre une fiche", async ({ page }) => {
    await page.goto("/admin/calendrier");
    const title = page.getByTestId("calendar-title");
    const monthTitle = await title.innerText();

    await page.getByRole("button", { name: "Semaine" }).click();
    await expect(title).not.toHaveText(monthTitle);
    await page.getByRole("button", { name: "Mois" }).click();
    await expect(title).toHaveText(monthTitle);

    // La publication est datée à J+6 : elle peut tomber sur le mois suivant.
    const chip = postLink(page, "fjord3-li");
    if ((await chip.count()) === 0) await page.getByRole("button", { name: "Période suivante" }).click();
    await expect(chip.first()).toBeVisible();

    await page.getByRole("combobox", { name: "Filtrer par statut" }).click();
    await page.getByRole("option", { name: "Publié" }).click();
    await expect(chip).toHaveCount(0);
    await page.getByRole("combobox", { name: "Filtrer par statut" }).click();
    await page.getByRole("option", { name: "Tous les statuts" }).click();

    await chip.first().click();
    await expect(page).toHaveURL(/\/admin\/publications\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("post-text")).toContainText("Fjord 3");
  });
});

test.describe("rattachement des canaux", () => {
  test("un canal détaché n'est plus visible du client, puis le redevient après la synchronisation", async ({ page, browser, request }) => {
    await page.goto("/admin/clients");
    const row = page.locator('[data-channel="mock-ch-nordwind-facebook"]');
    const select = row.getByRole("combobox");
    await expect(select).toContainText("Nordwind Cycles");

    await select.click();
    await page.getByRole("option", { name: "Non rattaché" }).click();
    await expect(page.getByText("Canal détaché.")).toBeVisible();

    const sofia = await browser.newContext({ storageState: authFile("SOFIA") });
    const sofiaPage = await sofia.newPage();
    await sofiaPage.goto("/client/nordwind-cycles/publications");
    await expect(postLink(sofiaPage, "fjord3-li")).toBeVisible();
    await expect(postLink(sofiaPage, "temoignage-fb")).toHaveCount(0);

    await select.click();
    await page.getByRole("option", { name: "Nordwind Cycles" }).click();
    await expect(page.getByText("Canal rattaché au client.")).toBeVisible();
    // Le détachement a suspendu la validation en attente (règle d'audit B3) : rien n'est rendu d'office.
    // La demande de validation revient à la synchronisation suivante, le tag étant toujours posé.
    await sofiaPage.reload();
    await expect(postLink(sofiaPage, "temoignage-fb")).toHaveCount(0);
    await syncViaApi(request);
    await sofiaPage.reload();
    await expect(postLink(sofiaPage, "temoignage-fb")).toBeVisible();
    await sofia.close();
  });
});
