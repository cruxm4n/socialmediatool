import "server-only";

import { quotaBackoff } from "@/lib/domain/sync-health";
import {
  ProviderError,
  type DraftContent,
  type DraftLookup,
  type ProviderPost,
  type ProviderSnapshot,
  type PublishingProvider,
} from "@/server/publishing/provider";

/*
 * Routeur de connexions fournisseur.
 *
 * Le reste de l'application ne connaît toujours qu'un PublishingProvider. Le routeur en est un : il envoie chaque
 * opération au compte (la « connexion ») dont dépend le canal ou la publication concernés.
 *
 * Règles, toutes vérifiées par tests/unit/connection-router.test.ts :
 *  - une publication du client A ne part JAMAIS avec le compte du client B : la route vient de la base
 *    (canal → connexion, posée une fois et immuable), jamais d'un réglage global ;
 *  - AUCUN repli : pas de route, connexion révoquée ou secret illisible → l'opération est refusée, rien n'est envoyé ;
 *  - une panne ou un refus de quota d'un compte ne vaut que pour lui : l'erreur porte son `connectionId`, les autres
 *    comptes continuent ; le compte fautif n'est plus sollicité pendant ce passage (ni pendant sa pause de quota) ;
 *  - une lecture ne peut déclarer « retirées » que les publications des comptes lus en entier ;
 *  - les comptes sont lus EN PARALLÈLE : un compte lent ou muet ne retarde pas la lecture des autres ;
 *  - quota presque épuisé sur un compte : seules SES lectures planifiées sont espacées (les autres comptes, les
 *    lectures manuelles, les programmations et les annulations continuent) ;
 *  - barrière d'activation fermée : aucune écriture ne part (lecture seule) ; configuration invalide : rien ne part.
 */

export interface ConnectionRow {
  id: string;
  label: string;
  organizationId: string | null;
  credentialSource: "none" | "environment" | "stored";
  ciphertext: string | null;
  keyVersion: number | null;
  accountKey: string | null;
  isDefault: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  /** Lectures planifiées de ce compte espacées jusqu'à cette date (quota presque épuisé). */
  readBackoffUntil?: string | null;
  /** « revoking » : révocation demandée. Seules l'annulation et la lecture de l'existant restent permises. */
  status?: "active" | "revoking";
  /** Compte réel dont l'identité a été constatée chez le fournisseur. Absent (base 0012) : considéré vérifié. */
  verified?: boolean;
  /** Identité du compte constatée chez le fournisseur : le client la recontrôle avant sa première opération. */
  externalAccountId?: string | null;
}

/** État durable d'une connexion, relu en base avant chaque opération (voir `loadStates`). */
export interface DurableConnectionState {
  status: "active" | "revoking" | "revoked";
  pausedUntil: string | null;
  /** Date de la clé enregistrée : si elle change, le client chargé n'est plus le bon. */
  credentialAt?: string | null;
}

export interface ConnectionState {
  ok: boolean;
  error?: string | null;
  rateLimit?: Record<string, number> | null;
  pauseSeconds?: number;
  pauseReason?: string | null;
  /** true : cet état résulte d'une lecture complète du compte (date de dernière synchronisation). */
  synced?: boolean;
}

export interface RouterDeps {
  mode: "real" | "mock";
  /** Connexions ACTIVES de ce mode. `null` : la base ne connaît pas encore les connexions (migration 0012 absente). */
  loadConnections(): Promise<ConnectionRow[] | null>;
  /** Connexion d'origine de publications et de canaux (identifiants du fournisseur). */
  loadRoutes(postIds: string[], channelIds: string[]): Promise<{ posts: Record<string, string>; channels: Record<string, string> }>;
  /** Enregistre l'état d'une connexion. `false` : la base n'a rien écrit (connexion révoquée ou disparue). */
  recordState(connectionId: string, state: ConnectionState): Promise<boolean | void>;
  /**
   * État DURABLE de toutes les connexions du mode, relu avant chaque opération : une révocation ou une pause décidée
   * par un autre processus vaut immédiatement pour ce routeur, même chargé depuis longtemps. Une lecture impossible
   * fait REFUSER l'opération (jamais d'appel au fournisseur sur un état que la base ne confirme pas).
   * `null` : base sans la migration 0013 (essais sur ancien schéma) — l'état chargé au départ fait foi.
   */
  loadStates(): Promise<Record<string, DurableConnectionState> | null>;
  /** Construit le fournisseur d'une connexion. Lève une erreur si son secret est inutilisable. */
  build(row: ConnectionRow): PublishingProvider;
  /** Base antérieure à 0012 : fournisseur unique, comme avant. Absent ou erreur : aucune opération possible. */
  legacy?(): PublishingProvider;
  now?(): number;
  /** Configuration invalide : AUCUNE opération (lecture comprise) n'a lieu ; le message dit pourquoi. */
  blocked?: string | null;
  /** Barrière d'activation fermée : les écritures sont refusées avant tout appel ; le message dit pourquoi. */
  writesDisabled?: string | null;
  /** Passage planifié : un compte dont les lectures sont espacées n'est pas lu (et rien n'en est déduit). */
  respectReadBackoff?: boolean;
  /** Enregistre l'espacement des lectures planifiées d'un compte au quota presque épuisé. */
  recordReadBackoff?(connectionId: string, seconds: number, reason: string): Promise<void>;
}

/** Nombre de comptes lus en même temps. */
const READ_CONCURRENCY = 4;

/** Pause appliquée à un refus de quota sans durée exploitable (identique à la règle globale). */
const DEFAULT_PAUSE_SECONDS = 15 * 60;

interface Entry {
  row: ConnectionRow;
  provider: PublishingProvider | null;
  /** Connexion inutilisable (secret illisible, clé de chiffrement absente) : message destiné à l'administrateur. */
  unusable: string | null;
  pausedUntil: number | null;
  /** Panne constatée pendant ce passage : le compte n'est plus sollicité jusqu'au prochain passage. */
  broken: string | null;
  /** Révocation demandée : aucun nouvel effet, seulement annuler et lire. */
  revoking: boolean;
  /** Date de la clé au chargement (pour détecter un remplacement). */
  credentialAt: string | null | undefined;
}

type Operation = "read" | "compensate" | "emit";

const tag = (error: unknown, connectionId: string): unknown => {
  if (error instanceof ProviderError) error.connectionId = connectionId;
  return error;
};

export class ConnectionRouter implements PublishingProvider {
  readonly mode: "real" | "mock";
  private loading: Promise<{ entries: Map<string, Entry>; legacy: PublishingProvider | null }> | null = null;
  private readonly postRoutes = new Map<string, string>();
  private readonly channelRoutes = new Map<string, string>();

  constructor(private readonly deps: RouterDeps) {
    this.mode = deps.mode;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Barrière d'activation : une écriture refusée ici n'a rien envoyé (résultat certain). */
  private assertWritable(): void {
    if (!this.deps.writesDisabled) return;
    const error = new ProviderError(this.deps.writesDisabled);
    error.refusal = "writes_disabled";
    throw error;
  }

  private load() {
    this.loading ??= (async () => {
      if (this.deps.blocked) {
        const error = new ProviderError(this.deps.blocked);
        error.refusal = "blocked";
        throw error;
      }
      const rows = await this.deps.loadConnections();
      if (!Array.isArray(rows)) {
        // Base sans la migration 0012 : aucune connexion n'existe encore, l'ancien modèle à fournisseur unique s'applique.
        if (!this.deps.legacy) throw new ProviderError("La base de données n'a pas reçu la migration 0012 (connexions fournisseur) : aucune opération n'est possible.");
        return { entries: new Map<string, Entry>(), legacy: this.deps.legacy() };
      }
      const entries = new Map<string, Entry>();
      for (const row of rows) {
        let provider: PublishingProvider | null = null;
        let unusable: string | null = null;
        try {
          // Clé jamais vérifiée auprès du fournisseur : on ne sait pas à quel compte elle appartient. Inutilisable.
          if (row.verified === false) throw new Error("clé non vérifiée (ouvrez la connexion et vérifiez-la)");
          provider = this.deps.build(row);
          if (provider.mode !== this.mode) throw new Error("mode de la connexion incohérent");
        } catch (error) {
          provider = null;
          unusable = `Connexion « ${row.label} » inutilisable : ${error instanceof Error ? error.message : "secret illisible"}`;
        }
        entries.set(row.id, {
          row, provider, unusable, pausedUntil: row.pausedUntil ? Date.parse(row.pausedUntil) : null, broken: null,
          revoking: row.status === "revoking", credentialAt: undefined,
        });
      }
      return { entries, legacy: null };
    })();
    return this.loading;
  }

  /**
   * Relit l'état durable de la connexion juste avant l'appel. C'est ce qui rend une révocation, une demande de
   * révocation, une pause ou un remplacement de clé décidés AILLEURS opposables à ce routeur déjà chargé.
   * (La réservation en base, elle, est atomique avec la révocation : voir la migration 0013.)
   */
  private async refresh(entry: Entry): Promise<void> {
    const { id, label } = entry.row;
    let states: Record<string, DurableConnectionState> | null;
    try {
      states = await this.deps.loadStates();
    } catch (error) {
      throw tag(new ProviderError(`État de la connexion « ${label} » illisible en base : opération refusée, rien n'a été envoyé. (${error instanceof Error ? error.message : String(error)})`), id);
    }
    if (states === null) return;
    const state = states[id];
    if (!state || state.status === "revoked") {
      entry.provider = null;
      entry.unusable = `La connexion « ${label} » est révoquée : opération refusée.`;
      return;
    }
    entry.revoking = state.status === "revoking";
    const paused = state.pausedUntil ? Date.parse(state.pausedUntil) : null;
    // Une pause ne se raccourcit jamais ici : la plus longue des deux (mémoire, base) l'emporte.
    if (paused && (!entry.pausedUntil || paused > entry.pausedUntil)) entry.pausedUntil = paused;
    if (entry.credentialAt === undefined) entry.credentialAt = state.credentialAt ?? null;
    else if ((state.credentialAt ?? null) !== entry.credentialAt) {
      // La clé a été remplacée depuis le chargement : le client en mémoire porte l'ancienne. Rien ne part avec elle.
      entry.provider = null;
      entry.unusable = `La clé de la connexion « ${label} » a changé pendant ce passage : opération reportée au prochain.`;
    }
  }

  /** Refus sans appel au fournisseur : rien n'a pu être fait (résultat certain). */
  private refuse(entry: Entry, operation: Operation): void {
    const { id, label } = entry.row;
    if (entry.unusable || !entry.provider) throw tag(new ProviderError(entry.unusable ?? `Connexion « ${label} » inutilisable.`), id);
    if (entry.revoking && operation === "emit") {
      throw tag(new ProviderError(`Révocation demandée pour « ${label} » : plus aucune nouvelle opération n'est envoyée par ce compte.`), id);
    }
    if (entry.pausedUntil && entry.pausedUntil > this.now()) {
      const seconds = Math.ceil((entry.pausedUntil - this.now()) / 1000);
      throw tag(new ProviderError(`Quota du compte « ${label} » atteint : aucune requête avant ${new Date(entry.pausedUntil).toISOString()}.`, "rate_limit", seconds), id);
    }
    if (entry.broken) throw tag(new ProviderError(`Compte « ${label} » injoignable pendant ce passage : ${entry.broken}`, "network"), id);
  }

  private async run<T>(entry: Entry, operation: Operation, call: (provider: PublishingProvider) => Promise<T>): Promise<T> {
    await this.refresh(entry);
    this.refuse(entry, operation);
    try {
      return await call(entry.provider!);
    } catch (error) {
      tag(error, entry.row.id);
      if (error instanceof ProviderError && error.kind === "rate_limit") {
        const seconds = error.retryAfterSeconds ?? DEFAULT_PAUSE_SECONDS;
        entry.pausedUntil = this.now() + seconds * 1000;
        const state = { ok: false, error: error.message, pauseSeconds: seconds, pauseReason: "Quota de requêtes du fournisseur atteint pour ce compte : opérations suspendues." };
        // La pause doit être connue des autres processus. Un échec d'enregistrement est retenté une fois, puis
        // rendu visible : ce routeur ne sollicite plus le compte, mais un autre worker pourrait l'ignorer.
        const recorded = await this.deps.recordState(entry.row.id, state).catch(() => this.deps.recordState(entry.row.id, state).catch(() => false as const));
        if (recorded === false) {
          entry.broken = "pause de quota non enregistrée en base";
          error.message = `${error.message} (ATTENTION : la pause de ce compte n'a pas pu être enregistrée en base.)`;
        }
      } else if (error instanceof ProviderError && error.kind === "network") {
        entry.broken = error.message;
      }
      throw error;
    }
  }

  private async entryFor(connectionId: string | undefined, what: string): Promise<Entry> {
    const { entries } = await this.load();
    const entry = connectionId ? entries.get(connectionId) : undefined;
    if (entry) return entry;
    // Aucun compte par défaut : sans route vers une connexion ACTIVE, l'opération n'a pas lieu.
    const error = new ProviderError(
      connectionId
        ? `La connexion fournisseur de ${what} est révoquée ou indisponible : opération refusée.`
        : `Aucune connexion fournisseur n'est associée à ${what} : opération refusée.`,
    );
    if (connectionId) error.connectionId = connectionId;
    throw error;
  }

  private async byChannel(channelId: string): Promise<Entry> {
    if (!this.channelRoutes.has(channelId)) {
      const routes = await this.deps.loadRoutes([], [channelId]);
      for (const [id, connection] of Object.entries(routes.channels ?? {})) this.channelRoutes.set(id, connection);
    }
    return this.entryFor(this.channelRoutes.get(channelId), "ce canal");
  }

  private async byPost(postId: string): Promise<Entry> {
    if (!this.postRoutes.has(postId)) {
      const routes = await this.deps.loadRoutes([postId], []);
      for (const [id, connection] of Object.entries(routes.posts ?? {})) this.postRoutes.set(id, connection);
    }
    return this.entryFor(this.postRoutes.get(postId), "cette publication");
  }

  /** Une publication reste liée au compte de son canal : jamais d'opération par un autre compte. */
  private async forPost(post: Pick<ProviderPost, "id" | "channelId" | "connectionId">): Promise<Entry> {
    const entry = await this.byChannel(post.channelId);
    if (post.connectionId && post.connectionId !== entry.row.id) {
      throw tag(new ProviderError("Cette publication provient d'un autre compte que celui de son canal : opération refusée."), entry.row.id);
    }
    const known = this.postRoutes.get(post.id);
    if (known && known !== entry.row.id) throw tag(new ProviderError("Cette publication est connue sous un autre compte : opération refusée."), entry.row.id);
    return entry;
  }

  private stamp<T extends ProviderPost | null>(post: T, entry: Entry): T {
    if (post) {
      post.connectionId = entry.row.id;
      this.postRoutes.set(post.id, entry.row.id);
    }
    return post;
  }

  async fetchSnapshot(): Promise<ProviderSnapshot> {
    const { entries, legacy } = await this.load();
    if (legacy) return legacy.fetchSnapshot();

    const merged: ProviderSnapshot = { channels: [], posts: [], complete: true, rateLimit: null, scopeConnectionIds: [], connectionErrors: [] };
    if (entries.size === 0) {
      merged.complete = false;
      merged.connectionErrors!.push({ connectionId: "", label: "", message: "Aucune connexion fournisseur active : rien n'a été lu." });
      return merged;
    }
    let firstError: unknown = null;
    type Read = { entry: Entry; snapshot?: ProviderSnapshot; error?: unknown; skippedUntil?: number };
    const queue = [...entries.values()];
    const reads: Read[] = queue.map((entry) => ({ entry }));
    let next = 0;
    // Lecture en parallèle : chaque compte a son client, son délai et son quota ; l'un n'attend pas l'autre.
    const worker = async () => {
      while (next < reads.length) {
        const read = reads[next++];
        const backoff = read.entry.row.readBackoffUntil ? Date.parse(read.entry.row.readBackoffUntil) : null;
        if (this.deps.respectReadBackoff && backoff && backoff > this.now()) {
          read.skippedUntil = backoff;
          continue;
        }
        try {
          read.snapshot = await this.run(read.entry, "read", (provider) => provider.fetchSnapshot());
        } catch (error) {
          read.error = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, reads.length) }, worker));

    // Fusion dans l'ordre des connexions (résultat stable, quel que soit l'ordre des réponses).
    for (const { entry, snapshot, error, skippedUntil } of reads) {
      const { id, label } = entry.row;
      if (skippedUntil) {
        // Compte non lu par choix : il n'entre pas dans le périmètre, donc rien de lui ne peut être déclaré retiré.
        merged.complete = false;
        (merged.skippedConnections ??= []).push({ connectionId: id, label, until: new Date(skippedUntil).toISOString() });
        continue;
      }
      if (snapshot) {
        for (const channel of snapshot.channels) {
          merged.channels.push({ ...channel, connectionId: id });
          this.channelRoutes.set(channel.id, id);
        }
        for (const post of snapshot.posts) {
          merged.posts.push({ ...post, connectionId: id });
          this.postRoutes.set(post.id, id);
        }
        if (snapshot.complete) merged.scopeConnectionIds!.push(id);
        else merged.complete = false;
        if (snapshot.sentTruncated) merged.sentTruncated = true;
        // Un seul compte : son quota sert, comme avant, à ralentir le planificateur. Plusieurs : chacun le sien.
        if (entries.size === 1) merged.rateLimit = snapshot.rateLimit;
        await this.deps.recordState(id, { ok: true, rateLimit: snapshot.rateLimit, synced: true }).catch(() => undefined);
        const backoff = entries.size > 1 ? quotaBackoff(snapshot.rateLimit) : null;
        if (backoff && this.deps.recordReadBackoff) {
          await this.deps.recordReadBackoff(id, backoff.seconds, backoff.reason.replace("synchronisations planifiées suspendues", "lectures planifiées de ce compte espacées")).catch(() => undefined);
        }
      } else {
        firstError ??= error;
        merged.complete = false;
        const message = error instanceof Error ? error.message : String(error);
        merged.connectionErrors!.push({ connectionId: id, label, message });
        await this.deps.recordState(id, { ok: false, error: message, synced: true }).catch(() => undefined);
      }
    }
    // Aucun compte n'a répondu : c'est une panne de lecture, pas un relevé vide.
    if (merged.connectionErrors!.length > 0 && merged.connectionErrors!.length + (merged.skippedConnections?.length ?? 0) === entries.size) throw firstError;
    return merged;
  }

  async getPost(id: string): Promise<ProviderPost | null> {
    const { legacy } = await this.load();
    if (legacy) return legacy.getPost(id);
    const entry = await this.byPost(id);
    return this.stamp(await this.run(entry, "read", (provider) => provider.getPost(id)), entry);
  }

  async schedulePost(post: ProviderPost): Promise<ProviderPost> {
    const { legacy } = await this.load();
    this.assertWritable();
    if (legacy) return legacy.schedulePost(post);
    const entry = await this.forPost(post);
    return this.stamp(await this.run(entry, "emit", (provider) => provider.schedulePost(post)), entry);
  }

  async unschedulePost(post: ProviderPost): Promise<ProviderPost> {
    const { legacy } = await this.load();
    this.assertWritable();
    if (legacy) return legacy.unschedulePost(post);
    const entry = await this.forPost(post);
    return this.stamp(await this.run(entry, "compensate", (provider) => provider.unschedulePost(post)), entry);
  }

  async createDraft(content: DraftContent): Promise<ProviderPost> {
    const { legacy } = await this.load();
    this.assertWritable();
    if (legacy) return legacy.createDraft(content);
    const entry = await this.byChannel(content.channelId);
    return this.stamp(await this.run(entry, "emit", (provider) => provider.createDraft(content)), entry);
  }

  async updateDraft(postId: string, content: DraftContent): Promise<ProviderPost> {
    const { legacy } = await this.load();
    this.assertWritable();
    if (legacy) return legacy.updateDraft(postId, content);
    const entry = await this.forPost({ id: postId, channelId: content.channelId });
    // La publication doit être connue sous CE compte (ou inconnue de la base : brouillon tout juste créé par ce routeur).
    const routes = this.postRoutes.has(postId) ? null : await this.deps.loadRoutes([postId], []);
    const known = this.postRoutes.get(postId) ?? routes?.posts?.[postId];
    if (known && known !== entry.row.id) throw tag(new ProviderError("Cette publication est connue sous un autre compte : opération refusée."), entry.row.id);
    return this.stamp(await this.run(entry, "emit", (provider) => provider.updateDraft(postId, content)), entry);
  }

  async rescheduleDraft(post: ProviderPost, dueAt: string): Promise<ProviderPost> {
    const { legacy } = await this.load();
    this.assertWritable();
    if (legacy) return legacy.rescheduleDraft(post, dueAt);
    const entry = await this.forPost(post);
    return this.stamp(await this.run(entry, "emit", (provider) => provider.rescheduleDraft(post, dueAt)), entry);
  }

  async findDraftCandidates(lookup: DraftLookup): Promise<{ candidates: ProviderPost[]; possible?: ProviderPost[]; complete: boolean }> {
    const { legacy } = await this.load();
    if (legacy) return legacy.findDraftCandidates(lookup);
    const entry = await this.byChannel(lookup.channelId);
    const found = await this.run(entry, "read", (provider) => provider.findDraftCandidates(lookup));
    for (const post of [...found.candidates, ...(found.possible ?? [])]) post.connectionId = entry.row.id;
    return found;
  }
}
