import { describe, expect, it } from "vitest";

import { monthlyRequests, NO_SYNC_STATUS, quotaBackoff, syncHealth, type SyncStatus } from "@/lib/domain/sync-health";

const NOW = "2026-10-09T12:00:00.000Z";
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const status = (overrides: Partial<SyncStatus>): SyncStatus => ({ ...NO_SYNC_STATUS, tracked: true, ...overrides });

describe("état de la synchronisation", () => {
  it("jamais synchronisé", () => {
    expect(syncHealth(NO_SYNC_STATUS, NOW, 5)).toMatchObject({ level: "never", schedulerActive: false });
  });

  it("à jour quand le dernier succès est récent, et dit si le planificateur tourne", () => {
    expect(syncHealth(status({ lastSuccessAt: ago(3), lastScheduledAt: ago(3) }), NOW, 5)).toMatchObject({ level: "ok", label: "À jour il y a 3 min", schedulerActive: true });
    expect(syncHealth(status({ lastSuccessAt: ago(3) }), NOW, 5).schedulerActive).toBe(false);
  });

  it("en retard au-delà de trois intervalles, quinze minutes au moins", () => {
    expect(syncHealth(status({ lastSuccessAt: ago(14) }), NOW, 5).level).toBe("ok");
    expect(syncHealth(status({ lastSuccessAt: ago(16) }), NOW, 5)).toMatchObject({ level: "late", label: "Données d'il y a 16 min" });
    expect(syncHealth(status({ lastSuccessAt: ago(40) }), NOW, 15).level).toBe("ok");
    expect(syncHealth(status({ lastSuccessAt: ago(50) }), NOW, 15).level).toBe("late");
  });

  it("en échec tant qu'aucun succès n'a suivi le dernier échec, avec le motif", () => {
    const health = syncHealth(status({ lastSuccessAt: ago(30), lastFailureAt: ago(2), lastError: "Buffer injoignable.", consecutiveFailures: 3 }), NOW, 5);
    expect(health).toMatchObject({ level: "failing", tone: "red" });
    expect(health.detail).toContain("Buffer injoignable.");
    expect(health.detail).toContain("3 échecs de suite");
    expect(syncHealth(status({ lastSuccessAt: ago(1), lastFailureAt: ago(2), lastError: "Ancien" }), NOW, 5).level).toBe("ok");
    expect(syncHealth(status({ lastFailureAt: ago(2) }), NOW, 5).level).toBe("failing");
  });

  it("en pause pendant un quota à ménager, puis de nouveau normal", () => {
    const paused = status({ lastSuccessAt: ago(4), backoffUntil: new Date(Date.parse(NOW) + 600_000).toISOString(), backoffReason: "Quota Buffer presque épuisé." });
    expect(syncHealth(paused, NOW, 5)).toMatchObject({ level: "paused", tone: "amber" });
    expect(syncHealth({ ...paused, backoffUntil: ago(1) }, NOW, 5).level).toBe("ok");
  });

  it("en cours quand le verrou est tenu", () => {
    expect(syncHealth(status({ lastSuccessAt: ago(4), running: true }), NOW, 5).level).toBe("running");
  });
});

describe("quota Buffer", () => {
  it("aucune pause tant qu'il reste plus de 10 % dans chaque fenêtre", () => {
    expect(quotaBackoff({ "100-in-15min": 60, "500-in-1day": 300, "15000-in-30days": 9000 })).toBeNull();
    expect(quotaBackoff(null)).toBeNull();
    expect(quotaBackoff({ inconnu: 0 })).toBeNull();
  });

  it("la pause dépend de la fenêtre entamée ; la plus longue l'emporte", () => {
    expect(quotaBackoff({ "100-in-15min": 10 })?.seconds).toBe(900);
    expect(quotaBackoff({ "250-in-1day": 25 })?.seconds).toBe(3600);
    const both = quotaBackoff({ "100-in-15min": 3, "3000-in-30days": 300 });
    expect(both?.seconds).toBe(21600);
    expect(both?.reason).toContain("300 requêtes restantes sur 30 jours");
  });

  it("une synchronisation toutes les cinq minutes dépasse l'offre gratuite de Buffer", () => {
    expect(monthlyRequests(5)).toBe(8640);
    expect(monthlyRequests(15)).toBe(2880);
  });
});
