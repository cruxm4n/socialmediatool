import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildDigests, type QueuedNotification } from "@/lib/domain/notifications";

/*
 * Notifications : rédaction des messages (règles pures) et remise (base et webhook remplacés par des doublures).
 * Aucun message réel n'est envoyé par ces tests.
 */

const settings = { bufferMode: "real" as "real" | "mock", notificationMode: "simulate" as "simulate" | "webhook", notificationWebhookUrl: null as string | null };
vi.mock("@/server/env", () => ({
  env: {
    automationSecret: "secret-de-test",
    appUrl: "https://cadence.example",
    notificationWebhookSecret: "secret-webhook",
    get bufferMode() { return settings.bufferMode; },
    get notificationMode() { return settings.notificationMode; },
    get notificationWebhookUrl() { return settings.notificationWebhookUrl; },
  },
}));

let queue: QueuedNotification[] = [];
/** Notifications réservées et pas encore remises ni restituées. */
const held: QueuedNotification[] = [];
let missingMigration = false;
const completions: { ids: string[]; status: string; error?: string }[] = [];
/** Notifications dont le destinataire a perdu ses droits : la base les annule à la revalidation « verify ». */
const revoked = new Set<string>();
const verifications: string[][] = [];
/** true : la revalidation avant remise échoue (base injoignable). */
let failVerify = false;
vi.mock("@/server/supabase/clients", () => ({
  getAutomationClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (missingMigration) return { data: null, error: { code: "PGRST202", message: "absente" } };
      if (name === "claim_notifications") {
        // Comme la base : ce qui est réservé quitte la file jusqu'à sa remise (ou sa restitution).
        const claimedRows = queue;
        queue = [];
        held.push(...claimedRows);
        return { data: claimedRows, error: null };
      }
      const ids = params.p_ids as string[];
      if (params.p_status === "verify" && failVerify) return { data: null, error: { message: "base injoignable" } };
      if (params.p_status === "verify") {
        // Comme la base : les notifications devenues inéligibles sont annulées ; on renvoie combien restent légitimes.
        verifications.push(ids);
        for (const id of ids.filter((item) => revoked.has(item))) held.splice(held.findIndex((item) => item.id === id), 1);
        return { data: ids.filter((id) => !revoked.has(id)).length, error: null };
      }
      if (params.p_status === "released") {
        queue.push(...held.filter((item) => ids.includes(item.id)));
        for (const id of ids) held.splice(held.findIndex((item) => item.id === id), 1);
      }
      completions.push({ ids, status: params.p_status as string, error: params.p_error as string | undefined });
      return { data: 1, error: null };
    },
  }),
}));

const { dispatchNotifications, notificationMode } = await import("@/server/notifications");

const row = (overrides: Partial<QueuedNotification> = {}): QueuedNotification => ({
  id: "n1", kind: "review_requested", recipient_id: "ines", recipient_name: "Inès Martin", recipient_email: "ines@client.fr",
  organization_name: "Maison Colibri", organization_slug: "maison-colibri", timezone: "Europe/Paris",
  post_id: "p1", post_text: "Le Guji est de retour\n\nNouvelle récolte.", service: "instagram", due_at: "2026-10-14T07:00:00.000Z", detail: null,
  ...overrides,
});

const fetchMock = vi.fn();
beforeEach(() => {
  queue = [];
  held.length = 0;
  missingMigration = false;
  completions.length = 0;
  revoked.clear();
  verifications.length = 0;
  failVerify = false;
  Object.assign(settings, { bufferMode: "real", notificationMode: "simulate", notificationWebhookUrl: null });
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});

describe("rédaction des messages", () => {
  it("regroupe en un seul message les publications d'un même destinataire", () => {
    const digests = buildDigests([row(), row({ id: "n2", post_id: "p2", service: "linkedin", post_text: "Atelier dégustation samedi" })], "https://cadence.example/");
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ ids: ["n1", "n2"], subject: "2 publications à valider — Maison Colibri", url: "https://cadence.example/client/maison-colibri/a-valider" });
    expect(digests[0].text).toContain("Bonjour Inès,");
    expect(digests[0].text).toContain("• Instagram · mer. 14 oct. · 09:00 — « Le Guji est de retour »");
    expect(digests[0].text).toContain("https://cadence.example/client/maison-colibri/publications/p2");
  });

  it("sépare les destinataires et les types", () => {
    const digests = buildDigests(
      [row(), row({ id: "n2", recipient_id: "hugo", recipient_name: "Hugo", recipient_email: "hugo@client.fr" }), row({ id: "n3", kind: "schedule_error", recipient_id: "admin", recipient_name: "Louis" })],
      null,
    );
    expect(digests.map((digest) => digest.ids)).toEqual([["n1"], ["n2"], ["n3"]]);
  });

  it("donne à l'administrateur le client, la demande du client et un lien vers l'espace admin", () => {
    const [digest] = buildDigests([row({ kind: "changes_requested", recipient_name: "Louis", detail: "Remplacer la photo." })], "https://cadence.example");
    expect(digest.subject).toBe("Modifications demandées sur une publication — Maison Colibri");
    expect(digest.text).toContain("• Maison Colibri · Instagram");
    expect(digest.text).toContain("Demande : Remplacer la photo.");
    expect(digest.items[0].url).toBe("https://cadence.example/admin/publications/p1");
  });

  it("sans adresse publique configurée, le message ne contient aucun lien", () => {
    const [digest] = buildDigests([row()], null);
    expect(digest.url).toBeNull();
    expect(digest.text).not.toContain("http");
  });

  it("une publication sans date ou sans texte reste lisible", () => {
    const [digest] = buildDigests([row({ due_at: null, post_text: "" })], null);
    expect(digest.text).toContain("sans date — « Post sans texte »");
  });
});

describe("mode de remise", () => {
  it("simulation par défaut ; l'envoi réel exige le réglage explicite, une adresse et le Buffer réel", () => {
    expect(notificationMode()).toBe("simulate");
    settings.notificationMode = "webhook";
    expect(notificationMode()).toBe("simulate");
    settings.notificationWebhookUrl = "https://n8n.example/webhook/cadence";
    expect(notificationMode()).toBe("webhook");
    settings.bufferMode = "mock";
    expect(notificationMode()).toBe("simulate");
  });
});

describe("remise", () => {
  it("en simulation, rien ne sort du serveur et l'historique garde la trace", async () => {
    queue = [row(), row({ id: "n2", post_id: "p2" })];
    expect(await dispatchNotifications()).toEqual({ mode: "simulate", messages: 1, sent: 0, simulated: 2, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(completions).toEqual([{ ids: ["n1", "n2"], status: "simulated", error: undefined }]);
  });

  it("par webhook, envoie un message par destinataire avec le secret, puis marque « envoyée »", async () => {
    Object.assign(settings, { notificationMode: "webhook", notificationWebhookUrl: "https://n8n.example/webhook/cadence" });
    queue = [row(), row({ id: "n2", post_id: "p2" })];
    expect(await dispatchNotifications()).toMatchObject({ mode: "webhook", messages: 1, sent: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://n8n.example/webhook/cadence");
    expect(init.headers["x-cadence-secret"]).toBe("secret-webhook");
    // Contenu minimal par défaut : le sujet ne nomme plus le client (mission V3, C04).
    expect(JSON.parse(init.body)).toMatchObject({ to: "ines@client.fr", subject: "2 publications à valider", kind: "review_requested" });
    expect(completions).toEqual([{ ids: ["n1", "n2"], status: "sent", error: undefined }]);
  });

  it("un refus du webhook marque l'échec avec son motif, sans bloquer les autres destinataires", async () => {
    Object.assign(settings, { notificationMode: "webhook", notificationWebhookUrl: "https://n8n.example/webhook/cadence" });
    queue = [row(), row({ id: "n2", recipient_id: "hugo", recipient_name: "Hugo", recipient_email: "hugo@client.fr" })];
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await dispatchNotifications()).toMatchObject({ sent: 1, failed: 1 });
    // Un message par tour : le second destinataire est restitué, revalidé par la base, puis remis.
    expect(completions.filter((item) => item.status !== "released")).toMatchObject([
      { ids: ["n1"], status: "failed", error: "Le webhook de notification a répondu HTTP 500." },
      { ids: ["n2"], status: "sent" },
    ]);
    expect(completions.filter((item) => item.status === "released")).toEqual([{ ids: ["n2"], status: "released", error: undefined }]);
  });

  it("un destinataire sans adresse e-mail n'est pas envoyé au webhook", async () => {
    Object.assign(settings, { notificationMode: "webhook", notificationWebhookUrl: "https://n8n.example/webhook/cadence" });
    queue = [row({ recipient_email: null })];
    expect(await dispatchNotifications()).toMatchObject({ sent: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("par défaut, le message ne contient aucun texte de publication ni commentaire, seulement un lien", async () => {
    Object.assign(settings, { notificationMode: "webhook", notificationWebhookUrl: "https://n8n.example/webhook/cadence" });
    queue = [row({ detail: "Merci de changer la photo", post_text: "CONFIDENTIEL Le Guji" })];
    await dispatchNotifications();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIEL");
    expect(JSON.stringify(body)).not.toContain("changer la photo");
    expect(body.text).toContain("https://cadence.example/client/maison-colibri/publications/p1");
  });

  it("base sans la migration 0007 : rien à faire, pas d'erreur", async () => {
    missingMigration = true;
    expect(await dispatchNotifications()).toMatchObject({ messages: 0, sent: 0, simulated: 0, failed: 0 });
  });
});

describe("revalidation juste avant la remise (mission V3, C04)", () => {
  const webhook = () => Object.assign(settings, { notificationMode: "webhook", notificationWebhookUrl: "https://n8n.example/webhook/cadence" });
  const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));

  it("un droit retiré entre la réservation et l'appel au prestataire : aucun message à ce destinataire", async () => {
    webhook();
    queue = [row(), row({ id: "n2", recipient_id: "hugo", recipient_name: "Hugo", recipient_email: "hugo@client.fr" })];
    // Le droit de Hugo est retiré pendant la remise lente du premier message.
    fetchMock.mockImplementationOnce(async () => {
      revoked.add("n2");
      return { ok: true, status: 200 };
    });
    expect(await dispatchNotifications()).toMatchObject({ sent: 1, failed: 0 });
    expect(bodies().map((body) => body.to)).toEqual(["ines@client.fr"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("chaque message est revalidé avant son appel : une vérification ne peut jamais être celle d'un autre tour", async () => {
    webhook();
    queue = [row(), row({ id: "n2", recipient_id: "hugo", recipient_name: "Hugo", recipient_email: "hugo@client.fr" })];
    await dispatchNotifications();
    expect(verifications).toEqual([["n1"], ["n2"]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("vérification impossible (base en panne) : rien n'est remis, le lot est rendu à la file", async () => {
    webhook();
    queue = [row()];
    failVerify = true;
    const result = await dispatchNotifications();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ messages: 0, sent: 0 });
  });

  it("tous les champs du message sont génériques : ni texte, ni commentaire, ni nom de client, ni date, ni extrait", async () => {
    webhook();
    queue = [row({ detail: "SECRET-DEMANDE", post_text: "SECRET-TEXTE du post", organization_name: "SECRET-CLIENT SARL", due_at: "2026-12-25T10:00:00.000Z" })];
    await dispatchNotifications();
    const [body] = bodies();
    const dump = JSON.stringify(body);
    for (const secret of ["SECRET-DEMANDE", "SECRET-TEXTE", "SECRET-CLIENT", "2026-12-25", "25 déc"]) expect(dump).not.toContain(secret);
    expect(Object.keys(body).sort()).toEqual(["deliveryId", "items", "kind", "name", "subject", "text", "to", "url"]);
    expect(body.items).toEqual([expect.objectContaining({ title: "", network: "", dueAt: null, organization: null, detail: null })]);
  });

  it("clé d'idempotence stable : le même lot remis de nouveau porte la même clé (le récepteur peut dédoublonner)", async () => {
    webhook();
    queue = [row()];
    await dispatchNotifications();
    queue = [row()];
    await dispatchNotifications();
    const keys = fetchMock.mock.calls.map((call) => call[1].headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(bodies().every((body, index) => body.deliveryId === keys[index])).toBe(true);
  });
});

