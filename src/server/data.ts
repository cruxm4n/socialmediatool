import "server-only";

import type { Channel, Comment, Post, PostEvent, Profile, SyncRun } from "@/lib/types";
import { env } from "@/server/env";
import { createSessionClient } from "@/server/supabase/clients";

/*
 * Lectures de données. Toutes passent par la session de l'utilisateur :
 * c'est la base (règles RLS) qui décide de ce qu'il a le droit de voir.
 */

const POST_COLUMNS =
  "id, buffer_post_id, channel_id, service, text, assets, due_at, buffer_status, buffer_error, external_link, sent_at, has_review_tag, content_hash, version, approval_status, approved_version, approved_at, approved_by, submitted_at, schedule_state, schedule_error, schedule_attempts, removed_at, synced_at, created_at";

/* eslint-disable @typescript-eslint/no-explicit-any -- lignes brutes renvoyées par l'API Supabase */
function toPost(row: any): Post {
  return {
    id: row.id,
    bufferPostId: row.buffer_post_id,
    channelId: row.channel_id,
    service: row.service,
    text: row.text,
    assets: row.assets ?? [],
    dueAt: row.due_at,
    bufferStatus: row.buffer_status,
    bufferError: row.buffer_error,
    externalLink: row.external_link,
    sentAt: row.sent_at,
    hasReviewTag: row.has_review_tag,
    contentHash: row.content_hash,
    version: row.version,
    approvalStatus: row.approval_status,
    approvedVersion: row.approved_version,
    approvedAt: row.approved_at,
    approvedById: row.approved_by,
    submittedAt: row.submitted_at,
    scheduleState: row.schedule_state,
    scheduleError: row.schedule_error,
    scheduleAttempts: row.schedule_attempts,
    removedAt: row.removed_at,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
  };
}

function toChannel(row: any): Channel {
  return {
    id: row.id,
    bufferChannelId: row.buffer_channel_id,
    service: row.service,
    name: row.name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isDisconnected: row.is_disconnected,
    organizationId: row.organization_id,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Les données simulées (« mock- ») et les vraies ne s'affichent jamais ensemble. */
const MOCK_PATTERN = "mock-%";

function fail(context: string, message: string): never {
  throw new Error(`Lecture impossible (${context}) : ${message}`);
}

export async function listChannels(): Promise<Channel[]> {
  const supabase = await createSessionClient();
  let query = supabase
    .from("channels")
    .select("id, buffer_channel_id, service, name, display_name, avatar_url, is_disconnected, organization_id")
    .order("service");
  query = env.bufferMode === "mock" ? query.like("buffer_channel_id", MOCK_PATTERN) : query.not("buffer_channel_id", "like", MOCK_PATTERN);
  const { data, error } = await query;
  if (error) fail("canaux", error.message);
  return data.map(toChannel);
}

export async function listPosts(): Promise<Post[]> {
  const supabase = await createSessionClient();
  let query = supabase.from("posts").select(POST_COLUMNS).is("removed_at", null).order("due_at", { ascending: true, nullsFirst: false });
  query = env.bufferMode === "mock" ? query.like("buffer_post_id", MOCK_PATTERN) : query.not("buffer_post_id", "like", MOCK_PATTERN);
  const { data, error } = await query;
  if (error) fail("posts", error.message);
  return data.map(toPost);
}

export async function getPost(id: string): Promise<Post | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("posts").select(POST_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail("post", error.message);
  return data ? toPost(data) : null;
}

export async function listComments(postId: string): Promise<Comment[]> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase
    .from("comments")
    .select("id, post_id, author_id, body, kind, version, created_at")
    .eq("post_id", postId)
    .order("created_at");
  if (error) fail("commentaires", error.message);
  return data.map((row) => ({
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    body: row.body,
    kind: row.kind,
    version: row.version,
    createdAt: row.created_at,
  }));
}

/** Historique d'un post, ou des posts donnés (les plus récents d'abord). */
export async function listEvents(postIds: string[], limit = 200): Promise<PostEvent[]> {
  if (postIds.length === 0) return [];
  const supabase = await createSessionClient();
  const { data, error } = await supabase
    .from("post_events")
    .select("id, post_id, type, actor_id, detail, version, created_at")
    .in("post_id", postIds)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) fail("historique", error.message);
  return data.map((row) => ({
    id: row.id,
    postId: row.post_id,
    type: row.type,
    actorId: row.actor_id,
    detail: row.detail,
    version: row.version,
    createdAt: row.created_at,
  }));
}

export async function listProfiles(): Promise<Profile[]> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("profiles").select("id, full_name, job_title, role").order("full_name");
  if (error) fail("profils", error.message);
  return data.map((row) => ({ id: row.id, fullName: row.full_name, jobTitle: row.job_title, role: row.role }));
}

export async function listMembers(): Promise<{ organizationId: string; userId: string }[]> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("organization_members").select("organization_id, user_id");
  if (error) fail("membres", error.message);
  return data.map((row) => ({ organizationId: row.organization_id, userId: row.user_id }));
}

export async function listSyncRuns(limit = 20): Promise<SyncRun[]> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase
    .from("sync_runs")
    .select("id, mode, status, triggered_by, fetched, created, updated, invalidated, removed, error, rate_limit, created_at")
    .eq("mode", env.bufferMode)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) fail("synchronisations", error.message);
  return data.map((row) => ({
    id: row.id,
    mode: row.mode,
    status: row.status,
    triggeredBy: row.triggered_by,
    fetched: row.fetched,
    created: row.created,
    updated: row.updated,
    invalidated: row.invalidated,
    removed: row.removed,
    error: row.error,
    rateLimit: row.rate_limit,
    createdAt: row.created_at,
  }));
}
