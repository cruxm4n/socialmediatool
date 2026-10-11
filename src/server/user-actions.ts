"use server";

import { randomInt } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/action-result";
import { ADMIN_ERRORS } from "@/lib/domain/clients";
import { errorCodeIn } from "@/lib/domain/errors";
import { rpc } from "@/server/automation-rpc";
import { getSession } from "@/server/auth";
import { credentialKeyAvailable, currentKeyVersion, decryptCredential, encryptCredential } from "@/server/credentials";
import { env } from "@/server/env";
import { createSessionClient } from "@/server/supabase/clients";

/*
 * Comptes des utilisateurs clients, créés par l'administrateur.
 *
 * - Le rôle est revérifié ici ET dans la base : l'interface n'est jamais une preuve de droit.
 * - Le mot de passe est généré par le serveur. Il est renvoyé à l'administrateur, qui le transmet à son client, et
 *   conservé CHIFFRÉ (même clé maître que les clés Buffer) pour pouvoir être relu ou renouvelé. Il n'est ni journalisé,
 *   ni stocké en clair, ni lisible par une session de navigateur.
 * - La clé d'administration des comptes (SUPABASE_SERVICE_ROLE_KEY) ne quitte jamais le serveur et ne sert qu'ici.
 */

const SESSION_EXPIRED: ActionResult = { ok: false, message: "Votre session a expiré. Reconnectez-vous.", expired: true };
const UNAVAILABLE = "La création de comptes n'est pas activée sur ce serveur (clé d'administration des comptes ou clé de chiffrement absente).";

export interface PasswordResult extends ActionResult {
  /** Mot de passe en clair, pour l'administrateur uniquement. Absent en cas d'échec. */
  password?: string;
  email?: string;
}

async function adminActor(): Promise<{ actor: string } | { refusal: ActionResult }> {
  const session = await getSession();
  if (!session) return { refusal: SESSION_EXPIRED };
  return session.profile.role === "admin" ? { actor: session.profile.id } : { refusal: { ok: false, message: "Réservé à l'administrateur." } };
}

// Sans caractères ambigus (0/O, 1/l/I) : le mot de passe est recopié à la main par un client.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
/** 20 caractères tirés par le générateur du système : environ 116 bits d'entropie. */
function generatePassword(): string {
  return Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

const passwordScope = (userId: string) => `user-password:${userId}`;

/** Appel à l'administration des comptes (GoTrue). La clé de service n'apparaît dans aucun message d'erreur. */
async function authAdmin(method: "POST" | "PUT", path: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/admin/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.supabaseServiceKey}`, apikey: env.supabaseKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, data: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

async function storePassword(actor: string, userId: string, password: string): Promise<void> {
  await rpc("server_set_user_password", {
    p_actor: actor, p_user_id: userId, p_ciphertext: encryptCredential(passwordScope(userId), password), p_key_version: currentKeyVersion(),
  });
}

/**
 * Donne accès à l'espace d'un client. Si l'adresse a déjà un compte, seul l'accès est accordé : son mot de passe
 * n'est jamais changé à l'insu de la personne. Sinon le compte est créé, et son mot de passe généré est renvoyé.
 */
export async function createClientUser(input: { organizationId: string; email: string; fullName: string; jobTitle: string }): Promise<PasswordResult> {
  const parsed = z
    .object({ organizationId: z.string().uuid(), email: z.string().trim().toLowerCase().email().max(200), fullName: z.string().trim().max(80), jobTitle: z.string().trim().max(80) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: "Saisissez une adresse e-mail valide." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  const { organizationId, email, fullName, jobTitle } = parsed.data;
  const supabase = await createSessionClient();
  const grant = () => supabase.rpc("admin_add_user", { p_organization_id: organizationId, p_email: email, p_full_name: fullName, p_job_title: jobTitle });

  // 1. Compte déjà existant : accès accordé, rien d'autre ne change.
  const existing = await grant();
  if (!existing.error) {
    revalidatePath("/", "layout");
    return { ok: true, message: "Accès accordé à ce compte existant. Son mot de passe n'a pas été changé." };
  }
  const refusal = errorCodeIn(existing.error.message, Object.keys(ADMIN_ERRORS));
  if (refusal === "invalid_name") return { ok: false, message: "Première association de ce compte : indiquez son nom." };
  if (refusal !== "user_not_found") return { ok: false, message: refusal ? ADMIN_ERRORS[refusal] : "L'accès n'a pas pu être donné. Rechargez la page et réessayez." };

  // 2. Aucun compte à cette adresse : création, si le serveur le permet.
  if (!env.supabaseServiceKey || !credentialKeyAvailable()) return { ok: false, message: `Aucun compte ne correspond à cet e-mail. ${UNAVAILABLE}` };
  if (!fullName) return { ok: false, message: "Aucun compte ne correspond à cet e-mail. Pour le créer, indiquez le nom de la personne." };

  const password = generatePassword();
  let userId: string;
  try {
    const created = await authAdmin("POST", "users", { email, password, email_confirm: true });
    if (created.status !== 200 || typeof created.data?.id !== "string") {
      return { ok: false, message: "Le compte n'a pas pu être créé. Rien n'a été enregistré : réessayez." };
    }
    userId = created.data.id;
  } catch {
    return { ok: false, message: "Le service des comptes n'a pas répondu. Vérifiez la liste avant de réessayer : le compte a peut-être été créé." };
  }

  // Le compte existe : le mot de passe est conservé avant tout, pour ne jamais laisser un compte au mot de passe perdu.
  let kept = true;
  try {
    await storePassword(who.actor, userId, password);
  } catch {
    kept = false;
  }
  const { error } = await grant();
  revalidatePath("/", "layout");
  const notes = [
    error ? "l'accès à ce client n'a pas pu être donné : réessayez avec la même adresse" : null,
    kept ? null : "son mot de passe n'a pas pu être conservé : notez-le maintenant, il ne pourra pas être réaffiché (vous pourrez le renouveler)",
  ].filter(Boolean);
  return { ok: true, password, email, message: notes.length > 0 ? `Compte créé, mais ${notes.join(" ; ")}.` : "Compte créé et accès accordé." };
}

const userSchema = z.object({ userId: z.string().uuid() });

/** Mot de passe actuel d'un compte client, pour l'administrateur. */
export async function revealUserPassword(input: { userId: string }): Promise<PasswordResult> {
  const parsed = userSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  if (!credentialKeyAvailable()) return { ok: false, message: UNAVAILABLE };
  try {
    const stored = await rpc<{ ciphertext: string; keyVersion: number } | null>("server_get_user_password", { p_actor: who.actor, p_user_id: parsed.data.userId });
    if (!stored) return { ok: false, message: "Aucun mot de passe n'est conservé pour ce compte (il a été créé autrement). Vous pouvez lui en générer un nouveau." };
    return { ok: true, message: "", password: decryptCredential(passwordScope(parsed.data.userId), stored.ciphertext, stored.keyVersion) };
  } catch (error) {
    if (error instanceof Error && error.message.includes("not_a_client")) return { ok: false, message: "Le mot de passe d'un administrateur n'est jamais conservé." };
    return { ok: false, message: "Le mot de passe n'a pas pu être lu. Vous pouvez en générer un nouveau." };
  }
}

/** Remplace le mot de passe d'un compte client par un nouveau, généré. L'ancien cesse de fonctionner aussitôt. */
export async function regenerateUserPassword(input: { userId: string }): Promise<PasswordResult> {
  const parsed = userSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const who = await adminActor();
  if ("refusal" in who) return who.refusal;
  if (!env.supabaseServiceKey || !credentialKeyAvailable()) return { ok: false, message: UNAVAILABLE };
  const { userId } = parsed.data;

  // Jamais le compte d'un administrateur : la base le refuse aussi (server_set_user_password).
  const supabase = await createSessionClient();
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  if (!profile || profile.role !== "client") return { ok: false, message: "Seul le mot de passe d'un compte client peut être renouvelé ici." };

  const password = generatePassword();
  try {
    const updated = await authAdmin("PUT", `users/${userId}`, { password });
    if (updated.status !== 200) return { ok: false, message: "Le mot de passe n'a pas pu être changé. L'ancien reste valable." };
  } catch {
    return { ok: false, message: "Le service des comptes n'a pas répondu. Renouvelez de nouveau le mot de passe pour être certain de celui qui est en place." };
  }
  try {
    await storePassword(who.actor, userId, password);
  } catch {
    return { ok: true, password, message: "Mot de passe changé, mais il n'a pas pu être conservé : notez-le maintenant, il ne pourra pas être réaffiché." };
  }
  return { ok: true, password, message: "Nouveau mot de passe généré. L'ancien ne fonctionne plus." };
}
