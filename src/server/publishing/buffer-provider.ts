import type { BufferStatus, PostAsset } from "@/lib/types";
import {
  ProviderError,
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

export class BufferProvider implements PublishingProvider {
  readonly mode = "real" as const;
  private organizationIds: string[] | null = null;
  private lastRateLimit: RateLimit | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly reviewTag: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
      });
    } catch (cause) {
      throw new ProviderError(`Buffer injoignable : ${cause instanceof Error ? cause.message : String(cause)}`, "network");
    }

    this.lastRateLimit = parseRateLimit(response.headers.get("ratelimit")) ?? this.lastRateLimit;

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || undefined;
      throw new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", retryAfter);
    }

    const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
    if (!response.ok || !body || body.errors?.length || !body.data) {
      const detail = body?.errors?.map((error) => error.message).join(" ; ") ?? `HTTP ${response.status}`;
      throw new ProviderError(`Erreur de l'API Buffer : ${detail}`);
    }
    return body.data;
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
        for (const edge of [...(data.active.edges ?? []), ...(data.sent?.edges ?? [])]) {
          posts.push(this.toPost(edge.node));
        }
        if (!data.active.pageInfo.hasNextPage) break;
        cursor = data.active.pageInfo.endCursor;
        if (page === MAX_PAGES - 1) complete = false;
      }
    }

    return { channels, posts, complete, rateLimit: this.lastRateLimit };
  }

  async getPost(id: string): Promise<ProviderPost | null> {
    try {
      const data = await this.request<{ post: RawPost }>(
        `query Post($id: PostId!) { post(input: { id: $id }) { ${POST_FIELDS} } }`,
        { id },
      );
      return this.toPost(data.post);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "api" && /not found|introuvable/i.test(error.message)) return null;
      throw error;
    }
  }

  /*
   * editPost exige de renvoyer le texte (ou un média) : sans cela Buffer répond
   * « Post must have either text or media ». Médias et tags omis sont conservés.
   */
  private async edit(post: ProviderPost, saveToDraft: boolean): Promise<ProviderPost> {
    const input: Record<string, unknown> = { id: post.id, saveToDraft };
    if (post.text.trim().length > 0) {
      input.text = post.text;
    } else {
      input.assets = post.assets.map((asset) =>
        asset.type === "video" ? { video: { url: asset.source } } : { image: { url: asset.source } },
      );
    }
    if (!saveToDraft) {
      input.mode = "customScheduled";
      input.schedulingType = post.schedulingType ?? "automatic";
      input.dueAt = post.dueAt;
    }

    const data = await this.request<{ editPost: { __typename: string; message?: string; post?: RawPost } }>(
      `mutation Edit($input: EditPostInput!) {
        editPost(input: $input) {
          __typename
          ... on PostActionSuccess { post { ${POST_FIELDS} } }
          ... on MutationError { message }
        }
      }`,
      { input },
    );
    if (!data.editPost.post) {
      throw new ProviderError(`Buffer a refusé la modification : ${data.editPost.message ?? data.editPost.__typename}`);
    }
    return this.toPost(data.editPost.post);
  }

  async schedulePost(post: ProviderPost): Promise<ProviderPost> {
    if (!post.dueAt) throw new ProviderError("Ce post n'a pas de date prévue.");
    const result = await this.edit(post, false);
    if (result.status !== "scheduled") {
      throw new ProviderError(`Buffer n'a pas programmé le post (statut « ${result.status} »).`);
    }
    return result;
  }

  async unschedulePost(post: ProviderPost): Promise<ProviderPost> {
    const result = await this.edit(post, true);
    if (result.status !== "draft") {
      throw new ProviderError(`Buffer n'a pas repassé le post en brouillon (statut « ${result.status} »).`);
    }
    return result;
  }
}
