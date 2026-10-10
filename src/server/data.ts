import "server-only";

import { DEFAULT_PREFERENCES, type NotificationPreferences } from "@/lib/domain/notifications";
import { NO_SYNC_STATUS, NO_URGENT_STATUS, type SyncStatus, type UrgentStatus } from "@/lib/domain/sync-health";
import type { Channel, Comment, NotificationEntry, Post, PostEvent, Profile, SyncRun } from "@/lib/types";
import { env } from "@/server/env";
import { createSessionClient } from "@/server/supabase/clients";

/*
 * Lectures de données. Toutes passent par la session de l'utilisateur :
 * c'est la base (règles RLS) qui décide de ce qu'il a le droit de voir.
 */

const POST_COLUMNS_LEGACY =
  "id, buffer_post_id, channel_id, service, text, assets, due_at, buffer_status, buffer_error, external_link, sent_at, has_review_tag, content_hash, version, approval_status, approved_version, approved_at, approved_by, submitted_at, schedule_state, schedule_error, schedule_attempts, removed_at, synced_at, created_at";
/** Colonnes d'appartenance de la migration 0009 ; sur un schéma plus ancien, la lecture se rabat sur la liste d'avant. */
const POST_COLUMNS = `${POST_COLUMNS_LEGACY}, ownership, owner_organization_id`;
const UNDEFINED_COLUMN = "42703";

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
    ownership: row.ownership ?? undefined,
    ownerOrganizationId: row.owner_organization_id ?? null,
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
    lastOrganizationId: row.last_organization_id ?? null,
    visibleFrom: row.visible_from ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Les données simulées (« mock- ») et les vraies ne s'affichent jamais ensemble. */
const MOCK_PATTERN = "mock-%";
/** En mode simulé, seuls les posts de la série en cours sont affichés : ceux des séries de tests passées restent en base. */
const mockRunPattern = () => `mock-${env.mockRunId}-%`;
/** Les posts publiés depuis plus longtemps ne sont plus chargés : ils alourdiraient chaque page sans utilité. */
const PUBLISHED_HISTORY_DAYS = 90;

function fail(context: string, message: string): never {
  throw new Error(`Lecture impossible (${context}) : ${message}`);
}

export async function listChannels(): Promise<Channel[]> {
  const supabase = await createSessionClient();
  let query = supabase
    .from("channels")
    // « * » : last_organization_id et visible_from n'existent qu'après la migration 0005.
    .select("*")
    .order("service");
  query = env.bufferMode === "mock" ? query.like("buffer_channel_id", MOCK_PATTERN) : query.not("buffer_channel_id", "like", MOCK_PATTERN);
  const { data, error } = await query;
  if (error) fail("canaux", error.message);
  return data.map(toChannel);
}

export async function listPosts(): Promise<Post[]> {
  const supabase = await createSessionClient();
  const since = new Date(Date.now() - PUBLISHED_HISTORY_DAYS * 86_400_000).toISOString();
  const run = (columns: string) => {
    let query = supabase.from("posts").select(columns).is("removed_at", null).order("due_at", { ascending: true, nullsFirst: false });
    query = env.bufferMode === "mock" ? query.like("buffer_post_id", mockRunPattern()) : query.not("buffer_post_id", "like", MOCK_PATTERN);
    return query.or(`buffer_status.neq.sent,sent_at.gte.${since},sent_at.is.null`);
  };
  let { data, error } = await run(POST_COLUMNS);
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await run(POST_COLUMNS_LEGACY));
  if (error) fail("posts", error.message);
  return (data ?? []).map(toPost);
}

export async function getPost(id: string): Promise<Post | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = await createSessionClient();
  let { data, error } = await supabase.from("posts").select(POST_COLUMNS).eq("id", id).maybeSingle();
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await supabase.from("posts").select(POST_COLUMNS_LEGACY).eq("id", id).maybeSingle());
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

/**
 * Historique, les plus récents d'abord. Avec `postId` : celui d'un post.
 * Sans : les derniers événements de tout ce que l'utilisateur a le droit de voir.
 */
export async function listEvents(options: { postId?: string; limit?: number } = {}): Promise<PostEvent[]> {
  const supabase = await createSessionClient();
  let query = supabase
    .from("post_events")
    .select("id, post_id, type, actor_id, detail, version, created_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(options.limit ?? 200);
  if (options.postId) query = query.eq("post_id", options.postId);
  const { data, error } = await query;
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

/**
 * État de la synchronisation. Lu dans sync_state (migration 0006) ; sur une base qui ne l'a pas,
 * déduit du journal : dernier succès et dernier échec, sans verrou ni suivi du planificateur.
 */
/** Urgences locales : annulations à confirmer et réservations abandonnées (migration 0011 ; zéros sinon). */
async function getUrgentStatus(row: Record<string, unknown> | null): Promise<UrgentStatus> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase
    .from("posts")
    .select("buffer_post_id, schedule_state, due_at, unschedule_since, unschedule_attempts, unschedule_attempted_at, schedule_error, schedule_claimed_at")
    .in("schedule_state", ["unschedule_pending", "claimed"])
    .is("removed_at", null)
    .limit(500);
  const run = {
    lastRunAt: (row?.urgent_last_run_at as string | null | undefined) ?? null,
    lastRunOk: (row?.urgent_last_ok as boolean | null | undefined) ?? null,
    lastRunError: (row?.urgent_last_error as string | null | undefined) ?? null,
  };
  if (error || !data) return { ...NO_URGENT_STATUS, ...run };
  const simulated = (id: string) => id.startsWith("mock-");
  const mine = data.filter((post) => simulated(post.buffer_post_id) === (env.bufferMode === "mock"));
  const pending = mine.filter((post) => post.schedule_state === "unschedule_pending");
  const earliest = <T,>(values: (T | null)[], pick: (a: T, b: T) => boolean): T | null => values.filter((value): value is T => value !== null).reduce<T | null>((best, value) => (best === null || pick(value, best) ? value : best), null);
  const lastAttempt = earliest(pending.map((post) => post.unschedule_attempted_at as string | null), (a, b) => Date.parse(a) > Date.parse(b));
  const staleBefore = Date.now() - 120_000;
  return {
    pendingCancellations: pending.length,
    oldestSince: earliest(pending.map((post) => post.unschedule_since as string | null), (a, b) => Date.parse(a) < Date.parse(b)),
    earliestDue: earliest(pending.map((post) => post.due_at as string | null), (a, b) => Date.parse(a) < Date.parse(b)),
    lastAttemptAt: lastAttempt,
    attempts: pending.reduce((sum, post) => sum + Number(post.unschedule_attempts ?? 0), 0),
    lastAttemptError: (pending.find((post) => post.unschedule_attempted_at === lastAttempt)?.schedule_error as string | null | undefined) ?? null,
    staleClaims: mine.filter((post) => post.schedule_state === "claimed" && post.schedule_claimed_at && Date.parse(post.schedule_claimed_at) < staleBefore).length,
    ...run,
  };
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("sync_state").select("*").eq("mode", env.bufferMode).maybeSingle();
  if (!error) {
    const urgent = await getUrgentStatus(data);
    if (!data) return { ...NO_SYNC_STATUS, tracked: true, urgent };
    return {
      tracked: true,
      running: data.locked_until !== null && Date.parse(data.locked_until) > Date.now(),
      lastStartedAt: data.last_started_at,
      lastSuccessAt: data.last_success_at,
      lastFailureAt: data.last_failure_at,
      lastError: data.last_error,
      consecutiveFailures: data.consecutive_failures,
      lastScheduledAt: data.last_scheduled_at,
      backoffUntil: data.backoff_until,
      backoffReason: data.backoff_reason,
      anomalies: Array.isArray(data.anomalies) ? data.anomalies.filter((item: unknown) => typeof item === "string") : [],
      urgent,
    };
  }
  const runs = await listSyncRuns(20);
  const lastFailure = runs.find((run) => run.status === "error");
  return {
    ...NO_SYNC_STATUS,
    lastSuccessAt: runs.find((run) => run.status === "success")?.createdAt ?? null,
    lastFailureAt: lastFailure?.createdAt ?? null,
    lastError: lastFailure?.error ?? null,
  };
}

/** Adresses e-mail des utilisateurs, par identifiant. Réservé à l'admin ; vide si la migration 0005 manque. */
export async function listUserEmails(): Promise<Record<string, string>> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.rpc("admin_list_user_emails");
  if (error || !data) return {};
  return Object.fromEntries((data as { user_id: string; email: string }[]).map((row) => [row.user_id, row.email]));
}

/**
 * Historique des notifications visibles par l'utilisateur (les siennes ; toutes pour l'admin).
 * null : la base n'a pas la migration 0007.
 */
export async function listNotifications(limit = 50): Promise<NotificationEntry[] | null> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, recipient_id, post_id, organization_id, detail, status, error, created_at, sent_at")
    .eq("mode", env.bufferMode)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return null;
  return data.map((row) => ({
    id: row.id,
    kind: row.kind,
    recipientId: row.recipient_id,
    postId: row.post_id,
    organizationId: row.organization_id,
    detail: row.detail,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }));
}

/** Préférences de l'utilisateur connecté, ou les valeurs par défaut s'il n'a rien réglé. */
export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const supabase = await createSessionClient();
  const { data } = await supabase
    .from("notification_preferences")
    .select("review_requested, changes_requested, approved, schedule_error")
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? DEFAULT_PREFERENCES;
}
