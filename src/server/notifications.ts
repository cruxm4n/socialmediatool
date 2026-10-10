import "server-only";

import { createHash } from "node:crypto";

import { buildDigests, type Digest, type QueuedNotification } from "@/lib/domain/notifications";
import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { env } from "@/server/env";

/*
 * Remise des notifications. La base les met en file d'attente (migration 0007) ; ici elles sont
 * réservées, regroupées par destinataire, puis remises.
 *
 * Deux modes :
 * - « simulate » (défaut) : rien ne sort du serveur. Chaque notification est marquée « simulée »
 *   dans l'historique, ce qui permet de voir exactement ce qui serait parti.
 * - « webhook » : chaque message est envoyé en POST à NOTIFICATIONS_WEBHOOK_URL (un workflow n8n
 *   qui expédie l'e-mail, voir docs/NOTIFICATIONS.md).
 *
 * En Buffer simulé, le mode est toujours « simulate » : des données fictives n'écrivent à personne.
 */

const TIMEOUT_MS = 10_000;

export interface DispatchResult {
  mode: "simulate" | "webhook";
  /** Messages remis (une ligne par destinataire et par type). */
  messages: number;
  /** Notifications couvertes par ces messages. */
  sent: number;
  simulated: number;
  failed: number;
  /** Messages remis dont l'enregistrement local a échoué : ils seront repris (clé d'idempotence identique). */
  unconfirmed?: number;
}

/** Mode effectif : l'envoi réel exige le mode Buffer réel, le réglage explicite et une adresse de webhook. */
export function notificationMode(): "simulate" | "webhook" {
  return env.bufferMode === "real" && env.notificationMode === "webhook" && env.notificationWebhookUrl ? "webhook" : "simulate";
}

/**
 * Clé d'idempotence d'un message : identique si le même lot est remis de nouveau (confirmation locale perdue,
 * réservation abandonnée puis reprise). La déduplication en base n'empêche pas un prestataire de remettre deux fois
 * ce qu'on lui envoie deux fois : cette clé permet au récepteur (n8n) de dédoublonner, elle ne le garantit pas.
 */
export function deliveryKey(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 32);
}

async function deliver(digest: Digest): Promise<void> {
  if (!digest.recipientEmail) throw new Error("Destinataire sans adresse e-mail.");
  const key = deliveryKey(digest.ids);
  const response = await fetch(env.notificationWebhookUrl!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(env.notificationWebhookSecret ? { "x-cadence-secret": env.notificationWebhookSecret } : {}),
    },
    body: JSON.stringify({
      deliveryId: key,
      to: digest.recipientEmail,
      name: digest.recipientName,
      kind: digest.kind,
      subject: digest.subject,
      text: digest.text,
      url: digest.url,
      items: digest.items,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Le webhook de notification a répondu HTTP ${response.status}.`);
}

let running: Promise<DispatchResult> | null = null;

/** Remet les notifications en attente. Une seule remise à la fois par serveur ; la base empêche tout double envoi entre serveurs. */
export function dispatchNotifications(): Promise<DispatchResult> {
  running ??= dispatch().finally(() => {
    running = null;
  });
  return running;
}

/** Un message par tour : chaque tour repasse par la réservation, donc par la revalidation de la base. */
const MAX_ROUNDS = 40;

async function dispatch(): Promise<DispatchResult> {
  const mode = notificationMode();
  const result: DispatchResult = { mode, messages: 0, sent: 0, simulated: 0, failed: 0 };

  /** Garde-fou : une notification déjà traitée dans ce passage n'est jamais remise une seconde fois. */
  const seen = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let rows: QueuedNotification[];
    try {
      rows = (await rpc<QueuedNotification[]>("claim_notifications", { p_mode: env.bufferMode })) ?? [];
    } catch (error) {
      // Base sans la migration 0007 : pas de notifications, ce n'est pas une erreur.
      if (error instanceof MissingFunctionError) return result;
      // Une réservation qui échoue après un premier message : on s'arrête là. Ce qui reste sera réservé de nouveau.
      if (round > 0) return result;
      throw error;
    }
    if (rows.length === 0) break;
    // Une notification déjà remise dans ce passage ne l'est jamais une seconde fois (garde-fou).
    if (rows.some((row) => seen.has(row.id))) break;

    const [digest, ...rest] = buildDigests(rows, env.appUrl, { content: env.notificationContent ?? "minimal" });
    // Les autres messages sont rendus à la file : la base les revalidera (membre, client, version, préférences)
    // au moment où ils seront réellement remis, pas au moment où le lot a été constitué.
    for (const other of rest) await rpc("complete_notifications", { p_ids: other.ids, p_status: "released" }).catch(() => undefined);

    // Revalidation JUSTE avant la remise : un lot réservé n'est jamais définitivement autorisé (membre retiré, rôle
    // changé, client archivé, préférence coupée, version dépassée pendant l'attente). Une vérification impossible
    // n'autorise rien : le lot est rendu à la file.
    let eligible = digest.ids.length;
    let verified = true;
    try {
      const answer = await rpc<number | null>("complete_notifications", { p_ids: digest.ids, p_status: "verify" });
      if (typeof answer === "number") eligible = answer;
    } catch {
      verified = false;
    }
    if (!verified) {
      await rpc("complete_notifications", { p_ids: digest.ids, p_status: "released" }).catch(() => undefined);
      break;
    }
    if (eligible < digest.ids.length) {
      // Une partie du lot n'est plus légitime (annulée par la base) : le reste est rendu et recomposé au tour suivant.
      await rpc("complete_notifications", { p_ids: digest.ids, p_status: "released" }).catch(() => undefined);
      continue;
    }

    result.messages += 1;
    for (const id of digest.ids) seen.add(id);
    if (mode === "simulate") {
      await rpc("complete_notifications", { p_ids: digest.ids, p_status: "simulated" });
      result.simulated += digest.ids.length;
      continue;
    }
    try {
      await deliver(digest);
    } catch (error) {
      const message = error instanceof Error ? (error.name === "TimeoutError" ? "Le webhook de notification ne répond pas (délai dépassé)." : error.message) : String(error);
      await rpc("complete_notifications", { p_ids: digest.ids, p_status: "failed", p_error: message }).catch(() => undefined);
      result.failed += digest.ids.length;
      continue;
    }
    // Le message est PARTI : l'enregistrement local est retenté ; s'il échoue, la reprise réutilisera la même clé.
    let recorded = false;
    for (let attempt = 0; attempt < 3 && !recorded; attempt += 1) {
      try {
        await rpc("complete_notifications", { p_ids: digest.ids, p_status: "sent" });
        recorded = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    if (recorded) result.sent += digest.ids.length;
    else result.unconfirmed = (result.unconfirmed ?? 0) + digest.ids.length;
  }
  return result;
}
