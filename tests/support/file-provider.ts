import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  ProviderError,
  type DraftContent,
  type DraftLookup,
  type ProviderChannel,
  type ProviderPost,
  type ProviderSnapshot,
  type PublishingProvider,
} from "@/server/publishing/provider";

/*
 * Faux Buffer PERSISTANT : son état vit dans un fichier JSON, donc survit à un processus arrêté (SIGKILL) et se
 * partage entre processus. Il COMPTE chaque effet (créations, programmations, annulations) : c'est ce compte, et non
 * une doublure en mémoire, qui prouve qu'un renvoi ne crée rien. Les pannes sont injectées par état (« faults »),
 * consommées une fois. Aucun appel réseau.
 */

export interface FakeBufferState {
  seq: number;
  calls: Record<string, number>;
  posts: Record<string, ProviderPost>;
  channels: ProviderChannel[];
  /** Pannes à injecter, dans l'ordre : « createDraft:lose », « unschedulePost:429 »… Chacune est consommée. */
  faults: string[];
  snapshotFails: boolean;
  snapshotComplete: boolean;
}

/** Compteur propre au processus : les identifiants restent uniques d'un test à l'autre (contrainte d'unicité en base). */
let created = 0;

export const emptyState = (): FakeBufferState => ({ seq: 0, calls: {}, posts: {}, channels: [], faults: [], snapshotFails: false, snapshotComplete: true });

export function readState(path: string): FakeBufferState {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FakeBufferState) : emptyState();
}
export function writeState(path: string, state: FakeBufferState): void {
  writeFileSync(path, JSON.stringify(state));
}

export class FileProvider implements PublishingProvider {
  readonly mode = "mock" as const;
  constructor(private readonly path: string, private readonly prefix = "mock-v3") {}

  private load = () => readState(this.path);
  private save = (state: FakeBufferState) => writeState(this.path, state);
  private count(state: FakeBufferState, name: string) {
    state.calls[name] = (state.calls[name] ?? 0) + 1;
  }
  private fault(state: FakeBufferState, name: string): string | null {
    const index = state.faults.findIndex((item) => item.startsWith(`${name}:`));
    if (index < 0) return null;
    const [item] = state.faults.splice(index, 1);
    return item.slice(name.length + 1);
  }

  calls(name: string): number {
    return this.load().calls[name] ?? 0;
  }

  async fetchSnapshot(): Promise<ProviderSnapshot> {
    const state = this.load();
    this.count(state, "fetchSnapshot");
    this.save(state);
    if (state.snapshotFails) throw new ProviderError("Buffer injoignable", "network", undefined, "unknown");
    return { channels: state.channels, posts: Object.values(state.posts), complete: state.snapshotComplete, rateLimit: null };
  }

  async getPost(id: string): Promise<ProviderPost | null> {
    const state = this.load();
    this.count(state, "getPost");
    const fault = this.fault(state, "getPost");
    this.save(state);
    if (fault === "fail") throw new ProviderError("Buffer injoignable", "network", undefined, "unknown");
    return state.posts[id] ? { ...state.posts[id] } : null;
  }

  async schedulePost(post: ProviderPost): Promise<ProviderPost> {
    const state = this.load();
    this.count(state, "schedulePost");
    const fault = this.fault(state, "schedulePost");
    state.posts[post.id] = { ...state.posts[post.id], status: "scheduled" };
    this.save(state);
    if (fault === "lose") throw new ProviderError("Buffer ne répond pas (délai dépassé).", "network", undefined, "unknown");
    return state.posts[post.id];
  }

  async unschedulePost(post: ProviderPost): Promise<ProviderPost> {
    const state = this.load();
    this.count(state, "unschedulePost");
    const fault = this.fault(state, "unschedulePost");
    if (fault === "429") {
      this.save(state);
      throw new ProviderError("Quota de requêtes Buffer atteint.", "rate_limit", 172_800);
    }
    if (fault === "fail") {
      this.save(state);
      throw new ProviderError("Buffer a refusé la modification : maintenance.");
    }
    if (state.posts[post.id]) state.posts[post.id] = { ...state.posts[post.id], status: "draft" };
    this.save(state);
    return state.posts[post.id];
  }

  private build(state: FakeBufferState, content: DraftContent, id?: string): ProviderPost {
    state.seq += 1;
    return {
      id: id ?? `${this.prefix}-${(created += 1)}`,
      channelId: content.channelId,
      service: content.service,
      status: "draft",
      text: content.text,
      dueAt: content.dueAt,
      sentAt: null,
      updatedAt: null,
      externalLink: null,
      error: null,
      hasReviewTag: true,
      schedulingType: "automatic",
      assets: content.assets.map((asset) => ({ type: asset.type, source: asset.url, thumbnail: asset.url, mimeType: asset.type === "video" ? "video/mp4" : "image/jpeg" })),
    };
  }

  async createDraft(content: DraftContent): Promise<ProviderPost> {
    const state = this.load();
    this.count(state, "createDraft");
    const fault = this.fault(state, "createDraft");
    if (fault === "refuse") {
      this.save(state);
      throw new ProviderError("Buffer a refusé la création : texte trop long.");
    }
    const post = this.build(state, content);
    state.posts[post.id] = post;
    this.save(state);
    if (fault === "lose") throw new ProviderError("Buffer ne répond pas (délai dépassé).", "network", undefined, "unknown");
    if (fault === "unexpected") throw new ProviderError("Erreur de l'API Buffer : UNEXPECTED", "api", undefined, "unknown");
    if (fault === "crash") throw new Error("exception inattendue après l'effet");
    return post;
  }

  async updateDraft(postId: string, content: DraftContent): Promise<ProviderPost> {
    const state = this.load();
    this.count(state, "updateDraft");
    const previous = state.posts[postId];
    if (!previous) throw new ProviderError("Post introuvable.");
    const post = { ...this.build(state, content, postId), status: previous.status === "needs_approval" ? "draft" : previous.status };
    state.posts[postId] = post as ProviderPost;
    this.save(state);
    return post as ProviderPost;
  }

  async rescheduleDraft(post: ProviderPost, dueAt: string): Promise<ProviderPost> {
    const state = this.load();
    this.count(state, "rescheduleDraft");
    state.posts[post.id] = { ...state.posts[post.id], dueAt };
    this.save(state);
    return state.posts[post.id];
  }

  async findDraftCandidates(lookup: DraftLookup) {
    const state = this.load();
    this.count(state, "findDraftCandidates");
    this.save(state);
    if (state.snapshotFails) throw new ProviderError("Buffer injoignable", "network", undefined, "unknown");
    const instant = Date.parse(lookup.dueAt);
    const sameChannel = Object.values(state.posts).filter((post) => post.channelId === lookup.channelId);
    const media = (post: ProviderPost) =>
      !lookup.assetKinds || (post.assets.length === lookup.assetKinds.length && post.assets.every((asset, index) => asset.type === lookup.assetKinds![index]));
    const exact = (post: ProviderPost) => post.text === lookup.text && post.dueAt !== null && Date.parse(post.dueAt) === instant && media(post);
    return {
      candidates: sameChannel.filter(exact),
      possible: sameChannel.filter((post) => !exact(post) && (post.text === lookup.text || (post.dueAt !== null && Date.parse(post.dueAt) === instant))),
      complete: state.snapshotComplete,
    };
  }
}
