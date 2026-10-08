import { describe, expect, it } from "vitest";

import { canDecide, deriveStatus, getPostAlerts, postTitle } from "@/lib/domain/status";
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

  it("signale une date dépassée ou absente sur un post soumis", () => {
    expect(getPostAlerts({ ...base, approvalStatus: "approved", dueAt: "2026-10-01T08:00:00.000Z" }, NOW)[0].message).toContain("dépassée");
    expect(getPostAlerts({ ...base, approvalStatus: "pending", dueAt: null }, NOW)[0].message).toContain("Aucune date");
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
