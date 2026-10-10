import "server-only";

import { quotaBackoff } from "@/lib/domain/sync-health";
import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { describeError as describe, rpcForMode, type ClaimedPost, type Lease } from "@/server/compensation";
import { dispatchNotifications } from "@/server/notifications";
import { getProvider } from "@/server/publishing";
import { activeRateLimitPause, DEFAULT_RATE_LIMIT_PAUSE_SECONDS, recordRateLimit } from "@/server/quota";
import { pilotLeadSatisfied } from "@/lib/domain/schedule-margins";
import { env } from "@/server/env";
import { ProviderError, sameContent, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";
import { runUrgentCycle } from "@/server/urgent";

export { recordRateLimit };

/*
 * Couche de service : tout ce qui relie Buffer et la base passe par ici.
 * Elle n'utilise que le contrat PublishingProvider et des fonctions SQL protégées par secret :
 * n8n pourra la remplacer en appelant les mêmes fonctions SQL, sans toucher à l'interface.
 */

export interface SyncResult {
  ok: boolean;
  error?: string;
  fetched: number;
  created: number;
  updated: number;
  invalidated: number;
  removed: number;
  scheduled: number;
  scheduleFailures: number;
  unscheduled: number;
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
  if (!snapshot.complete) notes.anomalies.push("Lecture de Buffer incomplète : les publications absentes n'ont pas été marquées comme supprimées.");
  const send = (label: string, payload: Record<string, unknown>) =>
    rpc<PullCounts & { unresolved?: string[] }>("sync_buffer_posts", {
      p_payload: { mode: provider.mode, triggeredBy: label, rateLimit: snapshot.rateLimit, ...payload },
    });
  const { unresolved = [], ...counts } = await send(triggeredBy, { complete: snapshot.complete, channels: snapshot.channels, posts: snapshot.posts });
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

/**
 * 2. Programme dans Buffer les posts approuvés.
 * La base « réserve » chaque post de façon atomique : deux appels simultanés ne peuvent pas
 * programmer le même post. Avant d'agir, le contenu est relu dans Buffer : s'il diffère de
 * ce que le client a validé, rien n'est programmé.
 */
export interface ScheduleOutcome {
  scheduled: number;
  failures: number;
  stale: boolean;
  rateLimited: ProviderError | null;
  /** Compensation exécutée dans la foulée d'une confirmation périmée (déprogrammation constatée dans Buffer). */
  compensated: number;
  compensationFailures: number;
  /** Quota en pause : rien n'a été réservé ni programmé. */
  paused?: { until: string; reason: string | null };
}

export async function scheduleApprovedPosts(postId?: string, options: { ignorePause?: boolean; lease?: Lease } = {}): Promise<ScheduleOutcome> {
  const provider = getProvider();
  const none: ScheduleOutcome = { scheduled: 0, failures: 0, stale: false, rateLimited: null, compensated: 0, compensationFailures: 0 };
  if (!options.ignorePause) {
    const paused = await activeRateLimitPause(provider.mode);
    if (paused) return { ...none, paused };
  }
  const claimed = await rpcForMode("claim_posts_for_scheduling", provider.mode, { p_post_id: postId ?? null });
  let scheduled = 0;
  let failures = 0;
  let stale = false;
  let rateLimited: ProviderError | null = null;

  let blocked: string | null = null;
  /** Le jeton accompagne toute confirmation : une réservation périmée ne peut pas être confirmée. */
  const withToken = (post: ClaimedPost) => (post.token ? { p_token: post.token } : {});

  for (const post of claimed) {
    // Profil pilote : échéance d'au moins 24 h, vérifiée à CHAQUE programmation (un accord ancien repris tardivement
    // ne contourne pas la règle). Rien n'est envoyé à Buffer ; la réservation est libérée avec un échec certain.
    if (env.profile === "pilot" && !pilotLeadSatisfied(post.due_at)) {
      failures += 1;
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: "Profil pilote : l'échéance est à moins de 24 h, programmation refusée (déplacez la date et redemandez l'accord).", ...withToken(post) });
      continue;
    }
    // Un bail perdu (exécution trop longue, reprise par un autre processus) : plus aucun effet externe depuis ici.
    if (!blocked && options.lease && !(await options.lease.ensure())) blocked = "Bail de synchronisation perdu : exécution interrompue.";
    if (blocked) {
      // Buffer est hors d'atteinte : inutile d'insister, ces posts seront repris à la prochaine synchronisation.
      failures += 1;
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: blocked, ...withToken(post) });
      continue;
    }
    try {
      const live = await provider.getPost(post.buffer_post_id);
      if (!live) throw new ProviderError("Ce post n'existe plus dans Buffer.");
      if (!live.hasReviewTag) {
        stale = true;
        throw new ProviderError("Le tag de validation a été retiré dans Buffer : une nouvelle validation est nécessaire.");
      }
      if (!sameContent({ text: post.text, dueAt: post.due_at, assets: post.assets }, live)) {
        stale = true;
        throw new ProviderError("Le contenu a été modifié dans Buffer depuis la validation : une nouvelle validation est nécessaire.");
      }
      if (live.status !== "scheduled") {
        if (live.status !== "draft") throw new ProviderError(`Statut Buffer inattendu : « ${live.status} ».`);
        const registered = await provider.schedulePost(live);
        // Le contenu que Buffer a effectivement programmé est celui qu'il renvoie : s'il diffère de ce qui a été
        // validé (modification concurrente), la programmation est à annuler tout de suite.
        if (!registered.hasReviewTag || !sameContent({ text: post.text, dueAt: post.due_at, assets: post.assets }, registered)) {
          stale = true;
          failures += 1;
          await rpc("mark_unschedule_needed", { p_post_id: post.id, p_reason: "Le contenu programmé dans Buffer diffère de celui qui a été validé." });
          continue;
        }
      }
      // La confirmation est conditionnelle : si la validation a changé entre-temps, la base répond « stale »
      // et le post est repassé en « annulation à confirmer » (Buffer a déjà accepté la programmation).
      const outcome = await rpc<string | null>("complete_scheduling", { p_post_id: post.id, p_ok: true, ...withToken(post) });
      if (outcome === "stale") {
        stale = true;
        failures += 1;
      } else if (outcome === "superseded" || outcome === "ignored") {
        // Une réservation plus récente (ou un autre état) décide : cette confirmation n'a aucun effet.
      } else {
        scheduled += 1;
      }
    } catch (error) {
      failures += 1;
      if (error instanceof ProviderError && error.kind !== "api") blocked = describe(error);
      if (error instanceof ProviderError && error.kind === "rate_limit") rateLimited ??= error;
      // Résultat incertain : Buffer a peut-être programmé. Le message le dit ; la synchronisation constatera l'état réel.
      const uncertain = error instanceof ProviderError && error.outcome === "unknown";
      const message = uncertain ? `Résultat incertain : ${describe(error)} Vérification à la prochaine synchronisation.` : describe(error);
      // Résultat inconnu : la réservation reste « en cours » (ce n'est pas un échec certain) ; le traitement urgent la
      // rapprochera de l'état réel de Buffer.
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: message, ...(uncertain ? { p_uncertain: true } : {}), ...withToken(post) });
    }
  }
  if (rateLimited) await recordRateLimit(rateLimited, provider.mode);

  // Compensation IMMÉDIATE d'une programmation devenue illégitime : on n'attend pas la prochaine synchronisation
  // (qui peut venir après l'échéance). Si elle échoue, l'état « annulation à confirmer » reste en base et la reprise
  // est prioritaire à chaque cycle (voir doSync) ; rien n'est annoncé comme annulé tant que Buffer ne l'a pas confirmé.
  let compensated = 0;
  let compensationFailures = 0;
  if (stale && !rateLimited) {
    const compensation = await runUrgentCycle(provider, { lease: options.lease });
    compensated = compensation.compensated;
    compensationFailures = compensation.compensationFailures;
    rateLimited ??= compensation.rateLimited;
  }
  return { scheduled, failures, stale, rateLimited, compensated, compensationFailures };
}

/**
 * Compensation immédiate des programmations « à confirmer » nées d'une action isolée (transfert ou détachement d'un
 * canal, archivage d'un client, retrait d'un membre) : on n'attend pas le prochain cycle. Un refus de quota (429)
 * en cours n'est PAS contourné ; une pause préventive ne l'empêche pas. En cas d'échec, l'état reste en base et la
 * reprise urgente (urgent.ts, indépendante du poll de 30 minutes) s'en charge. Aucune erreur n'est levée.
 */
export async function compensatePendingUnschedules(): Promise<{ done: number; failures: number }> {
  try {
    const result = await runUrgentCycle(getProvider());
    return { done: result.compensated, failures: result.compensationFailures };
  } catch {
    return { done: 0, failures: 0 };
  }
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
  const provider = getProvider();
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
  // Bail du verrou : renouvelé avant chaque écriture externe. Une exécution plus longue que le bail ne continue
  // jamais « en détenteur » après son expiration (une autre exécution a pu le reprendre).
  const lease: Lease = lock?.token
    ? { ensure: async () => (await rpc<boolean>("renew_sync_run", { p_mode: provider.mode, p_token: lock!.token, p_ttl_seconds: LOCK_TTL_SECONDS }).catch((error) => (error instanceof MissingFunctionError ? true : false))) !== false }
    : { ensure: async () => true };
  const { result, rateLimited } = await doSync(provider, triggeredBy, notes, options, lease);
  if (result.scheduleFailures) notes.anomalies.push(`${result.scheduleFailures} publication(s) approuvée(s) n'ont pas pu être programmées dans Buffer.`);
  if (result.unscheduleFailures) notes.anomalies.push(`${result.unscheduleFailures} publication(s) modifiée(s) après validation sont encore programmées dans Buffer.`);

  // Un refus (429) est enregistré comme tel : aucune écriture, aucune compensation avant l'échéance demandée.
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
  provider: PublishingProvider, triggeredBy: string, notes: RunNotes, options: SyncOptions, lease: Lease,
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
    // La compensation ne dépend pas de la lecture : une programmation à annuler est reprise à CHAQUE cycle, avant
    // toute nouvelle programmation, même quand la lecture de Buffer a échoué.
    const urgent = await runUrgentCycle(provider, { lease });
    const unscheduled = { done: urgent.compensated, failures: urgent.compensationFailures, blocked: urgent.ok ? null : (urgent.error ?? "traitement urgent incomplet"), rateLimited: urgent.rateLimited };
    // Une panne d'infrastructure du traitement urgent (base non migrée, base injoignable) est une erreur de synchronisation.
    if (!urgent.ok && urgent.compensationFailures === 0 && !urgent.rateLimited && urgent.error) throw new Error(urgent.error);
    Object.assign(progress, { unscheduled: unscheduled.done, unscheduleFailures: unscheduled.failures });
    if (pullFailure) {
      const message = describe(pullFailure);
      await rpc("record_sync_failure", { p_mode: provider.mode, p_error: message, p_triggered_by: triggeredBy }).catch(() => undefined);
      return {
        result: { ...progress, ok: false, error: message },
        rateLimited: (pullFailure instanceof ProviderError && pullFailure.kind === "rate_limit" ? pullFailure : null) ?? unscheduled.rateLimited,
      };
    }

    const skipped: ScheduleOutcome = { scheduled: 0, failures: 0, stale: false, rateLimited: null, compensated: 0, compensationFailures: 0 };
    // Une exécution manuelle est un choix explicite de l'administrateur : elle ne s'arrête pas sur la pause du planificateur.
    const scheduling = unscheduled.blocked ? skipped : await scheduleApprovedPosts(undefined, { ignorePause: !options.scheduled, lease });
    Object.assign(progress, {
      scheduled: scheduling.scheduled,
      scheduleFailures: scheduling.failures,
      unscheduled: unscheduled.done + scheduling.compensated,
      unscheduleFailures: unscheduled.failures + scheduling.compensationFailures,
    });
    // Un contenu modifié a été détecté pendant la programmation : on relit Buffer pour annuler la validation.
    if (scheduling.stale) {
      const reread = await pull(provider, `${triggeredBy}:relecture`, notes);
      counts = {
        fetched: reread.fetched,
        created: counts.created + reread.created,
        updated: counts.updated + reread.updated,
        invalidated: counts.invalidated + reread.invalidated,
        removed: counts.removed + reread.removed,
      };
    }
    const unscheduleFailures = unscheduled.failures + scheduling.compensationFailures;
    const ok = unscheduleFailures === 0 && scheduling.failures === 0;
    // Un quota atteint pendant une écriture est propagé : la pause demandée par Buffer s'applique.
    const rateLimited = unscheduled.rateLimited ?? scheduling.rateLimited;
    if (!ok) {
      await rpc("record_sync_failure", {
        p_mode: provider.mode, p_triggered_by: triggeredBy,
        p_error: `${scheduling.failures} échec(s) de programmation ; ${unscheduleFailures} échec(s) de déprogrammation.`,
      }).catch(() => undefined);
    }
    return {
      rateLimited,
      result: {
        ...EMPTY, ...counts, ok,
        ...(ok ? {} : { error: "Synchronisation partielle : certaines publications n'ont pas pu être programmées ou repassées en brouillon." }),
        unscheduled: unscheduled.done + scheduling.compensated, unscheduleFailures,
        scheduled: scheduling.scheduled, scheduleFailures: scheduling.failures,
      },
    };
  } catch (error) {
    const message = describe(error);
    await rpc("record_sync_failure", { p_mode: provider.mode, p_error: message, p_triggered_by: triggeredBy }).catch(() => undefined);
    return { result: { ...progress, ok: false, error: message }, rateLimited: error instanceof ProviderError && error.kind === "rate_limit" ? error : null };
  }
}
