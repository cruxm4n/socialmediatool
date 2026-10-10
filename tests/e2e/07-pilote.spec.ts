import { expect, test, type Page } from "@playwright/test";

import { requireEnv } from "../support/env";
import { authFile, mockBuffer, syncViaApi } from "./helpers";

/*
 * Parcours pilote de bout en bout, dans un vrai navigateur, sur la base de test et un Buffer SIMULÉ :
 * créer un client → lui associer un canal → rédiger dans le Studio → déposer un média (vrai dépôt dans
 * le stockage de test) → envoyer en validation → demande de modification → correction → approbation →
 * programmation → statuts → archivage et restauration du client.
 * Aucun appel à Buffer, aucun e-mail.
 */

const stamp = Date.now();
const clientName = `Pilote ${stamp}`;
const slug = `pilote-${stamp}`;
const channelKey = `pilote-${stamp}`;
const channelName = `Pilote LinkedIn ${stamp}`;
const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let postId = "";

async function as(browser: import("@playwright/test").Browser, user: "ADMIN" | "INES" | "SOFIA"): Promise<Page> {
  return (await browser.newContext({ storageState: authFile(user) })).newPage();
}

test.describe.serial("parcours pilote", () => {
  test("1. l'administrateur crée un client", async ({ browser }) => {
    const page = await as(browser, "ADMIN");
    await page.goto("/admin/clients");
    await page.getByRole("button", { name: "Nouveau client" }).click();
    await page.getByLabel("Nom", { exact: true }).fill(clientName);
    await page.getByLabel("Secteur d'activité").fill("Essai pilote");
    await page.getByRole("button", { name: "Créer le client" }).click();
    await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: clientName })).toBeVisible();
  });

  test("2. un nouveau canal Buffer lui est rattaché, et une cliente a accès", async ({ browser, request }) => {
    await mockBuffer(request, { action: "addChannel", key: channelKey, service: "linkedin", name: channelName });
    await syncViaApi(request);
    const page = await as(browser, "ADMIN");
    await page.goto("/admin");
    await expect(page.getByText(/(n'est|ne sont) rattachés? à aucun client/)).toBeVisible();
    await page.goto("/admin/clients");
    const row = page.locator(`[data-channel="mock-ch-${channelKey}"]`);
    await row.getByRole("combobox").click();
    await page.getByRole("option", { name: clientName }).click();
    await expect(page.getByText("Canal rattaché au client.")).toBeVisible();

    await page.getByRole("link", { name: new RegExp(clientName) }).first().click();
    await page.getByLabel("Donner accès à un nouveau compte").fill(requireEnv("DEMO_INES_EMAIL"));
    await page.getByRole("button", { name: "Donner accès" }).click();
    await expect(page.getByText("Accès accordé.")).toBeVisible();
  });

  test("3. il rédige un contenu dans le Studio et dépose un média", async ({ browser }) => {
    const page = await as(browser, "ADMIN");
    await page.goto("/admin/studio/nouveau");
    await page.getByRole("link", { name: new RegExp(`^${clientName}`) }).click();
    await expect(page).toHaveURL(/\/admin\/studio\/nouveau\?client=/);
    await page.getByLabel("Titre interne").fill(`Contenu pilote ${stamp}`);
    await page.getByText(channelName, { exact: true }).click();
    await page.getByLabel(/^Texte pour/).fill("Notre première publication de test.");
    await page.getByLabel("Ajouter des hashtags").fill("essai, pilote");
    await page.getByLabel("Ajouter des hashtags").press("Enter");
    await page.getByLabel("Jour").fill(inTenDays);

    await page.getByRole("button", { name: "Bibliothèque" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Choisir des fichiers à déposer").setInputFiles({ name: "visuel.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
    await expect(dialog.getByTestId("media-grid").getByText("visuel.png")).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Ajouter visuel.png" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selected-media").locator("li")).toHaveCount(1);

    await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved");
    await expect(page.getByTestId("studio-preview")).toContainText("Notre première publication de test.");
    await expect(page.getByTestId("checks")).toContainText("Prêt à être envoyé en validation.");

    // Régression : la saisie faite pendant la création du contenu (ici, le média) doit être enregistrée.
    await page.goto("/admin/studio");
    await page.getByRole("link", { name: new RegExp(`Contenu pilote ${stamp}`) }).click();
    await expect(page.getByTestId("selected-media").locator("li")).toHaveCount(1);
  });

  test("4. il l'envoie en validation ; le client la voit, demande une modification", async ({ browser, request }) => {
    const admin = await as(browser, "ADMIN");
    await admin.goto("/admin/studio");
    await admin.getByRole("link", { name: new RegExp(`Contenu pilote ${stamp}`) }).click();
    await admin.getByRole("button", { name: "Envoyer en validation" }).click();
    await admin.getByRole("button", { name: "Créer les brouillons dans Buffer" }).click();
    await expect(admin.getByTestId("buffer-state")).toContainText("1 brouillon dans Buffer");
    await syncViaApi(request);

    const client = await as(browser, "INES");
    await client.goto(`/client/${slug}/a-valider`);
    await client.getByRole("link", { name: /Notre première publication de test/ }).click();
    await expect(client).toHaveURL(/\/publications\/[0-9a-f-]{36}$/);
    postId = client.url().split("/").pop()!;
    await expect(client.getByTestId("post-text")).toContainText("#essai #pilote");
    await expect(client.locator("img[src*='/storage/v1/object/sign/media/']").first()).toBeVisible();
    await client.getByRole("button", { name: "Demander des modifications" }).click();
    await client.getByRole("dialog").getByLabel("Votre demande").fill("Merci d'ajouter notre adresse.");
    await client.getByRole("dialog").getByRole("button", { name: "Envoyer la demande" }).click();
    await expect(client.locator('[data-status="changes_requested"]').first()).toBeVisible();

    await admin.goto(`/admin/publications/${postId}`);
    await expect(admin.getByText("« Merci d'ajouter notre adresse. » — Inès Faure")).toBeVisible();
    await expect(admin.getByTestId("studio-link")).toBeVisible();
  });

  test("5. il corrige dans le Studio ; le client approuve ; la publication est programmée", async ({ browser, request }) => {
    const admin = await as(browser, "ADMIN");
    await admin.goto(`/admin/publications/${postId}`);
    await admin.getByTestId("studio-link").click();
    await admin.getByLabel(/^Texte pour/).fill("Notre première publication de test — 12 rue des Essais, Lyon.");
    await expect(admin.getByTestId("save-status")).toHaveAttribute("data-status", "saved");
    await admin.getByRole("button", { name: "Renvoyer en validation" }).click();
    await admin.getByRole("button", { name: "Mettre à jour dans Buffer" }).click();
    await expect(admin.getByTestId("buffer-state")).toContainText("Envoyé en validation");
    await syncViaApi(request);

    const client = await as(browser, "INES");
    await client.goto(`/client/${slug}/publications/${postId}`);
    await expect(client.getByTestId("post-text")).toContainText("12 rue des Essais");
    await expect(client.getByTestId("versions")).toContainText("Version 1");
    await client.getByRole("button", { name: "Approuver" }).first().click();
    await client.getByRole("dialog").getByRole("button", { name: "Confirmer l'approbation" }).click();
    await expect(client.locator('[data-status="scheduled"]').first()).toBeVisible();

    const buffered = await mockBuffer(request, { action: "stats", key: "x" });
    expect(buffered.ok).toBe(true);
  });

  test("6. les statuts concordent côté administrateur et côté client", async ({ browser }) => {
    const admin = await as(browser, "ADMIN");
    await admin.goto(`/admin/publications/${postId}`);
    await expect(admin.getByText("Programmée dans Buffer").first()).toBeVisible();
    await expect(admin.getByText("Version 2 approuvée par Inès Faure")).toBeVisible();
    await admin.goto("/admin");
    await expect(admin.getByTestId("attention-banner")).toBeVisible();
    const client = await as(browser, "INES");
    await client.goto(`/client/${slug}/publications`);
    await expect(client.locator('[data-status="scheduled"]').first()).toBeVisible();
  });

  test("6b. variante adverse : le texte change dans Buffer après l'accord ; la programmation est annulée, l'espace témoin est intact", async ({ browser, request }) => {
    // Espace témoin : un autre client dont rien ne doit bouger pendant ce scénario.
    const witness = await as(browser, "SOFIA");
    await witness.goto("/client/nordwind-cycles/publications");
    const snapshot = async () => witness.locator("[data-post]").evaluateAll((nodes) => nodes.map((node) => `${node.getAttribute("data-post")}|${node.closest("[data-status]")?.getAttribute("data-status") ?? ""}`).sort());
    const before = await snapshot();

    // Retrouver le brouillon créé par le Studio pour ce contenu (identifiant simulé « studio-N »).
    let key = "";
    for (let n = 1; n <= 40 && !key; n += 1) {
      const stats = await mockBuffer(request, { action: "stats", key: `studio-${n}` });
      if (stats.post?.text?.includes("12 rue des Essais")) key = `studio-${n}`;
    }
    expect(key, "brouillon du Studio introuvable dans le Buffer simulé").not.toBe("");
    expect((await mockBuffer(request, { action: "stats", key })).post.status).toBe("scheduled");

    await mockBuffer(request, { action: "editText", key, text: "Texte retouché dans Buffer APRÈS l'accord du client." });
    const result = await syncViaApi(request);
    expect(result.ok).toBe(true);

    // État externe simulé : la programmation a été défaite (brouillon), jamais laissée en place.
    const after = await mockBuffer(request, { action: "stats", key });
    expect(after.post.status).toBe("draft");
    // Le client voit la publication de nouveau à valider, avec le texte EXACT de Buffer ; plus « programmée ».
    const client = await as(browser, "INES");
    await client.goto(`/client/${slug}/publications/${postId}`);
    await expect(client.getByTestId("post-text")).toContainText("Texte retouché dans Buffer APRÈS l'accord du client.");
    await expect(client.locator('[data-status="scheduled"]')).toHaveCount(0);
    await expect(client.getByText("Cette proposition attend votre décision")).toBeVisible();

    await witness.goto("/client/nordwind-cycles/publications");
    expect(await snapshot()).toEqual(before);
  });

  test("7. archiver puis restaurer le client ; archivé, il perd l'accès de ses utilisateurs", async ({ browser }) => {
    const admin = await as(browser, "ADMIN");
    await admin.goto("/admin/clients");
    await admin.getByRole("link", { name: new RegExp(clientName) }).first().click();
    await admin.getByRole("button", { name: "Archiver" }).click();
    await admin.getByRole("button", { name: "Archiver le client" }).click();
    await expect(admin.getByText("Client archivé : ses utilisateurs")).toBeVisible();

    const client = await as(browser, "INES");
    const response = await client.goto(`/client/${slug}`);
    expect(response?.status()).toBe(404);

    await admin.getByRole("button", { name: "Restaurer" }).click();
    await expect(admin.getByText("Client restauré.")).toBeVisible();
    await client.goto(`/client/${slug}`);
    await expect(client.getByRole("heading", { level: 1 })).toBeVisible();
    // La base de test reste propre : le client d'essai est archivé en fin de série.
    await admin.getByRole("button", { name: "Archiver" }).click();
    await admin.getByRole("button", { name: "Archiver le client" }).click();
    await expect(admin.getByText("Client archivé : ses utilisateurs")).toBeVisible();
  });
});
