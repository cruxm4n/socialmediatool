import { afterEach, describe, expect, it } from "vitest";

import { env } from "@/server/env";

/*
 * (Mission V3, C04/C14) Le profil « pilot » impose la simulation des notifications et leur contenu minimal, quoi
 * que disent les autres variables : un réglage oublié ou copié d'un autre environnement ne peut pas ouvrir un envoi
 * réel ni activer le mode détaillé.
 */
const KEYS = ["CADENCE_PROFILE", "NOTIFICATIONS_MODE", "NOTIFICATIONS_CONTENT"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("profil pilote", () => {
  it("sans profil, les réglages explicites s'appliquent (défauts prudents)", () => {
    delete process.env.CADENCE_PROFILE;
    delete process.env.NOTIFICATIONS_MODE;
    delete process.env.NOTIFICATIONS_CONTENT;
    expect(env.notificationMode).toBe("simulate");
    expect(env.notificationContent).toBe("minimal");
    process.env.NOTIFICATIONS_MODE = "webhook";
    process.env.NOTIFICATIONS_CONTENT = "full";
    expect(env.notificationMode).toBe("webhook");
    expect(env.notificationContent).toBe("full");
  });

  it("au profil pilote, ni l'envoi réel ni le mode détaillé ne peuvent être activés par erreur", () => {
    process.env.CADENCE_PROFILE = "pilot";
    process.env.NOTIFICATIONS_MODE = "webhook";
    process.env.NOTIFICATIONS_CONTENT = "full";
    expect(env.profile).toBe("pilot");
    expect(env.notificationMode).toBe("simulate");
    expect(env.notificationContent).toBe("minimal");
  });
});
