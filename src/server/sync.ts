import "server-only";

import type { PostAsset } from "@/lib/types";
import { env } from "@/server/env";
import { getProvider } from "@/server/publishing";
import { ProviderError, sameContent, type PublishingProvider } from "@/server/publishing/provider";
import { getAutomationClient } from "@/server/supabase/clients";

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
}

interface ClaimedPost {
  id: string;
  buffer_post_id: string;
  text: string;
  assets: PostAsset[];
  due_at: string | null;
  service: string;
}

function describe(error: unknown): string {
  if (error instanceof ProviderError && error.kind === "rate_limit") {
    return `Quota de requêtes Buffer atteint${error.retryAfterSeconds ? ` (réessayer dans ${Math.ceil(error.retryAfterSeconds / 60)} min)` : ""}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await getAutomationClient().rpc(name, { p_secret: env.automationSecret, ...params });
  if (error) throw new Error(`Fonction ${name} : ${error.message}`);
  return data as T;
}

/** 1. Lit Buffer et met la base à jour (une transaction SQL). */
async function pull(provider: PublishingProvider, triggeredBy: string) {
  const snapshot = await provider.fetchSnapshot();
  return rpc<Pick<SyncResult, "fetched" | "created" | "updated" | "invalidated" | "removed">>("sync_buffer_posts", {
    p_payload: {
      mode: provider.mode,
      triggeredBy,
      complete: snapshot.complete,
      rateLimit: snapshot.rateLimit,
      channels: snapshot.channels,
      posts: snapshot.posts,
    },
  });
}

/**
 * 2. Programme dans Buffer les posts approuvés.
 * La base « réserve » chaque post de façon atomique : deux appels simultanés ne peuvent pas
 * programmer le même post. Avant d'agir, le contenu est relu dans Buffer : s'il diffère de
 * ce que le client a validé, rien n'est programmé.
 */
export async function scheduleApprovedPosts(postId?: string): Promise<{ scheduled: number; failures: number; stale: boolean }> {
  const provider = getProvider();
  const claimed = await rpc<ClaimedPost[]>("claim_posts_for_scheduling", { p_post_id: postId ?? null });
  let scheduled = 0;
  let failures = 0;
  let stale = false;

  let blocked: string | null = null;

  for (const post of claimed ?? []) {
    if (blocked) {
      // Buffer est hors d'atteinte : inutile d'insister, ces posts seront repris à la prochaine synchronisation.
      failures += 1;
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: blocked });
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
        await provider.schedulePost(live);
      }
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: true });
      scheduled += 1;
    } catch (error) {
      failures += 1;
      if (error instanceof ProviderError && error.kind !== "api") blocked = describe(error);
      await rpc("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: describe(error) });
    }
  }
  return { scheduled, failures, stale };
}

/** 3. Repasse en brouillon les posts modifiés après avoir été validés et programmés. */
async function unscheduleInvalidatedPosts(provider: PublishingProvider): Promise<number> {
  const pending = await rpc<ClaimedPost[]>("list_posts_to_unschedule", {});
  let done = 0;
  for (const post of pending ?? []) {
    try {
      const live = await provider.getPost(post.buffer_post_id);
      if (live && live.status === "scheduled") await provider.unschedulePost(live);
      await rpc("complete_unscheduling", { p_post_id: post.id, p_ok: true });
      done += 1;
    } catch (error) {
      await rpc("complete_unscheduling", { p_post_id: post.id, p_ok: false, p_error: describe(error) });
    }
  }
  return done;
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
};

let running: Promise<SyncResult> | null = null;

/** Synchronisation complète. Une seule à la fois par serveur : les appels simultanés partagent le résultat. */
export function runSync(triggeredBy: string): Promise<SyncResult> {
  running ??= doSync(triggeredBy).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(triggeredBy: string): Promise<SyncResult> {
  const provider = getProvider();
  try {
    let counts = await pull(provider, triggeredBy);
    const unscheduled = await unscheduleInvalidatedPosts(provider);
    const scheduling = await scheduleApprovedPosts();
    // Un contenu modifié a été détecté pendant la programmation : on relit Buffer pour annuler la validation.
    if (scheduling.stale) counts = await pull(provider, `${triggeredBy}:relecture`);
    return { ...EMPTY, ...counts, unscheduled, scheduled: scheduling.scheduled, scheduleFailures: scheduling.failures };
  } catch (error) {
    const message = describe(error);
    await rpc("record_sync_failure", { p_mode: provider.mode, p_error: message, p_triggered_by: triggeredBy }).catch(() => undefined);
    return { ...EMPTY, ok: false, error: message };
  }
}
