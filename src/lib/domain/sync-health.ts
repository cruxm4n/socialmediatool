import { formatRelative } from "@/lib/dates";
import type { Tone } from "@/lib/domain/status";

/*
 * État de la synchronisation avec Buffer, tel que l'administration l'affiche.
 * Règles pures : aucune lecture de base ni d'horloge ici.
 */

export interface SyncStatus {
  /** true : la base suit l'état de la synchronisation (migration 0006). Sinon il est déduit du journal. */
  tracked: boolean;
  running: boolean;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Dernier déclenchement par le planificateur. null : il n'a jamais tourné (ou la base ne le suit pas). */
  lastScheduledAt: string | null;
  /** Les exécutions planifiées sont suspendues jusqu'à cette date (quota Buffer). */
  backoffUntil: string | null;
  backoffReason: string | null;
  anomalies: string[];
  /** Traitement urgent (annulations à confirmer, réservations abandonnées) : l'état RÉEL, jamais « annulé » sans constat. */
  urgent: UrgentStatus;
}

export interface UrgentStatus {
  /** Programmations à annuler dans Buffer, pas encore constatées annulées. */
  pendingCancellations: number;
  /** Depuis quand la plus ancienne attend. */
  oldestSince: string | null;
  /** Échéance (date de publication) la plus proche parmi elles : l'urgence réelle. */
  earliestDue: string | null;
  /** Dernier essai d'annulation, et nombre d'essais cumulés. */
  lastAttemptAt: string | null;
  attempts: number;
  lastAttemptError: string | null;
  /** Réservations de programmation « en cours » depuis longtemps (crash probable) : rapprochées de Buffer par le traitement urgent. */
  staleClaims: number;
  /** Dernier passage du traitement urgent. */
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunError: string | null;
}

export const NO_URGENT_STATUS: UrgentStatus = {
  pendingCancellations: 0, oldestSince: null, earliestDue: null, lastAttemptAt: null, attempts: 0, lastAttemptError: null,
  staleClaims: 0, lastRunAt: null, lastRunOk: null, lastRunError: null,
};

export const NO_SYNC_STATUS: SyncStatus = {
  tracked: false,
  running: false,
  lastStartedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastScheduledAt: null,
  backoffUntil: null,
  backoffReason: null,
  anomalies: [],
  urgent: NO_URGENT_STATUS,
};

export type SyncLevel = "ok" | "running" | "late" | "failing" | "paused" | "never";

export interface SyncHealth {
  level: SyncLevel;
  tone: Tone;
  /** Quelques mots, pour l'en-tête. */
  label: string;
  /** Une phrase, pour l'écran Synchronisation. */
  detail: string;
  /** Le planificateur s'est-il manifesté récemment ? */
  schedulerActive: boolean;
}

const MINUTE = 60_000;

/** Au-delà de ce délai sans succès, les données affichées sont considérées comme anciennes. */
export function staleAfterMinutes(intervalMinutes: number): number {
  return Math.max(15, intervalMinutes * 3);
}

export function syncHealth(status: SyncStatus, now: string, intervalMinutes: number): SyncHealth {
  const at = (iso: string | null) => (iso ? Date.parse(iso) : null);
  const current = Date.parse(now);
  const success = at(status.lastSuccessAt);
  const failure = at(status.lastFailureAt);
  const scheduled = at(status.lastScheduledAt);
  const staleMs = staleAfterMinutes(intervalMinutes) * MINUTE;
  const schedulerActive = scheduled !== null && current - scheduled <= staleMs;
  const since = status.lastSuccessAt ? `Dernier succès ${formatRelative(status.lastSuccessAt, now)}.` : "Aucune synchronisation réussie pour l'instant.";
  const health = (level: SyncLevel, tone: Tone, label: string, detail: string): SyncHealth => ({ level, tone, label, detail, schedulerActive });

  if (success === null && failure === null) {
    return health("never", "neutral", "Jamais synchronisé", "Lancez une première synchronisation pour récupérer vos canaux et vos brouillons depuis Buffer.");
  }
  if (failure !== null && (success === null || failure > success)) {
    const count = status.consecutiveFailures > 1 ? ` (${status.consecutiveFailures} échecs de suite)` : "";
    return health("failing", "red", "Synchronisation en échec", `${status.lastError ?? "La dernière synchronisation a échoué."}${count} ${since}`);
  }
  const backoff = at(status.backoffUntil);
  if (backoff !== null && backoff > current) {
    return health("paused", "amber", "Synchronisation en pause", `${status.backoffReason ?? "Quota Buffer à ménager."} Le bouton « Synchroniser » reste utilisable. ${since}`);
  }
  if (status.running) return health("running", "blue", "Synchronisation en cours", since);
  if (success !== null && current - success > staleMs) {
    return health(
      "late",
      "amber",
      `Données ${formatRelative(status.lastSuccessAt!, now).replace("il y a", "d'il y a")}`,
      schedulerActive
        ? `${since} Le planificateur tourne mais aucune exécution n'a abouti depuis.`
        : `${since} Aucun planificateur ne s'est manifesté récemment : les données ne se mettent à jour qu'à l'ouverture de cet espace ou avec le bouton.`,
    );
  }
  return health("ok", "green", `À jour ${formatRelative(status.lastSuccessAt!, now)}`, schedulerActive ? `${since} Le planificateur tourne.` : since);
}

const WINDOW_LABELS: Record<string, string> = { "15min": "sur 15 minutes", "1day": "sur 24 heures", "30days": "sur 30 jours" };
/** Durée de la pause selon la fenêtre du quota entamé, en secondes. */
const WINDOW_PAUSE: Record<string, number> = { "15min": 15 * 60, "1day": 60 * 60, "30days": 6 * 60 * 60 };

/**
 * Quota Buffer presque épuisé : on suspend les exécutions planifiées pour garder de quoi programmer
 * les publications approuvées et synchroniser à la main. Les clés ont la forme « 100-in-15min ».
 * Réserve : 10 % du quota de la fenêtre (au moins 5 requêtes).
 */
export function quotaBackoff(rateLimit: Record<string, number> | null | undefined): { seconds: number; reason: string } | null {
  let worst: { seconds: number; reason: string } | null = null;
  for (const [key, remaining] of Object.entries(rateLimit ?? {})) {
    const match = key.match(/^(\d+)-in-(.+)$/);
    if (!match) continue;
    const reserve = Math.max(5, Math.ceil(Number(match[1]) / 10));
    if (remaining > reserve) continue;
    const seconds = WINDOW_PAUSE[match[2]] ?? 15 * 60;
    if (!worst || seconds > worst.seconds) {
      worst = { seconds, reason: `Quota Buffer presque épuisé (${remaining} requête${remaining > 1 ? "s" : ""} restante${remaining > 1 ? "s" : ""} ${WINDOW_LABELS[match[2]] ?? match[2]}) : synchronisations planifiées suspendues.` };
    }
  }
  return worst;
}

/** Nombre de requêtes Buffer par mois pour un intervalle donné (une lecture par exécution). */
export function monthlyRequests(intervalMinutes: number): number {
  return Math.round((30 * 24 * 60) / intervalMinutes);
}
