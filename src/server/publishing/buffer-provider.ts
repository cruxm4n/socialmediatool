import type { BufferStatus, PostAsset } from "@/lib/types";
import {
  ProviderError,
  readOnlyRefusal,
  type DraftContent,
  type DraftLookup,
  type ProviderChannel,
  type ProviderPost,
  type ProviderSnapshot,
  type PublishingProvider,
  type RateLimit,
} from "@/server/publishing/provider";

/*
 * Client de l'API GraphQL de Buffer (https://developers.buffer.com).
 * Toutes les opérations utilisées ici ont été vérifiées par un essai réel le 8 octobre 2026
 * (voir docs/BUFFER.md). La clé d'API ne quitte jamais le serveur.
 */

const ENDPOINT = "https://api.buffer.com";
const MAX_PAGES = 5;
/** Au-delà, la requête est abandonnée : une page ne doit pas rester bloquée sur Buffer. */
const TIMEOUT_MS = 15_000;

const POST_FIELDS = `
  id status text dueAt sentAt updatedAt externalLink channelId channelService schedulingType
  error { message }
  tags { name }
  assets { type mimeType source thumbnail }
`;

interface RawPost {
  id: string;
  status: BufferStatus;
  text: string;
  dueAt: string | null;
  sentAt: string | null;
  updatedAt: string | null;
  externalLink: string | null;
  channelId: string;
  channelService: string;
  schedulingType: string | null;
  error: { message: string } | null;
  tags: { name: string }[];
  assets: { type: string; mimeType: string; source: string; thumbnail: string }[];
}

interface PostsPage {
  edges: { node: RawPost }[] | null;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const normalize = (value: string) => value.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Lit les en-têtes « RateLimit » : une entrée par fenêtre (15 min, 1 jour, 30 jours). */
export function parseRateLimit(header: string | null): RateLimit | null {
  if (!header) return null;
  const result: RateLimit = {};
  for (const match of header.matchAll(/"([^"]+)";\s*r=(\d+)/g)) {
    result[match[1]] = Number(match[2]);
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Durée demandée par « Retry-After » : un nombre de secondes ou une date HTTP (RFC 9110). Toute autre forme est
 * ignorée (l'appelant applique alors la pause par défaut) ; une durée valide n'est jamais raccourcie ici.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds > 0 ? seconds : undefined;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/** Compte Buffer tel que constaté avec une clé : jamais la clé elle-même. */
export interface BufferAccount {
  id: string;
  label: string;
  organizations: number;
  channels: { id: string; service: string; name: string; isDisconnected: boolean }[];
  rateLimit: RateLimit | null;
}

/** Libellé affichable d'un compte : son nom, sinon son adresse masquée (jamais l'adresse entière). */
export function accountLabel(name: string | null | undefined, email: string | null | undefined): string {
  if (name?.trim()) return name.trim().slice(0, 80);
  const [local, domain] = (email ?? "").split("@");
  return local && domain ? `${local.slice(0, 1)}•••@${domain}`.slice(0, 80) : "Compte Buffer";
}

export class BufferProvider implements PublishingProvider {
  readonly mode = "real" as const;
  private organizationIds: string[] | null = null;
  private lastRateLimit: RateLimit | null = null;

  private identityChecked = false;

  /**
   * `expectedAccountId` : identité du compte constatée lors de la vérification de la connexion. Si elle est fournie,
   * la toute première requête de ce client relit `account.id` : une clé qui n'appartient pas (ou plus) à ce compte
   * ne sert à AUCUNE opération.
   */
  constructor(
    private readonly apiKey: string,
    private readonly reviewTag: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly expectedAccountId: string | null = null,
  ) {}

  /** Compte auquel appartient la clé (lecture seule). Champs documentés : https://developers.buffer.com/reference.html (Account). */
  async describeAccount(): Promise<BufferAccount> {
    const data = await this.send<{ account: { id: string; email: string | null; name: string | null; organizations: { id: string }[] } | null }>(
      `query { account { id email name organizations { id } } }`, {},
    );
    if (!data.account?.id) throw new ProviderError("Buffer n'a pas indiqué le compte de cette clé : identité non démontrée.");
    this.organizationIds = data.account.organizations.map((organization) => organization.id);
    const channels: BufferAccount["channels"] = [];
    for (const org of this.organizationIds) {
      const page = await this.send<{ channels: { id: string; service: string; name: string; displayName: string | null; isDisconnected: boolean }[] | null }>(
        `query Channels($org: OrganizationId!) { channels(input: { organizationId: $org }) { id service name displayName isDisconnected } }`, { org },
      );
      for (const channel of page.channels ?? []) channels.push({ id: channel.id, service: channel.service, name: channel.displayName ?? channel.name, isDisconnected: channel.isDisconnected });
    }
    return { id: data.account.id, label: accountLabel(data.account.name, data.account.email), organizations: this.organizationIds.length, channels, rateLimit: this.lastRateLimit };
  }

  private async ensureIdentity(): Promise<void> {
    if (this.identityChecked || !this.expectedAccountId) return;
    const data = await this.send<{ account: { id: string; organizations: { id: string }[] } | null }>(`query { account { id organizations { id } } }`, {});
    if (data.account?.id !== this.expectedAccountId) {
      throw new ProviderError("La clé enregistrée n'appartient pas au compte Buffer de cette connexion : aucune opération n'est envoyée. Vérifiez la connexion.");
    }
    this.organizationIds = data.account.organizations.map((organization) => organization.id);
    this.identityChecked = true;
  }

  /**
   * Une lecture est retentée une fois après une panne passagère (réseau, erreur 5xx).
   * Une écriture ne l'est jamais : on ne sait pas si Buffer l'a prise en compte.
   */
  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const isRead = !query.trimStart().startsWith("mutation");
    // Avant toute opération : la clé appartient-elle bien au compte de la connexion ? (une requête, une fois par client)
    await this.ensureIdentity();
    try {
      return await this.send<T>(query, variables);
    } catch (error) {
      if (isRead && error instanceof ProviderError && error.kind === "network") return this.send<T>(query, variables);
      throw error;
    }
  }

  /** Avertissements GraphQL reçus avec des données exploitables (« même un succès peut en porter »). */
  private warnings: string[] = [];

  private async send<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const isMutation = query.trimStart().startsWith("mutation");
    // Dernier garde-fou : même si une mutation était réintroduite plus haut, elle ne quitterait pas le serveur.
    if (isMutation) throw readOnlyRefusal();
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      // La requête est peut-être partie : pour une écriture, le résultat est inconnu.
      throw new ProviderError(
        timedOut ? "Buffer ne répond pas (délai dépassé)." : `Buffer injoignable : ${cause instanceof Error ? cause.message : String(cause)}`,
        "network",
        undefined,
        "unknown",
      );
    }

    this.lastRateLimit = parseRateLimit(response.headers.get("ratelimit")) ?? this.lastRateLimit;

    if (response.status === 429) {
      // Conservé tel quel : une pause peut dépasser un jour (fenêtre de 30 jours).
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      throw new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", retryAfter);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError("Buffer refuse la clé d'API de ce compte (invalide, révoquée ou expirée) : remplacez-la dans la connexion concernée.");
    }
    if (response.status >= 500) {
      throw new ProviderError(`Buffer est momentanément indisponible (HTTP ${response.status}).`, "network", undefined, "unknown");
    }

    const body = (await response.json().catch(() => null)) as { data?: T | null; errors?: { message: string; extensions?: { code?: string } }[] } | null;
    if (!body && response.ok) {
      // Réponse 2xx illisible : Buffer a peut-être appliqué l'opération.
      throw new ProviderError("Réponse de Buffer illisible : l'opération a peut-être été appliquée.", "api", undefined, "unknown");
    }
    if (!body) throw new ProviderError(`Erreur de l'API Buffer : HTTP ${response.status}`);

    const errors = body.errors ?? [];
    const data = body.data;
    const hasData = !!data && typeof data === "object";
    if (hasData && errors.length === 0 && response.ok) return data as T;
    const usable = hasData && Object.values(data as Record<string, unknown>).some((value) => value !== null && value !== undefined);
    if (usable && response.ok) {
      // Données présentes : le résultat prime. Les erreurs sont des avertissements (documentation Buffer :
      // « même une mutation réussie peut en porter ») ; une écriture réussie ne doit jamais perdre son identifiant.
      if (errors.length > 0) this.warnings.push(...errors.map((error) => error.message));
      return data as T;
    }
    if (errors.length === 0 && response.ok) {
      throw new ProviderError("Réponse de Buffer vide.", "api", undefined, isMutation ? "unknown" : "failed");
    }

    const detail = errors.map((error) => error.message).join(" ; ") || `HTTP ${response.status}`;
    const codes = errors.map((error) => error.extensions?.code);
    if (codes.includes("RATE_LIMIT_EXCEEDED")) {
      throw new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", parseRetryAfter(response.headers.get("retry-after")));
    }
    // Refus documentés sans effet : authentification, droits, ressource introuvable. Le reste (UNEXPECTED, code
    // inconnu ou absent) ne prouve pas l'absence d'effet d'une ÉCRITURE : résultat inconnu.
    const certain = errors.length > 0 && codes.every((code) => code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "NOT_FOUND");
    const outcome = isMutation && !certain && response.ok ? "unknown" : "failed";
    throw new ProviderError(`Erreur de l'API Buffer : ${detail}`, "api", undefined, outcome);
  }

  private toPost(raw: RawPost): ProviderPost {
    const tag = normalize(this.reviewTag);
    return {
      id: raw.id,
      channelId: raw.channelId,
      service: raw.channelService,
      status: raw.status,
      text: raw.text ?? "",
      dueAt: raw.dueAt,
      sentAt: raw.sentAt,
      updatedAt: raw.updatedAt,
      externalLink: raw.externalLink,
      error: raw.error?.message ?? null,
      hasReviewTag: raw.tags.some((item) => normalize(item.name) === tag),
      schedulingType: raw.schedulingType,
      assets: raw.assets.map((asset) => ({
        type: asset.type as PostAsset["type"],
        source: asset.source,
        thumbnail: asset.thumbnail,
        mimeType: asset.mimeType,
      })),
    };
  }

  private async getOrganizationIds(): Promise<string[]> {
    if (!this.organizationIds) {
      const data = await this.request<{ account: { organizations: { id: string }[] } }>(
        `query { account { organizations { id } } }`,
      );
      this.organizationIds = data.account.organizations.map((organization) => organization.id);
    }
    return this.organizationIds;
  }

  async fetchSnapshot(): Promise<ProviderSnapshot> {
    const channels: ProviderChannel[] = [];
    const posts: ProviderPost[] = [];
    let complete = true;
    let sentTruncated = false;
    this.warnings = [];

    for (const organizationId of await this.getOrganizationIds()) {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        // Une seule requête par page : canaux, posts « vivants » et derniers posts publiés.
        const data: {
          channels?: { id: string; service: string; name: string; displayName: string | null; avatar: string | null; isDisconnected: boolean }[];
          active: PostsPage;
          sent?: PostsPage;
        } = await this.request(
          `query Snapshot($org: OrganizationId!, $after: String, $first: Boolean!) {
            channels(input: { organizationId: $org }) @include(if: $first) { id service name displayName avatar isDisconnected }
            active: posts(first: 100, after: $after, input: {
              organizationId: $org,
              filter: { status: [draft, needs_approval, scheduled, sending, error] },
              sort: [{ field: createdAt, direction: desc }]
            }) { edges { node { ${POST_FIELDS} } } pageInfo { hasNextPage endCursor } }
            sent: posts(first: 50, input: {
              organizationId: $org,
              filter: { status: [sent] },
              sort: [{ field: createdAt, direction: desc }]
            }) @include(if: $first) { edges { node { ${POST_FIELDS} } } pageInfo { hasNextPage endCursor } }
          }`,
          { org: organizationId, after: cursor, first: page === 0 },
        );

        if (data.channels) channels.push(...data.channels);
        if (data.sent?.pageInfo?.hasNextPage) sentTruncated = true;
        for (const edge of [...(data.active.edges ?? []), ...(data.sent?.edges ?? [])]) {
          posts.push(this.toPost(edge.node));
        }
        if (!data.active.pageInfo.hasNextPage) break;
        cursor = data.active.pageInfo.endCursor;
        if (page === MAX_PAGES - 1) complete = false;
      }
    }

    // Aucun canal alors que le compte en avait : réponse anormale. On ne conclut pas que tout a été supprimé.
    if (channels.length === 0) complete = false;
    // Des avertissements GraphQL accompagnaient les données : la lecture a pu être partielle.
    if (this.warnings.length > 0) complete = false;

    return { channels, posts, complete, sentTruncated, rateLimit: this.lastRateLimit };
  }

  async getPost(id: string): Promise<ProviderPost | null> {
    try {
      const data = await this.request<{ post: RawPost | null }>(
        `query Post($id: PostId!) { post(input: { id: $id }) { ${POST_FIELDS} } }`,
        { id },
      );
      return data.post ? this.toPost(data.post) : null;
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "api" && /not found|introuvable/i.test(error.message)) return null;
      throw error;
    }
  }

  /*
   * LECTURE SEULE. Cadence ne crée, ne modifie, ne programme et ne déprogramme rien dans Buffer : tout cela se fait à
   * la main dans Buffer. Ce fournisseur ne contient plus aucune mutation ; les opérations d'écriture du contrat sont
   * refusées ici, sans appel réseau et quelle que soit la configuration (CADENCE_BUFFER_WRITES n'a plus d'effet).
   */
  private refuseWrite(): never {
    throw readOnlyRefusal();
  }

  async createDraft(content: DraftContent): Promise<ProviderPost> {
    void content;
    return this.refuseWrite();
  }

  /**
   * Lecture seule. S'appuie sur le snapshot (requêtes déjà éprouvées) plutôt que sur un filtre de canal non
   * vérifié. Tous les statuts sont considérés (un brouillon peut être passé en erreur ou publié).
   * L'absence de résultat n'est JAMAIS une preuve d'absence : la lecture est paginée et limitée, le texte a pu
   * être modifié dans Buffer, les médias comparés ici ne portent que sur leur nature.
   */
  async findDraftCandidates(lookup: DraftLookup): Promise<{ candidates: ProviderPost[]; possible: ProviderPost[]; complete: boolean }> {
    const snapshot = await this.fetchSnapshot();
    const instant = Date.parse(lookup.dueAt);
    const sameChannel = snapshot.posts.filter((post) => post.channelId === lookup.channelId);
    const mediaMatches = (post: ProviderPost) =>
      !lookup.assetKinds || (post.assets.length === lookup.assetKinds.length && post.assets.every((asset, index) => asset.type === lookup.assetKinds![index]));
    const exact = (post: ProviderPost) =>
      post.text === lookup.text && post.dueAt !== null && Date.parse(post.dueAt) === instant && mediaMatches(post);
    const candidates = sameChannel.filter(exact);
    // Ressemblances à faire trancher par une personne : même texte (date ou médias différents) ou même date.
    const possible = sameChannel.filter(
      (post) => !exact(post) && (post.text === lookup.text || (post.dueAt !== null && Date.parse(post.dueAt) === instant)),
    );
    return { candidates, possible, complete: snapshot.complete && !snapshot.sentTruncated };
  }

  async updateDraft(postId: string, content: DraftContent): Promise<ProviderPost> {
    void postId; void content;
    return this.refuseWrite();
  }

  async rescheduleDraft(post: ProviderPost, dueAt: string): Promise<ProviderPost> {
    void post; void dueAt;
    return this.refuseWrite();
  }

  async schedulePost(post: ProviderPost): Promise<ProviderPost> {
    void post;
    return this.refuseWrite();
  }

  async unschedulePost(post: ProviderPost): Promise<ProviderPost> {
    void post;
    return this.refuseWrite();
  }
}