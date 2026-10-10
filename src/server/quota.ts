import "server-only";

import { rpc } from "@/server/automation-rpc";
import type { ProviderError, PublishingProvider } from "@/server/publishing/provider";

export interface RateLimitPause {
  until: string;
  reason: string | null;
  /**
   * true : Buffer a REFUSÉ une requête (429). Rien, pas même une annulation, n'est tenté avant l'échéance.
   * false : pause préventive (quota presque épuisé) : les compensations restent permises.
   */
  hard?: boolean;
}

/** Pause appliquée à un 429 sans durée exploitable : 15 minutes. */
export const DEFAULT_RATE_LIMIT_PAUSE_SECONDS = 15 * 60;

/**
 * Pause de quota en cours pour ce mode (fournisseur réel ou simulé), ou null.
 *
 * Toute action qui écrit dans Buffer (envoi du Studio, changement de date, programmation après approbation) ou qui le
 * lit pour réconcilier la consulte. La lecture est tolérante : base sans la migration 0010, ou lecture impossible →
 * null (le refus 429 de Buffer, lui, est toujours enregistré).
 */
export async function activeRateLimitPause(mode: PublishingProvider["mode"]): Promise<RateLimitPause | null> {
  try {
    return (await rpc<RateLimitPause | null>("get_sync_pause", { p_mode: mode })) ?? null;
  } catch {
    // MissingFunctionError (migration absente) ou lecture impossible : pas de pause connue.
    return null;
  }
}

/** Une pause du quota est enregistrée même hors d'une synchronisation (approbation, envoi du Studio). */
export async function recordRateLimit(error: ProviderError, mode: PublishingProvider["mode"]): Promise<void> {
  // Refus propre à UN compte (connexion) : sa pause est déjà enregistrée sur la connexion par le routeur. La pause
  // globale du mode ne doit pas suspendre les comptes des autres clients.
  if (error.connectionId) return;
  await rpc("set_sync_backoff", {
    p_mode: mode,
    p_seconds: error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_PAUSE_SECONDS,
    p_reason: "Quota de requêtes Buffer atteint : opérations suspendues.",
  }).catch(() => undefined);
}

/** Phrase destinée à l'administrateur quand une action est refusée à cause d'une pause. */
export function pauseMessage(pause: { until: string; reason: string | null }): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(pause.until) - Date.now()) / 60_000));
  const wait = minutes >= 120 ? `${Math.ceil(minutes / 60)} h` : `${minutes} min`;
  return `Quota Buffer atteint : les écritures sont suspendues (environ ${wait}). ${pause.reason ?? ""}`.trim();
}
