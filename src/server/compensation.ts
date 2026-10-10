import "server-only";

import type { PostAsset } from "@/lib/types";
import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { activeRateLimitPause, recordRateLimit } from "@/server/quota";
import { ProviderError, sameContent, type PublishingProvider } from "@/server/publishing/provider";

/*
 * Compensation des programmations devenues illégitimes et rapprochement des réservations abandonnées.
 *
 * Partagée par la synchronisation générale (sync.ts) et par le traitement urgent (urgent.ts), qui ne dépend pas du
 * poll de 30 minutes. Règles :
 *  - seul un statut CONSTATÉ chez le fournisseur est enregistré comme résultat ;
 *  - un refus de quota (429) n'est jamais contourné : l'urgence reste visible, rien n'est annoncé annulé ;
 *  - le détenteur d'un bail perdu s'arrête (il n'agit plus comme un nouveau détenteur).
 */

export interface ClaimedPost {
  id: string;
  buffer_post_id: string;
  text: string;
  assets: PostAsset[];
  due_at: string | null;
  service: string;
  /** Jeton de réservation (migration 0009) : la confirmation doit le représenter. Absent d'un ancien schéma. */
  token?: string;
}

/** Bail d'un traitement : `ensure` le renouvelle ; faux = perdu, le traitement doit s'arrêter sans écrire. */
export interface Lease {
  ensure(): Promise<boolean>;
}

export const NO_LEASE: Lease = { ensure: async () => true };

export function describeError(error: unknown): string {
  if (error instanceof ProviderError && error.kind === "rate_limit") {
    return `Quota de requêtes Buffer atteint${error.retryAfterSeconds ? ` (réessayer dans ${Math.ceil(error.retryAfterSeconds / 60)} min)` : ""}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

const isMockId = (bufferPostId: string) => bufferPostId.startsWith("mock-");

/**
 * Appelle la fonction qui sépare données réelles et simulées (migration 0003).
 * Tant que la base ne l'a pas reçue, le mode réel se rabat sur l'ancienne fonction et écarte
 * lui-même les posts simulés. Le mode simulé, lui, refuse de continuer : l'ancienne fonction
 * lui ferait réserver de vrais posts.
 */
export async function rpcForMode(
  name: "claim_posts_for_scheduling" | "list_posts_to_unschedule",
  mode: PublishingProvider["mode"],
  params: Record<string, unknown>,
): Promise<ClaimedPost[]> {
  try {
    return (await rpc<ClaimedPost[]>(`${name}_in_mode`, { p_mode: mode, ...params })) ?? [];
  } catch (error) {
    if (!(error instanceof MissingFunctionError) || mode !== "real") throw error;
  }
  const posts = (await rpc<ClaimedPost[]>(name, params)) ?? [];
  for (const post of posts.filter((item) => isMockId(item.buffer_post_id))) {
    if (name === "claim_posts_for_scheduling") {
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: "Publication de démonstration : jamais envoyée au vrai Buffer." });
    }
  }
  return posts.filter((item) => !isMockId(item.buffer_post_id));
}

export interface CompensationOutcome {
  done: number;
  failures: number;
  blocked: string | null;
  rateLimited: ProviderError | null;
  /** Annulations laissées en attente sans appel : refus de quota en cours ou bail perdu. */
  deferred: number;
}

/** Repasse en brouillon les posts programmés dont la programmation n'est plus légitime. */
export async function unscheduleInvalidatedPosts(provider: PublishingProvider, options: { lease?: Lease } = {}): Promise<CompensationOutcome> {
  const lease = options.lease ?? NO_LEASE;
  const pending = await rpcForMode("list_posts_to_unschedule", provider.mode, {});
  const outcome: CompensationOutcome = { done: 0, failures: 0, blocked: null, rateLimited: null, deferred: 0 };
  if (pending.length === 0) return outcome;

  // Un refus de quota (429) n'est pas contourné, même pour annuler : l'état reste « à confirmer » et visible.
  const pause = await activeRateLimitPause(provider.mode);
  if (pause?.hard) {
    for (const post of pending) await rpc("complete_unscheduling", { p_post_id: post.id, p_ok: false, p_error: `Quota Buffer refusé jusqu'à ${pause.until} : annulation reportée.` });
    return { ...outcome, failures: pending.length, deferred: pending.length, blocked: "Quota Buffer atteint : annulations reportées." };
  }

  for (const [index, post] of pending.entries()) {
    if (!(await lease.ensure())) {
      outcome.deferred += pending.length - index;
      outcome.failures += pending.length - index;
      outcome.blocked ??= "Bail perdu : traitement interrompu, repris par le détenteur actuel.";
      break;
    }
    if (outcome.blocked) {
      outcome.failures += 1;
      await rpc("complete_unscheduling", { p_post_id: post.id, p_ok: false, p_error: outcome.blocked });
      continue;
    }
    try {
      const live = await provider.getPost(post.buffer_post_id);
      let observed: string = live ? live.status : "missing";
      if (live && (live.status === "scheduled" || live.status === "needs_approval")) {
        // Le fournisseur renvoie le post tel qu'il l'a enregistré : c'est CE statut qui fait foi, pas l'appel.
        const result = await provider.unschedulePost(live);
        observed = result.status;
      }
      // Seul un statut réellement constaté dans Buffer est enregistré. Un statut inattendu n'est jamais présenté
      // comme une annulation réussie : il reste « à confirmer » et sera relu.
      if (!["draft", "sent", "sending", "error", "missing"].includes(observed)) {
        throw new ProviderError(`Statut Buffer inattendu après la déprogrammation : « ${observed} ». L'annulation n'est pas confirmée.`);
      }
      await rpc("complete_unscheduling", { p_post_id: post.id, p_ok: true, p_observed_status: observed });
      outcome.done += 1;
    } catch (error) {
      outcome.failures += 1;
      if (error instanceof ProviderError && error.kind !== "api" && !error.connectionId) outcome.blocked = describeError(error);
      if (error instanceof ProviderError && error.kind === "rate_limit" && !error.connectionId) outcome.rateLimited ??= error;
      await rpc("complete_unscheduling", { p_post_id: post.id, p_ok: false, p_error: describeError(error) });
    }
  }
  if (outcome.rateLimited) await recordRateLimit(outcome.rateLimited, provider.mode);
  return outcome;
}

interface OrphanClaim extends ClaimedPost {
  token: string;
  claimed_at: string;
}

export interface OrphanOutcome {
  reconciled: number;
  /** Programmation constatée et conforme à l'accord : confirmée. */
  confirmed: number;
  /** Programmation constatée mais illégitime : compensation demandée (puis exécutée par le même passage). */
  toCancel: number;
  failures: number;
  rateLimited: ProviderError | null;
}

/**
 * Réservations de programmation abandonnées (processus arrêté entre l'acceptation par Buffer et la confirmation
 * locale). L'état réel est LU dans Buffer, puis rapproché de la tentative par son jeton :
 *  - programmé et conforme → confirmation avec le jeton (la base revalide propriétaire, accord, version) ;
 *  - programmé mais contenu/tag différent → annulation demandée ;
 *  - brouillon (rien n'a été programmé) → échec certain constaté, nouvelle réservation possible ;
 *  - publié / en cours → état enregistré tel quel, jamais « brouillon ».
 * Une lecture impossible laisse la réservation intacte : l'incertitude reste visible, rien n'est inventé.
 */
export async function reconcileOrphanClaims(
  provider: PublishingProvider,
  options: { lease?: Lease; graceSeconds?: number } = {},
): Promise<OrphanOutcome> {
  const lease = options.lease ?? NO_LEASE;
  const outcome: OrphanOutcome = { reconciled: 0, confirmed: 0, toCancel: 0, failures: 0, rateLimited: null };
  let orphans: OrphanClaim[];
  try {
    orphans = (await rpc<OrphanClaim[]>("list_orphan_claims_in_mode", { p_mode: provider.mode, p_grace_seconds: options.graceSeconds ?? 120 })) ?? [];
  } catch (error) {
    if (error instanceof MissingFunctionError) return outcome;
    throw error;
  }
  if (orphans.length === 0) return outcome;
  const pause = await activeRateLimitPause(provider.mode);
  if (pause) return outcome;

  for (const post of orphans) {
    if (!(await lease.ensure())) break;
    try {
      const live = await provider.getPost(post.buffer_post_id);
      if (!live) {
        await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: "Réservation abandonnée : le post n'existe plus dans Buffer.", p_token: post.token });
      } else if (live.status === "scheduled") {
        const conforming = live.hasReviewTag && sameContent({ text: post.text, dueAt: post.due_at, assets: post.assets }, live);
        if (conforming) {
          const answer = await rpc<string | null>("complete_scheduling", { p_post_id: post.id, p_ok: true, p_token: post.token });
          if (answer === "stale") outcome.toCancel += 1;
          else outcome.confirmed += 1;
        } else {
          await rpc("mark_unschedule_needed", { p_post_id: post.id, p_reason: "Réservation abandonnée : le contenu programmé dans Buffer n'est plus celui qui a été validé." });
          outcome.toCancel += 1;
        }
      } else if (live.status === "needs_approval") {
        // Ni brouillon ni programmé : un état d'attente créé par la tentative. Il est ramené en brouillon.
        await rpc("mark_unschedule_needed", { p_post_id: post.id, p_reason: "Réservation abandonnée : Buffer indique le statut « needs_approval »." });
        outcome.toCancel += 1;
      } else if (live.status === "sent" || live.status === "sending" || live.status === "error") {
        await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: `Réservation abandonnée : Buffer indique le statut « ${live.status} ».`, p_token: post.token });
      } else {
        await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: "Réservation abandonnée : rien n'était programmé dans Buffer (brouillon constaté).", p_token: post.token });
      }
      outcome.reconciled += 1;
    } catch (error) {
      outcome.failures += 1;
      // Erreur propre à un compte (connexion) : les réservations des autres comptes continuent d'être rapprochées.
      if (error instanceof ProviderError && error.connectionId) continue;
      if (error instanceof ProviderError && error.kind === "rate_limit") {
        outcome.rateLimited ??= error;
        break;
      }
      if (error instanceof ProviderError && error.kind !== "api") break;
    }
  }
  if (outcome.rateLimited) await recordRateLimit(outcome.rateLimited, provider.mode);
  return outcome;
}
