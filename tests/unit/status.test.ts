import { describe, expect, it } from "vitest";

import { canDecide, deriveStatus, getPostAlerts, hasUsableDueDate, postTitle, safeExternalUrl } from "@/lib/domain/status";
import { buildPostViews, redactPostDiagnostics } from "@/lib/view";
import type { Post } from "@/lib/types";

const NOW = "2026-10-08T08:00:00.000Z";
const FUTURE = "2026-10-20T08:00:00.000Z";

type StatusFields = Pick<Post, "bufferStatus" | "approvalStatus" | "scheduleState">;
const of = (overrides: Partial<StatusFields>): StatusFields => ({
  bufferStatus: "draft",
  approvalStatus: "none",
  scheduleState: "idle",
  ...overrides,
});

describe("statut affiché", () => {
  it("suit la validation tant que le post est un brouillon dans Buffer", () => {
    expect(deriveStatus(of({}))).toBe("draft");
    expect(deriveStatus(of({ approvalStatus: "pending" }))).toBe("pending_approval");
    expect(deriveStatus(of({ approvalStatus: "changes_requested" }))).toBe("changes_requested");
    expect(deriveStatus(of({ approvalStatus: "approved" }))).toBe("approved");
  });

  it("donne la priorité à ce que dit Buffer", () => {
    expect(deriveStatus(of({ bufferStatus: "scheduled", approvalStatus: "approved", scheduleState: "scheduled" }))).toBe("scheduled");
    expect(deriveStatus(of({ bufferStatus: "sent", approvalStatus: "approved" }))).toBe("published");
    expect(deriveStatus(of({ bufferStatus: "error", approvalStatus: "approved" }))).toBe("error");
  });

  it("signale en erreur une programmation qui a échoué", () => {
    expect(deriveStatus(of({ approvalStatus: "approved", scheduleState: "failed" }))).toBe("error");
  });
});

describe("alertes pour l'administrateur", () => {
  const base = { ...of({}), dueAt: FUTURE, bufferError: null, scheduleError: null, assets: [], text: "Bonjour" };

  it("ne signale rien pour un post normal", () => {
    expect(getPostAlerts({ ...base, approvalStatus: "pending" }, NOW)).toEqual([]);
  });

  it("signale un post programmé dans Buffer sans validation du client", () => {
    const alerts = getPostAlerts({ ...base, bufferStatus: "scheduled", approvalStatus: "pending" }, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("error");
    expect(getPostAlerts({ ...base, bufferStatus: "scheduled", approvalStatus: "approved" }, NOW)).toEqual([]);
  });

  it("signale une date dépassée sur un post soumis ; une date absente n'est plus une anomalie (0014)", () => {
    expect(getPostAlerts({ ...base, approvalStatus: "approved", dueAt: "2026-10-01T08:00:00.000Z" }, NOW)[0].message).toContain("dépassée");
    expect(getPostAlerts({ ...base, approvalStatus: "pending", dueAt: null }, NOW)).toEqual([]);
  });

  it("reprend le message d'erreur de la programmation", () => {
    const alerts = getPostAlerts({ ...base, approvalStatus: "approved", scheduleState: "failed", scheduleError: "Canal déconnecté" }, NOW);
    expect(alerts[0].message).toContain("Canal déconnecté");
  });
});

describe("décision du client", () => {
  it("n'est possible que sur un brouillon Buffer en attente et non supprimé", () => {
    expect(canDecide({ approvalStatus: "pending", bufferStatus: "draft", removedAt: null })).toBe(true);
    expect(canDecide({ approvalStatus: "approved", bufferStatus: "draft", removedAt: null })).toBe(false);
    expect(canDecide({ approvalStatus: "pending", bufferStatus: "scheduled", removedAt: null })).toBe(false);
    expect(canDecide({ approvalStatus: "pending", bufferStatus: "draft", removedAt: NOW })).toBe(false);
  });
});

describe("titre d'un post", () => {
  it("prend la première ligne non vide et la coupe proprement", () => {
    expect(postTitle({ text: "\n\nBonjour à tous\nSuite" })).toBe("Bonjour à tous");
    expect(postTitle({ text: "" })).toBe("Post sans texte");
    expect(postTitle({ text: "un deux trois quatre cinq" }, 12)).toBe("un deux…");
  });
});

describe("date prévue", () => {
  it("permet l'approbation si elle est à venir ou absente, jamais si elle est dépassée (0014)", () => {
    expect(hasUsableDueDate({ dueAt: FUTURE }, NOW)).toBe(true);
    expect(hasUsableDueDate({ dueAt: NOW }, NOW)).toBe(false);
    expect(hasUsableDueDate({ dueAt: "2026-10-01T08:00:00.000Z" }, NOW)).toBe(false);
    expect(hasUsableDueDate({ dueAt: null }, NOW)).toBe(true);
  });
});

describe("lien vers la publication en ligne", () => {
  it("n'accepte que les adresses http et https", () => {
    expect(safeExternalUrl("https://x.com/a/status/1")).toBe("https://x.com/a/status/1");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalUrl("pas une adresse")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});


describe("diagnostics techniques transmis au client", () => {
  it("conserve le statut d'incident tout en masquant les détails dans les props sérialisées", () => {
    const raw = {
      ...of({ bufferStatus: "error", scheduleState: "failed" }),
      id: "post", channelId: "channel", text: "Proposition",
      bufferError: "Diagnostic fournisseur privé", scheduleError: "Diagnostic programmation privé",
    } as Post;
    const [admin] = buildPostViews([raw], [], []);
    const client = redactPostDiagnostics(admin);
    expect(client.status).toBe("error");
    expect(client.text).toBe("Proposition");
    expect(JSON.stringify(client)).not.toContain("privé");
    expect(admin.bufferError).toBe("Diagnostic fournisseur privé");
    expect(admin.scheduleError).toBe("Diagnostic programmation privé");
  });
});
