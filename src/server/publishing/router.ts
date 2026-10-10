import "server-only";

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
 *  - une lecture ne peut déclarer « retirées » que les publications des comptes lus en entier.
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
  recordState(connectionId: string, state: ConnectionState): Promise<void>;
  /** Construit le fournisseur d'une connexion. Lève une erreur si son secret est inutilisable. */
  build(row: ConnectionRow): PublishingProvider;
  /** Base antérieure à 0012 : fournisseur unique, comme avant. Absent ou erreur : aucune opération possible. */
  legacy?(): PublishingProvider;
  now?(): number;
}

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
}

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

  private load() {
    this.loading ??= (async () => {
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
          provider = this.deps.build(row);
          if (provider.mode !== this.mode) throw new Error("mode de la connexion incohérent");
        } catch (error) {
          provider = null;
          unusable = `Connexion « ${row.label} » inutilisable : ${error instanceof Error ? error.message : "secret illisible"}`;
        }
        entries.set(row.id, { row, provider, unusable, pausedUntil: row.pausedUntil ? Date.parse(row.pausedUntil) : null, broken: null });
      }
      return { entries, legacy: null };
    })();
    return this.loading;
  }

  /** Refus sans appel au fournisseur : rien n'a pu être fait (résultat certain). */
  private refuse(entry: Entry): void {
    const { id, label } = entry.row;
    if (entry.unusable || !entry.provider) throw tag(new ProviderError(entry.unusable ?? `Connexion « ${label} » inutilisable.`), id);
    if (entry.pausedUntil && entry.pausedUntil > this.now()) {
      const seconds = Math.ceil((entry.pausedUntil - this.now()) / 1000);
      throw tag(new ProviderError(`Quota du compte « ${label} » atteint : aucune requête avant ${new Date(entry.pausedUntil).toISOString()}.`, "rate_limit", seconds), id);
    }
    if (entry.broken) throw tag(new ProviderError(`Compte « ${label} » injoignable pendant ce passage : ${entry.broken}`, "network"), id);
  }

  private async run<T>(entry: Entry, call: (provider: PublishingProvider) => Promise<T>): Promise<T> {
    this.refuse(entry);
    try {
      return await call(entry.provider!);
    } catch (error) {
      tag(error, entry.row.id);
      if (error instanceof ProviderError && error.kind === "rate_limit") {
        const seconds = error.retryAfterSeconds ?? DEFAULT_PAUSE_SECONDS;
        entry.pausedUntil = this.now() + seconds * 1000;
        await this.deps
          .recordState(entry.row.id, { ok: false, error: error.message, pauseSeconds: seconds, pauseReason: "Quota de requêtes du fournisseur atteint pour ce compte : opérations suspendues." })
          .catch(() => undefined);
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
    for (const entry of entries.values()) {
      const { id, label } = entry.row;
      try {
        const snapshot = await this.run(entry, (provider) => provider.fetchSnapshot());
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
      } catch (error) {
        firstError ??= error;
        merged.complete = false;
        const message = error instanceof Error ? error.message : String(error);
        merged.connectionErrors!.push({ connectionId: id, label, message });
        await this.deps.recordState(id, { ok: false, error: message, synced: true }).catch(() => undefined);
      }
    }
    // Aucun compte n'a répondu : c'est une panne de lecture, pas un relevé vide.
    if (merged.connectionErrors!.length === entries.size) throw firstError;
    return merged;
  }

  async getPost(id: string): Promise<ProviderPost | null> {
    const { legacy } = await this.load();
    if (legacy) return legacy.getPost(id);
    const entry = await this.byPost(id);
    return this.stamp(await this.run(entry, (provider) => provider.getPost(id)), entry);
  }

  async schedulePost(post: ProviderPost): Promise<ProviderPost> {
    const { legacy } = await this.load();
    if (legacy) return legacy.schedulePost(post);
    const entry = await this.forPost(post);
    return this.stamp(await this.run(entry, (provider) => provider.schedulePost(post)), entry);
  }

  async unschedulePost(post: ProviderPost): Promise<ProviderPost> {
    const { legacy } = await this.load();
    if (legacy) return legacy.unschedulePost(post);
    const entry = await this.forPost(post);
    return this.stamp(await this.run(entry, (provider) => provider.unschedulePost(post)), entry);
  }

  async createDraft(content: DraftContent): Promise<ProviderPost> {
    const { legacy } = await this.load();
    if (legacy) return legacy.createDraft(content);
    const entry = await this.byChannel(content.channelId);
    return this.stamp(await this.run(entry, (provider) => provider.createDraft(content)), entry);
  }

  async updateDraft(postId: string, content: DraftContent): Promise<ProviderPost> {
    const { legacy } = await this.load();
    if (legacy) return legacy.updateDraft(postId, content);
    const entry = await this.forPost({ id: postId, channelId: content.channelId });
    // La publication doit être connue sous CE compte (ou inconnue de la base : brouillon tout juste créé par ce routeur).
    const routes = this.postRoutes.has(postId) ? null : await this.deps.loadRoutes([postId], []);
    const known = this.postRoutes.get(postId) ?? routes?.posts?.[postId];
    if (known && known !== entry.row.id) throw tag(new ProviderError("Cette publication est connue sous un autre compte : opération refusée."), entry.row.id);
    return this.stamp(await this.run(entry, (provider) => provider.updateDraft(postId, content)), entry);
  }

  async rescheduleDraft(post: ProviderPost, dueAt: string): Promise<ProviderPost> {
    const { legacy } = await this.load();
    if (legacy) return legacy.rescheduleDraft(post, dueAt);
    const entry = await this.forPost(post);
    return this.stamp(await this.run(entry, (provider) => provider.rescheduleDraft(post, dueAt)), entry);
  }

  async findDraftCandidates(lookup: DraftLookup): Promise<{ candidates: ProviderPost[]; possible?: ProviderPost[]; complete: boolean }> {
    const { legacy } = await this.load();
    if (legacy) return legacy.findDraftCandidates(lookup);
    const entry = await this.byChannel(lookup.channelId);
    const found = await this.run(entry, (provider) => provider.findDraftCandidates(lookup));
    for (const post of [...found.candidates, ...(found.possible ?? [])]) post.connectionId = entry.row.id;
    return found;
  }
}
