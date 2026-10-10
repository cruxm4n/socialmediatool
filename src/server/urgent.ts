import "server-only";

import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { getProvider } from "@/server/publishing";
import {
  describeError, NO_LEASE, reconcileOrphanClaims, unscheduleInvalidatedPosts, type Lease,
} from "@/server/compensation";
import type { ProviderError, PublishingProvider } from "@/server/publishing/provider";

/*
 * Traitement URGENT : rattrapage des annulations à confirmer et des réservations de programmation abandonnées.
 *
 * Il ne dépend NI du poll général (30 minutes) NI de la réussite d'un instantané de Buffer : il lit d'abord l'état
 * local (une requête SQL, aucun appel Buffer), n'appelle Buffer que s'il y a du travail, et respecte tout refus de
 * quota. Il est déclenché (1) par la boucle du serveur (urgent-loop.ts, toutes les 30 s, et au démarrage), (2) par la
 * synchronisation générale, (3) par POST /api/automation/urgent (surveillance externe).
 *
 * Budget de reprise (validation locale, fournisseur disponible) : une tentative au plus tard 60 s après le démarrage
 * du serveur (premier passage à +5 s) ou après la reprise du traitement urgent (période de 30 s), hors durée réseau
 * (15 s par appel Buffer, 20 s par appel à la base). Le bail du traitement dure 120 s et est renouvelé avant chaque
 * appel Buffer : un détenteur dont le bail a expiré s'arrête.
 */

/** Durée du bail du traitement urgent (secondes). Renouvelé avant chaque appel Buffer. */
export const URGENT_LEASE_SECONDS = 120;
/** Au-delà de ce délai, une réservation « en cours » est considérée abandonnée (secondes). */
export const ORPHAN_GRACE_SECONDS = 120;

export interface UrgentResult {
  ok: boolean;
  skipped?: "idle" | "running" | "unsupported";
  /** Annulations constatées dans Buffer pendant ce passage. */
  compensated: number;
  /** Annulations tentées sans succès ou reportées (quota refusé, panne, bail perdu) : l'urgence reste visible. */
  compensationFailures: number;
  /** Réservations abandonnées rapprochées de l'état réel de Buffer. */
  reconciled: number;
  rateLimited: ProviderError | null;
  error?: string;
}

const none = (extra: Partial<UrgentResult> = {}): UrgentResult => ({ ok: true, compensated: 0, compensationFailures: 0, reconciled: 0, rateLimited: null, ...extra });

interface UrgentLock {
  acquired?: boolean;
  token?: string;
}

/**
 * Un passage complet : rapproche les réservations abandonnées, puis compense. Prend le verrou du traitement urgent
 * (un seul à la fois). Sans la migration 0011 (fonction absente), il s'exécute sans verrou, comme la synchronisation.
 */
export async function runUrgentCycle(provider: PublishingProvider = getProvider(), options: { lease?: Lease } = {}): Promise<UrgentResult> {
  let lock: UrgentLock | null = null;
  try {
    lock = await rpc<UrgentLock | null>("begin_urgent_run", { p_mode: provider.mode, p_ttl_seconds: URGENT_LEASE_SECONDS });
  } catch (error) {
    if (!(error instanceof MissingFunctionError)) return none({ ok: false, error: describeError(error) });
  }
  if (lock?.acquired === false) return none({ skipped: "running" });

  const token = lock?.token;
  const lease: Lease = token
    ? {
        ensure: async () => {
          const held = await rpc<boolean>("renew_urgent_run", { p_mode: provider.mode, p_token: token, p_ttl_seconds: URGENT_LEASE_SECONDS }).catch(() => false);
          return held !== false && (options.lease ? await options.lease.ensure() : true);
        },
      }
    : (options.lease ?? NO_LEASE);

  let result: UrgentResult;
  try {
    const orphans = await reconcileOrphanClaims(provider, { lease, graceSeconds: ORPHAN_GRACE_SECONDS });
    const compensation = await unscheduleInvalidatedPosts(provider, { lease });
    const failures = compensation.failures + orphans.failures;
    result = {
      ok: failures === 0,
      compensated: compensation.done,
      compensationFailures: compensation.failures,
      reconciled: orphans.reconciled,
      rateLimited: compensation.rateLimited ?? orphans.rateLimited,
      ...(failures > 0 ? { error: compensation.blocked ?? `${failures} opération(s) urgente(s) non terminée(s).` } : {}),
    };
  } catch (error) {
    result = none({ ok: false, error: describeError(error) });
  }
  if (token) {
    await rpc("finish_urgent_run", {
      p_mode: provider.mode, p_token: token, p_ok: result.ok, p_error: result.error ?? null, p_done: result.compensated + result.reconciled,
    }).catch(() => undefined);
  }
  return result;
}

/**
 * Point d'entrée du réveil : lecture locale d'abord ; Buffer n'est appelé que s'il y a du travail urgent.
 */
export async function runUrgent(): Promise<UrgentResult> {
  const provider = getProvider();
  let summary: { pending_unschedule?: number; orphan_claims?: number } | null = null;
  try {
    summary = await rpc("urgent_work_summary", { p_mode: provider.mode, p_orphan_grace_seconds: ORPHAN_GRACE_SECONDS });
  } catch (error) {
    if (error instanceof MissingFunctionError) return none({ skipped: "unsupported" });
    return none({ ok: false, error: describeError(error) });
  }
  if (!summary) return none({ skipped: "unsupported" });
  if ((summary.pending_unschedule ?? 0) === 0 && (summary.orphan_claims ?? 0) === 0) return none({ skipped: "idle" });
  return runUrgentCycle(provider);
}
