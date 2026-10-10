import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/*
 * Chiffrement des secrets des connexions fournisseur (clé d'API Buffer d'un client), AVANT leur écriture en base.
 *
 * - AES-256-GCM ; la clé vient de CADENCE_CREDENTIALS_KEY (32 octets en base64), jamais de la base ;
 * - chaque secret est lié à SA connexion (donnée authentifiée) : un texte chiffré recopié sur une autre connexion
 *   ne se déchiffre pas ;
 * - rien ici n'est journalisé ; les erreurs ne contiennent ni clé ni secret.
 * Format : v1.<iv>.<étiquette>.<texte chiffré>, en base64url.
 */

export const CREDENTIAL_KEY_VERSION = 1;

export class CredentialError extends Error {}

function loadKey(): Buffer {
  const raw = process.env.CADENCE_CREDENTIALS_KEY;
  if (!raw) throw new CredentialError("Clé de chiffrement absente : définissez CADENCE_CREDENTIALS_KEY côté serveur (voir docs/CONNEXIONS_FOURNISSEUR.md).");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new CredentialError("CADENCE_CREDENTIALS_KEY doit contenir exactement 32 octets encodés en base64.");
  return key;
}

/** La clé de chiffrement est-elle utilisable ? (sans la révéler) */
export function credentialKeyAvailable(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptCredential(connectionId: string, secret: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`cadence:provider-connection:${connectionId}`));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptCredential(connectionId: string, ciphertext: string): string {
  const [version, iv, tag, data] = ciphertext.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new CredentialError("Secret de connexion illisible (format inconnu).");
  try {
    const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`cadence:provider-connection:${connectionId}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError("Secret de connexion indéchiffrable : clé de chiffrement différente, ou secret d'une autre connexion.");
  }
}

/** Indice d'affichage : les quatre derniers caractères, jamais plus. */
export const credentialHint = (secret: string) => secret.slice(-4);

/** Empreinte courte d'un secret, pour comparer deux clés sans les conserver. */
export const credentialFingerprint = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 16);
