import "server-only";

import { quotaBackoff } from "@/lib/domain/sync-health";
import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { describeError as describe, type Lease } from "@/server/compensation";
import { dispatchNotifications } from "@/server/notifications";
import { getProvider } from "@/server/publishing";
import { activeRateLimitPause, DEFAULT_RATE_LIMIT_PAUSE_SECONDS, recordRateLimit } from "@/server/quota";
import { ProviderError, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";
import { runUrgentCycle } from "@/server/urgent";

export { recordRateLimit };

/*
 * Couche de service : tout ce qui relie Buffer et la base passe par ici.
 *
 * LECTURE SEULE vis-à-vis de Buffer : la synchronisation lit Buffer et met la base à jour. Elle ne programme, ne
 * déprogramme, ne crée et ne modifie RIEN dans Buffer, quelle que soit la configuration. La programmation se fait à
 * la main dans Buffer, après l'accord du client ; Cadence constate ensuite l'état réel et signale les écarts.
 */

export interface SyncResult {
  ok: boolean;
  error?: string;
  fetched: number;
  created: number;
  updated: number;
  invalidated: number;
  removed: number;
  /** Toujours 0 : Cadence ne programme rien dans Buffer (champ conservé pour les appelants existants). */
  scheduled: number;
  /** Toujours 0, pour la même raison. */
  scheduleFailures: number;
  /** Retours en brouillon (ou publications) CONSTATÉS dans Buffer pour des publications dont l'accord n'est plus valable. */
  unscheduled: number;
  /** Publications encore programmées dans Buffer sans accord valable : à repasser en brouillon à la main. */
  unscheduleFailures: number;
  /** Rien n'a été fait : une autre synchronisation est en cours, ou les exécutions planifiées sont en pause. */
  skipped?: "running" | "backoff";
  /** Situations à signaler à l'administrateur, enregistrées avec l'état de la synchronisation. */
  anomalies?: string[];
}

type PullCounts = Pick<SyncResult, "fetched" | "created" | "updated" | "invalidated" | "removed">;

/** Ce qu'une exécution apprend en chemin et qui sert à l'état de la synchronisation. */
interface RunNotes {
  rateLimit: Record<string, number> | null;
  anomalies: string[];
}

/**
 * 1. Lit Buffer et met la base à jour (une transaction SQL).
 * La base peut signaler des posts programmés, à date passée, absents de la lecture : sans doute
 * publiés, mais sortis de la liste des derniers posts publiés. Ils sont relus un par un pour
 * enregistrer leur vrai statut, ou leur disparition si Buffer ne les connaît plus.
 */
async function pull(provider: PublishingProvider, triggeredBy: string, notes: RunNotes): Promise<PullCounts> {
  const snapshot = await provider.fetchSnapshot();
  notes.rateLimit = snapshot.rateLimit ?? notes.rateLimit;
  for (const failure of snapshot.connectionErrors ?? []) {
    notes.anomalies.push(failure.label ? `Compte « ${failure.label} » non lu : ${failure.message}` : failure.message);
  }
  for (const skipped of snapshot.skippedConnections ?? []) {
    notes.anomalies.push(`Compte « ${skipped.label} » : quota presque épuisé, lectures planifiées espacées jusqu'au ${skipped.until.slice(0, 16).replace("T", " à ")} UTC (les autres comptes ne sont pas concernés).`);
  }
  if (!snapshot.complete && !snapshot.scopeConnectionIds) notes.anomalies.push("Lecture de Buffer incomplète : les publications absentes n'ont pas été marquées comme supprimées.");
  // Relevé de plusieurs comptes : seules les publications des comptes lus EN ENTIER peuvent être déclarées retirées.
  const scope = snapshot.scopeConnectionIds ? { scopeConnectionIds: snapshot.scopeConnectionIds } : {};
  const complete = snapshot.scopeConnectionIds ? snapshot.scopeConnectionIds.length > 0 : snapshot.complete;
  const send = (label: string, payload: Record<string, unknown>) =>
    rpc<PullCounts & { unresolved?: string[]; conflicts?: number }>("sync_buffer_posts", {
      p_payload: { mode: provider.mode, triggeredBy: label, rateLimit: snapshot.rateLimit, ...scope, ...payload },
    });
  const { unresolved = [], conflicts = 0, ...counts } = await send(triggeredBy, { complete, channels: snapshot.channels, posts: snapshot.posts });
  if (conflicts > 0) notes.anomalies.push(`${conflicts} canal ou publication annoncé(s) par un compte alors qu'ils appartiennent à un autre : ignorés (aucune fusion entre comptes).`);
  if (unresolved.length === 0) return counts;

  const found: ProviderPost[] = [];
  const confirmedGone: string[] = [];
  try {
    for (const id of unresolved) {
      const live = await provider.getPost(id);
      if (live) found.push(live);
      else confirmedGone.push(id);
    }
  } catch {
    // Buffer hors d'atteinte ou quota atteint : les posts restants seront relus à la prochaine synchronisation.
    notes.anomalies.push(`${unresolved.length - found.length - confirmedGone.length} publication(s) programmée(s) à date passée n'ont pas pu être relues dans Buffer.`);
  }
  if (found.length === 0 && confirmedGone.length === 0) return counts;
  const checked = await send(`${triggeredBy}:contrôle`, { complete: false, channels: [], posts: found, confirmedGone });
  return { ...counts, updated: counts.updated + checked.updated, removed: counts.removed + checked.removed };
}

const EMPTY: SyncResult = {
  ok: true,
  fetched: 0,
  created: 0,
  updated: 0,
  invalidated: 0,
  removed: 0,
  scheduled: 0,
  scheduleFailures: 0,
  unscheduled: 0,
  unscheduleFailures: 0,
};

let running: Promise<SyncResult> | null = null;

export interface SyncOptions {
  /** true : déclenchée par le planificateur. Elle respecte alors la pause posée après un quota atteint. */
  scheduled?: boolean;
}

/** Durée de vie du verrou : s'il n'est jamais rendu (serveur arrêté en cours de route), il expire seul. */
const LOCK_TTL_SECONDS = 300;

/**
 * Synchronisation complète. Une seule à la fois :
 * - dans ce serveur, les appels simultanés partagent le même résultat ;
 * - entre serveurs et planificateurs, la base délivre un verrou (begin_sync_run, migration 0006).
 */
export function runSync(triggeredBy: string, options: SyncOptions = {}): Promise<SyncResult> {
  running ??= guardedSync(triggeredBy, options).finally(() => {
    running = null;
  });
  return running;
}

interface Lock {
  acquired?: boolean;
  token?: string;
  reason?: "running" | "backoff";
  detail?: string | null;
}

async function guardedSync(triggeredBy: string, options: SyncOptions): Promise<SyncResult> {
  const provider = getProvider({ scheduled: options.scheduled });
  // Un refus de Buffer (429) vaut pour TOUS les chemins, manuels compris : aucune requête n'est tentée avant
  // l'échéance demandée (elles seraient refusées et prolongeraient le refus). Une pause préventive, elle, laisse
  // l'exécution manuelle possible.
  // (Les exécutions planifiées sont déjà arrêtées par le verrou de la base pendant toute pause.)
  const refused = options.scheduled ? null : await activeRateLimitPause(provider.mode);
  if (refused?.hard) {
    return { ...EMPTY, ok: true, skipped: "backoff", error: `Quota Buffer refusé : aucune requête avant ${refused.until}. ${refused.reason ?? ""}`.trim() };
  }
  let lock: Lock | null = null;
  try {
    lock = await rpc<Lock | null>("begin_sync_run", {
      p_mode: provider.mode, p_triggered_by: triggeredBy, p_scheduled: options.scheduled ?? false, p_ttl_seconds: LOCK_TTL_SECONDS,
    });
  } catch (error) {
    // Base sans la migration 0006 : on continue avec le seul verrou interne au serveur.
    if (!(error instanceof MissingFunctionError)) return { ...EMPTY, ok: false, error: describe(error) };
  }
  if (lock?.acquired === false) {
    return {
      ...EMPTY,
      skipped: lock.reason ?? "running",
      error: lock.reason === "backoff" ? (lock.detail ?? "Synchronisations planifiées en pause.") : "Une synchronisation est déjà en cours.",
    };
  }

  const notes: RunNotes = { rateLimit: null, anomalies: [] };
  // Bail du verrou : une exécution plus longue que le bail ne continue jamais « en détenteur » après son expiration
  // (une autre exécution a pu le reprendre).
  const lease: Lease = lock?.token
    ? { ensure: async () => (await rpc<boolean>("renew_sync_run", { p_mode: provider.mode, p_token: lock!.token, p_ttl_seconds: LOCK_TTL_SECONDS }).catch((error) => (error instanceof MissingFunctionError ? true : false))) !== false }
    : { ensure: async () => true };
  const { result, rateLimited } = await doSync(provider, triggeredBy, notes, lease);
  if (result.unscheduleFailures) notes.anomalies.push(`${result.unscheduleFailures} publication(s) sont programmées dans Buffer sans accord valable du client : repassez-les en brouillon dans Buffer.`);

  // Un refus (429) est enregistré comme tel : aucune requête avant l'échéance demandée.
  if (rateLimited) await recordRateLimit(rateLimited, provider.mode);
  if (lock?.token) {
    const backoff = rateLimited
      ? { seconds: rateLimited.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_PAUSE_SECONDS, reason: "Quota de requêtes Buffer atteint : synchronisations planifiées suspendues." }
      : quotaBackoff(notes.rateLimit);
    await rpc("finish_sync_run", {
      p_mode: provider.mode, p_token: lock.token, p_ok: result.ok, p_error: result.error ?? null,
      p_backoff_seconds: backoff?.seconds ?? 0, p_backoff_reason: backoff?.reason ?? null, p_anomalies: notes.anomalies,
    }).catch(() => undefined);
  }
  // Les événements de cette exécution (soumissions, échecs) ont pu mettre des notifications en attente.
  await dispatchNotifications().catch(() => undefined);
  return { ...result, anomalies: notes.anomalies };
}

async function doSync(
  provider: PublishingProvider, triggeredBy: string, notes: RunNotes, lease: Lease,
): Promise<{ result: SyncResult; rateLimited: ProviderError | null }> {
  const progress = { ...EMPTY };
  try {
    let counts: PullCounts;
    let pullFailure: unknown = null;
    try {
      counts = await pull(provider, triggeredBy, notes);
      Object.assign(progress, counts);
    } catch (error) {
      pullFailure = error;
      counts = { fetched: 0, created: 0, updated: 0, invalidated: 0, removed: 0 };
    }
    // Constat (lectures seules) : les publications dont l'accord n'est plus valable sont relues dans Buffer. Un retour
    // en brouillon fait à la main y est enregistré ; une publication encore programmée reste signalée. Rien n'est écrit.
    const urgent = await runUrgentCycle(provider, { lease });
    // Une panne d'infrastructure du constat (base non migrée, base injoignable) est une erreur de synchronisation.
    if (!urgent.ok && urgent.compensationFailures === 0 && !urgent.rateLimited && urgent.error) throw new Error(urgent.error);
    Object.assign(progress, { unscheduled: urgent.compensated, unscheduleFailures: urgent.compensationFailures });
    if (pullFailure) {
      const message = describe(pullFailure);
      await rpc("record_sync_failure", { p_mode: provider.mode, p_error: message, p_triggered_by: triggeredBy }).catch(() => undefined);
      return {
        result: { ...progress, ok: false, error: message },
        rateLimited: (pullFailure instanceof ProviderError && pullFailure.kind === "rate_limit" ? pullFailure : null) ?? urgent.rateLimited,
      };
    }

    const ok = urgent.compensationFailures === 0;
    if (!ok) {
      await rpc("record_sync_failure", {
        p_mode: provider.mode, p_triggered_by: triggeredBy,
        p_error: `${urgent.compensationFailures} publication(s) programmée(s) dans Buffer sans accord valable.`,
      }).catch(() => undefined);
    }
    return {
      rateLimited: urgent.rateLimited,
      result: {
        ...EMPTY, ...counts, ok,
        ...(ok ? {} : { error: "Synchronisation partielle : des publications sont programmées dans Buffer sans accord valable du client. Repassez-les en brouillon dans Buffer." }),
        unscheduled: urgent.compensated, unscheduleFailures: urgent.compensationFailures,
      },
    };
  } catch (error) {
    const message = describe(error);
    await rpc("record_sync_failure", { p_mode: provider.mode, p_error: message, p_triggered_by: triggeredBy }).catch(() => undefined);
    return { result: { ...progress, ok: false, error: message }, rateLimited: error instanceof ProviderError && error.kind === "rate_limit" ? error : null };
  }
}
