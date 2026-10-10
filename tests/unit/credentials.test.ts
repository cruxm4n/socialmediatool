import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Secrets des connexions fournisseur : chiffrés avant d'atteindre la base, liés à leur connexion, jamais en clair
 * dans un message d'erreur. Les « clés » de ces tests sont des valeurs factices générées à chaque exécution.
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = `cle-factice-${randomBytes(8).toString("hex")}`;

beforeEach(() => {
  process.env.CADENCE_CREDENTIALS_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  delete process.env.CADENCE_CREDENTIALS_KEY;
  vi.resetModules();
});

const load = () => import("@/server/credentials");

describe("chiffrement des secrets de connexion", () => {
  it("le secret se relit avec la même clé et la même connexion ; le texte stocké ne le contient pas", async () => {
    const { encryptCredential, decryptCredential } = await load();
    const stored = encryptCredential(A, SECRET);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(SECRET);
    expect(Buffer.from(stored.split(".")[3], "base64url").toString("utf8")).not.toContain(SECRET);
    expect(decryptCredential(A, stored)).toBe(SECRET);
  });

  it("deux chiffrements du même secret diffèrent (vecteur aléatoire)", async () => {
    const { encryptCredential } = await load();
    expect(encryptCredential(A, SECRET)).not.toBe(encryptCredential(A, SECRET));
  });

  it("le secret du client A recopié sur la connexion du client B ne se déchiffre pas", async () => {
    const { encryptCredential, decryptCredential, CredentialError } = await load();
    const stored = encryptCredential(A, SECRET);
    expect(() => decryptCredential(B, stored)).toThrow(CredentialError);
  });

  it("clé de chiffrement différente, texte altéré ou format inconnu : refus, sans jamais révéler le secret", async () => {
    const { encryptCredential, decryptCredential } = await load();
    const stored = encryptCredential(A, SECRET);
    const [v, iv, tag, data] = stored.split(".");
    const altered = [v, iv, tag, `${data.slice(0, -2)}${data.endsWith("AA") ? "BB" : "AA"}`].join(".");
    for (const attempt of [altered, "v2.x.y.z", "pas-un-secret"]) {
      const error = (() => { try { decryptCredential(A, attempt); return null; } catch (e) { return e as Error; } })();
      expect(error).not.toBeNull();
      expect(error!.message).not.toContain(SECRET);
    }
    process.env.CADENCE_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    expect(() => decryptCredential(A, stored)).toThrow(/indéchiffrable/);
  });

  it("sans clé de chiffrement (ou clé de mauvaise taille) : rien n'est chiffré ni déchiffré", async () => {
    const { encryptCredential, credentialKeyAvailable } = await load();
    delete process.env.CADENCE_CREDENTIALS_KEY;
    expect(credentialKeyAvailable()).toBe(false);
    expect(() => encryptCredential(A, SECRET)).toThrow(/CADENCE_CREDENTIALS_KEY/);
    process.env.CADENCE_CREDENTIALS_KEY = Buffer.from("trop-court").toString("base64");
    expect(() => encryptCredential(A, SECRET)).toThrow(/32 octets/);
  });

  it("l'indice d'affichage ne dépasse jamais quatre caractères", async () => {
    const { credentialHint, credentialFingerprint } = await load();
    expect(credentialHint(SECRET)).toBe(SECRET.slice(-4));
    expect(credentialFingerprint(SECRET)).toHaveLength(16);
    expect(credentialFingerprint(SECRET)).not.toContain(SECRET.slice(0, 6));
  });
});

describe("mode réel et serveur de développement", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("BUFFER_MODE=real est ignoré par un serveur de développement, sauf autorisation explicite", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.assign(process.env, { BUFFER_MODE: "real", NODE_ENV: "development" });
    delete process.env.CADENCE_ALLOW_REAL_BUFFER_IN_DEV;
    const { env } = await import("@/server/env");
    expect(env.bufferMode).toBe("mock");
    expect(warn).toHaveBeenCalledTimes(1);
    process.env.CADENCE_ALLOW_REAL_BUFFER_IN_DEV = "1";
    expect(env.bufferMode).toBe("real");
    warn.mockRestore();
  });

  it("en production et en test, BUFFER_MODE=real reste le mode réel ; toute autre valeur reste simulée", async () => {
    const { env } = await import("@/server/env");
    Object.assign(process.env, { BUFFER_MODE: "real", NODE_ENV: "production" });
    expect(env.bufferMode).toBe("real");
    Object.assign(process.env, { NODE_ENV: "test" });
    expect(env.bufferMode).toBe("real");
    process.env.BUFFER_MODE = "Real";
    expect(env.bufferMode).toBe("mock");
  });
});

describe("comptes simulés isolés", () => {
  it("deux comptes simulés n'ont ni canal, ni publication, ni compteur en commun avec le compte de démonstration", async () => {
    const { MockProvider } = await import("@/server/publishing/mock-provider");
    const run = `t${randomBytes(4).toString("hex")}`;
    const demo = await new MockProvider(run).fetchSnapshot();
    const a = new MockProvider(run, "clienta");
    const b = new MockProvider(run, "clientb");
    const [sa, sb] = [await a.fetchSnapshot(), await b.fetchSnapshot()];
    const ids = (s: typeof sa) => [...s.channels.map((c) => c.id), ...s.posts.map((p) => p.id)];
    expect(ids(sa).filter((id) => ids(sb).includes(id) || ids(demo).includes(id))).toEqual([]);
    expect(ids(sa).every((id) => id.startsWith("mock-"))).toBe(true);
    const created = await a.createDraft({ channelId: sa.channels[0].id, service: "linkedin", text: "Brouillon A", dueAt: "2031-01-01T09:00:00.000Z", assets: [] });
    expect(created.id).toContain("clienta");
    expect((await b.fetchSnapshot()).posts.some((p) => p.id === created.id)).toBe(false);
    expect(await b.getPost(created.id)).toBeNull();
  });
});
