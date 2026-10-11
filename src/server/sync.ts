import "server-only";

import { quotaBackoff } from "@/lib/domain/sync-health";
import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { describeError as describe, rpcForMode, type ClaimedPost, type Lease } from "@/server/compensation";
import { env } from "@/server/env";
import { dispatchNotifications } from "@/server/notifications";
import { getProvider } from "@/server/publishing";
import { activeRateLimitPause, DEFAULT_RATE_LIMIT_PAUSE_SECONDS, recordRateLimit } from "@/server/quota";
import { ProviderError, sameContent, type ProviderPost, type PublishingProvider } from "@/server/publishing/provider";
import { runUrgentCycle } from "@/server/urgent";

export { recordRateLimit };

/*
 * Couche de service : tout ce qui relie Buffer et la base passe par ici.
 *
 * La synchronisation lit Buffer et met la base à jour. La SEULE écriture vers Buffer est la programmation d'un
 * brouillon approuvé par le client (`scheduleApprovedPosts`) : appelée dès l'accord, et reprise à chaque
 * synchronisation pour ce qui n'a pas abouti. Cadence ne crée, ne modifie, ne supprime et ne déprogramme rien : une
 * publication programmée sans accord valable est signalée, jamais repassée en brouillon d'ici.
 */

export interface ScheduleOutcome {
  /** Publications réservées pour ce passage (approuvées, datées, pas encore programmées). */
  claimed: number;
  scheduled: number;
  failures: number;
  /** Le contenu trouvé dans Buffer n'est plus celui que le client a validé : une relecture annulera l'accord. */
  stale: boolean;
  rateLimited: ProviderError | null;
  /** Quota en pause : rien n'a été réservé ni programmé. */
  paused?: { until: string; reason: string | null };
  /** Programmation coupée sur ce serveur (CADENCE_BUFFER_SCHEDULING=off) : rien n'a été réservé. */
  writesDisabled?: boolean;
}

/**
 * Programme dans Buffer les publications que le client a approuvées (une seule si `postId` est fourni).
 *
 * Garanties :
 *  - la base ne réserve qu'un accord valable sur le contenu courant, et rend un jeton que la confirmation représente ;
 *  - la publication est RELUE dans Buffer juste avant : si son texte, ses médias ou sa date ne sont plus ceux qui ont
 *    été validés, rien n'est programmé ;
 *  - seul un brouillon est programmé, à la date qu'il porte déjà ; un résultat incertain n'est jamais présenté comme
 *    une réussite (la synchronisation suivante constate l'état réel).
 */
export async function scheduleApprovedPosts(postId?: string, options: { ignorePause?: boolean; lease?: Lease } = {}): Promise<ScheduleOutcome> {
  const provider = getProvider();
  const none: ScheduleOutcome = { claimed: 0, scheduled: 0, failures: 0, stale: false, rateLimited: null };
  if (provider.mode === "real" && !env.bufferWritesEnabled) return { ...none, writesDisabled: true };
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
    // Un bail perdu (exécution trop longue, reprise par un autre processus) : plus aucun effet externe depuis ici.
    if (!blocked && options.lease && !(await options.lease.ensure())) blocked = "Bail de synchronisation perdu : exécution interrompue.";
    if (blocked) {
      // Buffer est hors d'atteinte : inutile d'insister, ces publications seront reprises à la prochaine synchronisation.
      failures += 1;
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: blocked, ...withToken(post) });
      continue;
    }
    try {
      const live = await provider.getPost(post.buffer_post_id);
      if (!live) throw new ProviderError("Ce post n'existe plus dans Buffer.");
      if (!sameContent({ text: post.text, dueAt: post.due_at, assets: post.assets }, live)) {
        stale = true;
        throw new ProviderError("Le contenu a été modifié dans Buffer depuis la validation : une nouvelle validation est nécessaire.");
      }
      if (live.status !== "scheduled") {
        if (live.status !== "draft") throw new ProviderError(`Statut Buffer inattendu : « ${live.status} ».`);
        const registered = await provider.schedulePost(live);
        // Ce que Buffer a réellement programmé est ce qu'il renvoie : s'il diffère du contenu validé (modification
        // au même instant), la publication est signalée « programmée sans accord valable ».
        if (!sameContent({ text: post.text, dueAt: post.due_at, assets: post.assets }, registered)) {
          stale = true;
          failures += 1;
          await rpc("mark_unschedule_needed", { p_post_id: post.id, p_reason: "Le contenu programmé dans Buffer diffère de celui qui a été validé." });
          continue;
        }
      }
      // Confirmation conditionnelle : si la validation a changé entre-temps, la base répond « stale ».
      const outcome = await rpc<string | null>("complete_scheduling", { p_post_id: post.id, p_ok: true, ...withToken(post) });
      if (outcome === "stale") {
        stale = true;
        failures += 1;
      } else if (outcome !== "superseded" && outcome !== "ignored") {
        scheduled += 1;
      }
    } catch (error) {
      failures += 1;
      if (error instanceof ProviderError && error.kind !== "api" && !error.connectionId) blocked = describe(error);
      if (error instanceof ProviderError && error.kind === "rate_limit" && !error.connectionId) rateLimited ??= error;
      // Résultat incertain : Buffer a peut-être programmé. La réservation reste « en cours » ; la synchronisation
      // suivante constate l'état réel.
      const uncertain = error instanceof ProviderError && error.outcome === "unknown";
      const message = uncertain ? `Résultat incertain : ${describe(error)} Vérification à la prochaine synchronisation.` : describe(error);
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: message, ...(uncertain ? { p_uncertain: true } : {}), ...withToken(post) });
    }
  }
  if (rateLimited) await recordRateLimit(rateLimited, provider.mode);
  return { claimed: claimed.length, scheduled, failures, stale, rateLimited };
}

export interface SyncResult {
  ok: boolean;
  error?: string;
  fetched: number;
  created: number;
  updated: number;
  invalidated: number;
  removed: number;
  /** Publications approuvées que ce passage a programmées dans Buffer. */
  scheduled: number;
  /** Publications approuvées dont la programmation n'a pas abouti (reprises au passage suivant). */
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
  const { result, rateLimited } = await doSync(provider, triggeredBy, notes, lease, options.scheduled === true);
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
  provider: PublishingProvider, triggeredBy: string, notes: RunNotes, lease: Lease, scheduledRun: boolean,
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

    // Reprise des publications approuvées qui ne sont pas encore programmées (accord donné pendant une panne ou une
    // pause de quota, date fixée après l'accord). Un quota refusé pendant le constat suspend ce passage.
    // Une exécution manuelle est un choix explicite de l'administrateur : elle ne s'arrête pas sur la pause du planificateur.
    const scheduling: ScheduleOutcome = urgent.rateLimited
      ? { claimed: 0, scheduled: 0, failures: 0, stale: false, rateLimited: null }
      : await scheduleApprovedPosts(undefined, { ignorePause: !scheduledRun, lease });
    Object.assign(progress, { scheduled: scheduling.scheduled, scheduleFailures: scheduling.failures });
    // Un contenu modifié a été détecté pendant la programmation : Buffer est relu pour annuler l'accord tout de suite.
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

    const ok = urgent.compensationFailures === 0 && scheduling.failures === 0;
    if (!ok) {
      await rpc("record_sync_failure", {
        p_mode: provider.mode, p_triggered_by: triggeredBy,
        p_error: `${scheduling.failures} échec(s) de programmation ; ${urgent.compensationFailures} publication(s) programmée(s) dans Buffer sans accord valable.`,
      }).catch(() => undefined);
    }
    const problems = [
      ...(scheduling.failures ? ["certaines publications approuvées n'ont pas pu être programmées dans Buffer (nouvel essai à la prochaine synchronisation)"] : []),
      ...(urgent.compensationFailures ? ["des publications sont programmées dans Buffer sans accord valable du client : repassez-les en brouillon dans Buffer"] : []),
    ];
    return {
      rateLimited: urgent.rateLimited ?? scheduling.rateLimited,
      result: {
        ...EMPTY, ...counts, ok,
        ...(ok ? {} : { error: `Synchronisation partielle : ${problems.join(" ; ")}.` }),
        unscheduled: urgent.compensated, unscheduleFailures: urgent.compensationFailures,
        scheduled: scheduling.scheduled, scheduleFailures: scheduling.failures,
      },
    };
  } catch (error) {
    const message = describe(error);
    await rpc("record_sync_failure", { p_mode: provider.mode, p_error: message, p_triggered_by: triggeredBy }).catch(() => undefined);
    return { result: { ...progress, ok: false, error: message }, rateLimited: error instanceof ProviderError && error.kind === "rate_limit" ? error : null };
  }
}
