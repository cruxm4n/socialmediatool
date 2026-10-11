import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/*
 * Chiffrement des secrets des connexions fournisseur (clé d'API Buffer d'un client), AVANT leur écriture en base.
 *
 * - AES-256-GCM ; la clé maître vient de CADENCE_CREDENTIALS_KEY (32 octets en base64), jamais de la base ;
 * - chaque secret est lié à SA connexion (donnée authentifiée) : un texte chiffré recopié sur une autre connexion
 *   ne se déchiffre pas ;
 * - rien ici n'est journalisé ; les erreurs ne contiennent ni clé ni secret.
 * Format : v1.<iv>.<étiquette>.<texte chiffré>, en base64url.
 *
 * Rotation de la clé maître, sans perdre l'accès aux connexions existantes :
 *   CADENCE_CREDENTIALS_KEY            la clé COURANTE (celle qui chiffre) ;
 *   CADENCE_CREDENTIALS_KEY_VERSION    son numéro (1 par défaut), enregistré avec chaque secret ;
 *   CADENCE_CREDENTIALS_PREVIOUS_KEYS  anciennes clés encore nécessaires, « version:base64 » séparées par des virgules.
 * Un secret est déchiffré avec la clé de SA version, puis re-chiffré avec la clé courante par l'action d'administration
 * « Re-chiffrer les clés » ; une ancienne clé ne se retire qu'une fois plus aucun secret ne porte sa version.
 */

export class CredentialError extends Error {}

function parseKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new CredentialError(`${name} doit contenir exactement 32 octets encodés en base64.`);
  return key;
}

/** Numéro de la clé maître courante (entier ≥ 1). */
export function currentKeyVersion(): number {
  const raw = process.env.CADENCE_CREDENTIALS_KEY_VERSION;
  if (!raw) return 1;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1 || version > 1_000_000) throw new CredentialError("CADENCE_CREDENTIALS_KEY_VERSION doit être un entier positif.");
  return version;
}

/** Compatibilité : numéro de version posé sur un secret nouvellement chiffré. */
export const CREDENTIAL_KEY_VERSION = 1;

function loadKey(version?: number | null): Buffer {
  const current = currentKeyVersion();
  const wanted = version ?? current;
  if (wanted === current) {
    const raw = process.env.CADENCE_CREDENTIALS_KEY;
    if (!raw) throw new CredentialError("Clé de chiffrement absente : définissez CADENCE_CREDENTIALS_KEY côté serveur (voir docs/CONNEXIONS_FOURNISSEUR.md).");
    return parseKey(raw, "CADENCE_CREDENTIALS_KEY");
  }
  for (const item of (process.env.CADENCE_CREDENTIALS_PREVIOUS_KEYS ?? "").split(",")) {
    const separator = item.indexOf(":");
    if (separator < 1) continue;
    if (Number(item.slice(0, separator).trim()) === wanted) return parseKey(item.slice(separator + 1), "CADENCE_CREDENTIALS_PREVIOUS_KEYS");
  }
  throw new CredentialError(`Clé de chiffrement n° ${wanted} absente : ce secret a été chiffré avec une clé que le serveur ne possède plus (CADENCE_CREDENTIALS_PREVIOUS_KEYS).`);
}

/** La clé de chiffrement courante est-elle utilisable ? (sans la révéler) */
export function credentialKeyAvailable(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

const aad = (connectionId: string) => Buffer.from(`cadence:provider-connection:${connectionId}`);

/** Chiffre avec la clé COURANTE ; la version à enregistrer avec le secret est `currentKeyVersion()`. */
export function encryptCredential(connectionId: string, secret: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(connectionId));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** Déchiffre avec la clé de la version enregistrée avec le secret (absente : la clé courante). */
export function decryptCredential(connectionId: string, ciphertext: string, keyVersion?: number | null): string {
  const [version, iv, tag, data] = ciphertext.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new CredentialError("Secret de connexion illisible (format inconnu).");
  const key = loadKey(keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(aad(connectionId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialError("Secret de connexion indéchiffrable : clé de chiffrement différente, ou secret d'une autre connexion.");
  }
}

/**
 * Empreinte NON réversible d'une clé d'API, calculée avec la clé maître courante (HMAC-SHA-256). Elle sert à la base
 * pour refuser qu'une même clé soit enregistrée sur deux connexions actives (la clé d'un client pour un autre),
 * sans que la base puisse retrouver ni comparer la clé elle-même.
 */
export function credentialStorageFingerprint(secret: string): string {
  return createHmac("sha256", loadKey()).update(`cadence:credential-fingerprint:${secret}`).digest("hex");
}

/** Indice d'affichage : les quatre derniers caractères, jamais plus. */
export const credentialHint = (secret: string) => secret.slice(-4);

/** Empreinte courte d'un secret, pour comparer deux clés sans les conserver. */
export const credentialFingerprint = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 16);
