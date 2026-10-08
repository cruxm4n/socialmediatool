-- Cadence — schéma initial
-- Appliqué au projet Supabase « socialflow-dev » le 8 octobre 2026 (en quatre migrations successives).
-- Aucune fonction ne supprime de données : un post disparu de Buffer est marqué removed_at.
-- Buffer est la source de vérité du contenu des posts. Cette base garde les clients,
-- les droits, les validations, les commentaires et l'état de la programmation.

create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  sector text not null default '',
  timezone text not null default 'Europe/Paris',
  initials text not null,
  color text not null default '#1f4f8f',
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  job_title text not null default '',
  role text not null check (role in ('admin', 'client')),
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

-- Un canal Buffer appartient à au plus un client. C'est ce lien qui rattache un post à un client.
create table public.channels (
  id uuid primary key default gen_random_uuid(),
  buffer_channel_id text not null unique,
  service text not null,
  name text not null,
  display_name text,
  avatar_url text,
  is_disconnected boolean not null default false,
  organization_id uuid references public.organizations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index channels_organization_idx on public.channels (organization_id);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  buffer_post_id text not null unique,
  channel_id uuid not null references public.channels (id) on delete cascade,
  service text not null,
  -- Copie du contenu Buffer, rafraîchie à chaque synchronisation
  text text not null default '',
  assets jsonb not null default '[]'::jsonb,
  due_at timestamptz,
  buffer_status text not null check (buffer_status in ('draft', 'needs_approval', 'scheduled', 'sending', 'sent', 'error')),
  buffer_error text,
  external_link text,
  sent_at timestamptz,
  buffer_updated_at timestamptz,
  has_review_tag boolean not null default false,
  -- Empreinte du contenu validable (texte, médias, date, canal) et numéro de version
  content_hash text not null,
  version integer not null default 1,
  -- Validation par le client
  approval_status text not null default 'none' check (approval_status in ('none', 'pending', 'changes_requested', 'approved')),
  approved_hash text,
  approved_version integer,
  approved_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz,
  -- Programmation dans Buffer déclenchée par le dashboard
  schedule_state text not null default 'idle' check (schedule_state in ('idle', 'claimed', 'scheduled', 'failed', 'unschedule_pending')),
  schedule_attempts integer not null default 0,
  schedule_error text,
  schedule_claimed_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create index posts_channel_idx on public.posts (channel_id);
create index posts_due_idx on public.posts (due_at);
create index posts_approval_idx on public.posts (approval_status);

create table public.approval_decisions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  version integer not null,
  content_hash text not null,
  decision text not null check (decision in ('approved', 'changes_requested')),
  user_id uuid not null references public.profiles (id) on delete cascade,
  comment text,
  created_at timestamptz not null default now()
);
create index approval_decisions_post_idx on public.approval_decisions (post_id);
create index approval_decisions_user_idx on public.approval_decisions (user_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (length(trim(body)) > 0),
  kind text not null default 'comment' check (kind in ('comment', 'change_request')),
  version integer not null,
  created_at timestamptz not null default now()
);
create index comments_post_idx on public.comments (post_id);
create index comments_author_idx on public.comments (author_id);

create table public.post_events (
  id bigint generated always as identity primary key,
  post_id uuid not null references public.posts (id) on delete cascade,
  type text not null,
  actor_id uuid references public.profiles (id) on delete set null,
  detail text,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create index post_events_post_idx on public.post_events (post_id);
create index post_events_actor_idx on public.post_events (actor_id);
create index posts_approved_by_idx on public.posts (approved_by);

create table public.sync_runs (
  id bigint generated always as identity primary key,
  mode text not null,
  status text not null check (status in ('success', 'error')),
  triggered_by text not null default 'manual',
  fetched integer not null default 0,
  created integer not null default 0,
  updated integer not null default 0,
  invalidated integer not null default 0,
  removed integer not null default 0,
  error text,
  rate_limit jsonb,
  created_at timestamptz not null default now()
);

-- Secret partagé entre le serveur de l'application (plus tard n8n) et la base.
-- Seule son empreinte est stockée. La table est hors du schéma exposé par l'API.
create table private.app_secrets (
  name text primary key,
  secret_hash text not null
);

-- ---------------------------------------------------------------------------
-- Fonctions utilitaires
-- ---------------------------------------------------------------------------

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;

create or replace function private.my_org_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select organization_id from public.organization_members where user_id = (select auth.uid());
$$;

create or replace function private.check_secret(p_secret text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_secret is null or not exists (
    select 1 from private.app_secrets
    where name = 'automation'
      and secret_hash = encode(extensions.digest(p_secret, 'sha256'), 'hex')
  ) then
    raise exception 'invalid_secret' using errcode = '42501';
  end if;
end;
$$;

-- Empreinte de ce que le client valide : texte, date, canal et médias (dans l'ordre).
create or replace function private.post_hash(p_text text, p_due_at timestamptz, p_channel text, p_assets jsonb)
returns text language sql immutable set search_path = '' as $$
  select md5(
    coalesce(p_text, '') || chr(31) ||
    coalesce(to_char(p_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), '') || chr(31) ||
    coalesce(p_channel, '') || chr(31) ||
    coalesce((
      select string_agg(coalesce(a.value ->> 'type', '') || ':' || coalesce(a.value ->> 'source', ''), ',' order by a.ordinality)
      from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) with ordinality as a
    ), '')
  );
$$;

create or replace function private.add_event(p_post_id uuid, p_type text, p_actor uuid, p_detail text, p_version integer)
returns void language sql security definer set search_path = '' as $$
  insert into public.post_events (post_id, type, actor_id, detail, version)
  values (p_post_id, p_type, p_actor, p_detail, p_version);
$$;

-- ---------------------------------------------------------------------------
-- Synchronisation : reçoit l'état de Buffer et met la base à jour en une transaction
-- ---------------------------------------------------------------------------

create or replace function public.sync_buffer_posts(p_secret text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mode text := coalesce(p_payload ->> 'mode', 'real');
  v_is_mock boolean := coalesce(p_payload ->> 'mode', 'real') = 'mock';
  v_c jsonb;
  v_p jsonb;
  v_row public.posts%rowtype;
  v_channel_id uuid;
  v_hash text;
  v_tag boolean;
  v_status text;
  v_due timestamptz;
  v_approval text;
  v_version integer;
  v_sched text;
  v_attempts integer;
  v_post_id uuid;
  v_fetched integer := 0;
  v_created integer := 0;
  v_updated integer := 0;
  v_invalidated integer := 0;
  v_removed integer := 0;
  v_seen text[] := '{}';
begin
  perform private.check_secret(p_secret);

  for v_c in select * from jsonb_array_elements(coalesce(p_payload -> 'channels', '[]'::jsonb)) loop
    insert into public.channels (buffer_channel_id, service, name, display_name, avatar_url, is_disconnected, organization_id)
    values (
      v_c ->> 'id', v_c ->> 'service', v_c ->> 'name', v_c ->> 'displayName', v_c ->> 'avatar',
      coalesce((v_c ->> 'isDisconnected')::boolean, false),
      (select id from public.organizations where slug = v_c ->> 'organizationSlug')
    )
    on conflict (buffer_channel_id) do update set
      service = excluded.service,
      name = excluded.name,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      is_disconnected = excluded.is_disconnected,
      updated_at = now();
  end loop;

  for v_p in select * from jsonb_array_elements(coalesce(p_payload -> 'posts', '[]'::jsonb)) loop
    v_fetched := v_fetched + 1;
    v_seen := v_seen || (v_p ->> 'id');

    select id into v_channel_id from public.channels where buffer_channel_id = v_p ->> 'channelId';
    continue when v_channel_id is null;

    v_status := v_p ->> 'status';
    v_tag := coalesce((v_p ->> 'hasReviewTag')::boolean, false);
    v_due := (v_p ->> 'dueAt')::timestamptz;
    v_hash := private.post_hash(v_p ->> 'text', v_due, v_p ->> 'channelId', v_p -> 'assets');

    select * into v_row from public.posts where buffer_post_id = v_p ->> 'id' for update;

    if not found then
      insert into public.posts (
        buffer_post_id, channel_id, service, text, assets, due_at, buffer_status, buffer_error, external_link,
        sent_at, buffer_updated_at, has_review_tag, content_hash, approval_status, submitted_at
      ) values (
        v_p ->> 'id', v_channel_id, v_p ->> 'service', coalesce(v_p ->> 'text', ''), coalesce(v_p -> 'assets', '[]'::jsonb),
        v_due, v_status, v_p ->> 'error', v_p ->> 'externalLink', (v_p ->> 'sentAt')::timestamptz,
        (v_p ->> 'updatedAt')::timestamptz, v_tag, v_hash,
        case when v_tag and v_status = 'draft' then 'pending' else 'none' end,
        case when v_tag and v_status = 'draft' then now() end
      ) returning id into v_post_id;
      if v_tag and v_status = 'draft' then
        perform private.add_event(v_post_id, 'submitted', null, null, 1);
      end if;
      v_created := v_created + 1;
      continue;
    end if;

    v_approval := v_row.approval_status;
    v_version := v_row.version;
    v_sched := v_row.schedule_state;
    v_attempts := v_row.schedule_attempts;

    -- 1. Le contenu a changé dans Buffer
    if v_hash <> v_row.content_hash and v_status in ('draft', 'needs_approval', 'scheduled') then
      if v_approval = 'approved' then
        v_approval := 'pending';
        v_version := v_version + 1;
        v_invalidated := v_invalidated + 1;
        -- Déjà programmé par le dashboard : il faudra le repasser en brouillon dans Buffer.
        v_sched := case when v_sched = 'scheduled' and v_status = 'scheduled' then 'unschedule_pending' else 'idle' end;
        v_attempts := 0;
        perform private.add_event(v_row.id, 'approval_invalidated', null, null, v_version);
      elsif v_approval = 'changes_requested' then
        v_approval := 'pending';
        v_version := v_version + 1;
        perform private.add_event(v_row.id, 'resubmitted', null, null, v_version);
      elsif v_approval = 'pending' then
        v_version := v_version + 1;
        perform private.add_event(v_row.id, 'updated', null, null, v_version);
      end if;
    end if;

    -- 2. Le tag « à valider » a été posé ou retiré sur un brouillon
    if v_status = 'draft' then
      if v_approval = 'none' and v_tag then
        v_approval := 'pending';
        perform private.add_event(v_row.id, 'submitted', null, null, v_version);
      elsif v_approval in ('pending', 'changes_requested') and not v_tag then
        v_approval := 'none';
        perform private.add_event(v_row.id, 'withdrawn', null, null, v_version);
      end if;
    end if;

    -- 3. Le post programmé par le dashboard est redevenu brouillon dans Buffer
    if v_status = 'draft' and v_sched = 'scheduled' then
      v_sched := 'idle';
      v_attempts := 0;
      if v_approval = 'approved' then
        v_approval := 'pending';
        v_invalidated := v_invalidated + 1;
        perform private.add_event(v_row.id, 'unscheduled_in_buffer', null, null, v_version);
      end if;
    end if;

    -- 4. Publication ou échec constatés dans Buffer
    if v_status = 'sent' and v_row.buffer_status <> 'sent' then
      perform private.add_event(v_row.id, 'published', null, null, v_version);
    elsif v_status = 'error' and v_row.buffer_status <> 'error' then
      perform private.add_event(v_row.id, 'failed', null, v_p ->> 'error', v_version);
    end if;

    update public.posts set
      channel_id = v_channel_id,
      service = v_p ->> 'service',
      text = coalesce(v_p ->> 'text', ''),
      assets = coalesce(v_p -> 'assets', '[]'::jsonb),
      due_at = v_due,
      buffer_status = v_status,
      buffer_error = v_p ->> 'error',
      external_link = v_p ->> 'externalLink',
      sent_at = (v_p ->> 'sentAt')::timestamptz,
      buffer_updated_at = (v_p ->> 'updatedAt')::timestamptz,
      has_review_tag = v_tag,
      content_hash = v_hash,
      version = v_version,
      approval_status = v_approval,
      approved_hash = case when v_approval = 'approved' then approved_hash end,
      approved_version = case when v_approval = 'approved' then approved_version end,
      approved_at = case when v_approval = 'approved' then approved_at end,
      approved_by = case when v_approval = 'approved' then approved_by end,
      submitted_at = case when v_approval = 'pending' and v_row.approval_status <> 'pending' then now() else submitted_at end,
      schedule_state = v_sched,
      schedule_attempts = v_attempts,
      schedule_error = case when v_sched = 'idle' then null else schedule_error end,
      removed_at = null,
      synced_at = now()
    where id = v_row.id;
    v_updated := v_updated + 1;
  end loop;

  -- Posts absents de Buffer : supprimés là-bas. Les posts déjà publiés sont conservés pour l'historique.
  if coalesce((p_payload ->> 'complete')::boolean, false) then
    with gone as (
      update public.posts set removed_at = now()
      where removed_at is null
        and buffer_status <> 'sent'
        and (buffer_post_id like 'mock-%') = v_is_mock
        and not (buffer_post_id = any (v_seen))
      returning id, version
    ), logged as (
      insert into public.post_events (post_id, type, version)
      select id, 'removed', version from gone
      returning 1
    )
    select count(*) into v_removed from logged;
  end if;

  insert into public.sync_runs (mode, status, triggered_by, fetched, created, updated, invalidated, removed, rate_limit)
  values (v_mode, 'success', coalesce(p_payload ->> 'triggeredBy', 'manual'), v_fetched, v_created, v_updated, v_invalidated, v_removed, p_payload -> 'rateLimit');

  return jsonb_build_object('fetched', v_fetched, 'created', v_created, 'updated', v_updated, 'invalidated', v_invalidated, 'removed', v_removed);
end;
$$;

create or replace function public.record_sync_failure(p_secret text, p_mode text, p_error text, p_triggered_by text default 'manual')
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  insert into public.sync_runs (mode, status, triggered_by, error) values (p_mode, 'error', p_triggered_by, left(p_error, 1000));
end;
$$;

-- ---------------------------------------------------------------------------
-- Décision du client
-- ---------------------------------------------------------------------------

create or replace function public.decide_post(p_post_id uuid, p_decision text, p_expected_hash text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_post public.posts%rowtype;
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_decision not in ('approved', 'changes_requested') then
    raise exception 'invalid_decision';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid and role = 'client') then
    raise exception 'forbidden';
  end if;

  -- Verrou de ligne : deux décisions simultanées sont traitées l'une après l'autre.
  select * into v_post from public.posts where id = p_post_id for update;

  -- Un post d'un autre client est traité comme inexistant.
  if not found or v_post.removed_at is not null or v_post.approval_status = 'none' or not exists (
    select 1 from public.channels c
    join public.organization_members m on m.organization_id = c.organization_id
    where c.id = v_post.channel_id and m.user_id = v_uid
  ) then
    raise exception 'not_found';
  end if;

  if v_post.approval_status <> 'pending' then
    raise exception 'not_pending';
  end if;
  if v_post.buffer_status <> 'draft' then
    raise exception 'not_draft';
  end if;
  if v_post.content_hash <> p_expected_hash then
    raise exception 'stale_version';
  end if;
  if p_decision = 'changes_requested' and v_comment is null then
    raise exception 'comment_required';
  end if;

  insert into public.approval_decisions (post_id, version, content_hash, decision, user_id, comment)
  values (v_post.id, v_post.version, v_post.content_hash, p_decision, v_uid, v_comment);

  if p_decision = 'approved' then
    update public.posts set
      approval_status = 'approved', approved_hash = content_hash, approved_version = version,
      approved_at = now(), approved_by = v_uid,
      schedule_state = 'idle', schedule_attempts = 0, schedule_error = null
    where id = v_post.id;
  else
    update public.posts set approval_status = 'changes_requested' where id = v_post.id;
  end if;

  if v_comment is not null then
    insert into public.comments (post_id, author_id, body, kind, version)
    values (v_post.id, v_uid, v_comment, case when p_decision = 'changes_requested' then 'change_request' else 'comment' end, v_post.version);
  end if;

  perform private.add_event(v_post.id, p_decision, v_uid, null, v_post.version);
  return jsonb_build_object('status', p_decision, 'version', v_post.version);
end;
$$;

create or replace function public.add_comment(p_post_id uuid, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_post public.posts%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if nullif(trim(coalesce(p_body, '')), '') is null then
    raise exception 'comment_required';
  end if;
  select * into v_post from public.posts where id = p_post_id;
  if not found or not (
    private.is_admin() or (
      v_post.approval_status <> 'none' and v_post.removed_at is null and exists (
        select 1 from public.channels c
        join public.organization_members m on m.organization_id = c.organization_id
        where c.id = v_post.channel_id and m.user_id = v_uid
      )
    )
  ) then
    raise exception 'not_found';
  end if;
  insert into public.comments (post_id, author_id, body, version) values (v_post.id, v_uid, trim(p_body), v_post.version);
  perform private.add_event(v_post.id, 'commented', v_uid, null, v_post.version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Programmation : réservation atomique, pour qu'un post ne soit jamais programmé deux fois
-- ---------------------------------------------------------------------------

create or replace function public.claim_posts_for_scheduling(p_secret text, p_post_id uuid default null, p_limit integer default 10)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text, version integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  return query
  update public.posts p set
    schedule_state = 'claimed', schedule_claimed_at = now(), schedule_attempts = p.schedule_attempts + 1
  where p.id in (
    select c.id from public.posts c
    where c.approval_status = 'approved'
      and c.approved_hash = c.content_hash
      and c.buffer_status = 'draft'
      and c.removed_at is null
      and c.due_at > now() + interval '2 minutes'
      and (p_post_id is null or c.id = p_post_id)
      and (
        c.schedule_state = 'idle'
        or (c.schedule_state = 'failed' and c.schedule_attempts < 5)
        or (c.schedule_state = 'claimed' and c.schedule_claimed_at < now() - interval '10 minutes')
      )
    order by c.due_at
    limit p_limit
    for update skip locked
  )
  returning p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service, p.version;
end;
$$;

create or replace function public.complete_scheduling(p_secret text, p_post_id uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_version integer;
begin
  perform private.check_secret(p_secret);
  if p_ok then
    update public.posts set schedule_state = 'scheduled', buffer_status = 'scheduled', schedule_error = null
    where id = p_post_id and schedule_state = 'claimed' returning version into v_version;
    if found then perform private.add_event(p_post_id, 'scheduled', null, null, v_version); end if;
  else
    update public.posts set schedule_state = 'failed', schedule_error = left(coalesce(p_error, 'Erreur inconnue'), 500)
    where id = p_post_id and schedule_state = 'claimed' returning version into v_version;
    if found then perform private.add_event(p_post_id, 'schedule_failed', null, left(p_error, 500), v_version); end if;
  end if;
end;
$$;

create or replace function public.list_posts_to_unschedule(p_secret text)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  return query
  select p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service
  from public.posts p where p.schedule_state = 'unschedule_pending' and p.removed_at is null;
end;
$$;

create or replace function public.complete_unscheduling(p_secret text, p_post_id uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_version integer;
begin
  perform private.check_secret(p_secret);
  if p_ok then
    update public.posts set schedule_state = 'idle', buffer_status = 'draft', schedule_error = null, schedule_attempts = 0
    where id = p_post_id and schedule_state = 'unschedule_pending' returning version into v_version;
    if found then perform private.add_event(p_post_id, 'unscheduled', null, null, v_version); end if;
  else
    update public.posts set schedule_error = left(coalesce(p_error, 'Erreur inconnue'), 500)
    where id = p_post_id and schedule_state = 'unschedule_pending';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_admin(), private.my_org_ids() to authenticated;

grant execute on function public.decide_post(uuid, text, text, text) to authenticated;
grant execute on function public.add_comment(uuid, text) to authenticated;
-- Fonctions d'automatisation : protégées par le secret partagé, appelables sans session utilisateur.
grant execute on function public.sync_buffer_posts(text, jsonb) to anon, authenticated;
grant execute on function public.record_sync_failure(text, text, text, text) to anon, authenticated;
grant execute on function public.claim_posts_for_scheduling(text, uuid, integer) to anon, authenticated;
grant execute on function public.complete_scheduling(text, uuid, boolean, text) to anon, authenticated;
grant execute on function public.list_posts_to_unschedule(text) to anon, authenticated;
grant execute on function public.complete_unscheduling(text, uuid, boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security : l'isolation entre clients est garantie ici, pas dans l'interface
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.channels enable row level security;
alter table public.posts enable row level security;
alter table public.approval_decisions enable row level security;
alter table public.comments enable row level security;
alter table public.post_events enable row level security;
alter table public.sync_runs enable row level security;
alter table private.app_secrets enable row level security;

-- Aucune écriture directe par l'API, sauf le rattachement canal ↔ client par l'admin.
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant update (organization_id) on public.channels to authenticated;
revoke all on all tables in schema private from anon, authenticated;

create policy organizations_select on public.organizations for select to authenticated
  using ((select private.is_admin()) or id in (select private.my_org_ids()));

create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_admin())
    or role = 'admin'
    or id in (select m.user_id from public.organization_members m where m.organization_id in (select private.my_org_ids()))
  );

create policy organization_members_select on public.organization_members for select to authenticated
  using ((select private.is_admin()) or organization_id in (select private.my_org_ids()));

create policy channels_select on public.channels for select to authenticated
  using ((select private.is_admin()) or organization_id in (select private.my_org_ids()));

create policy channels_assign on public.channels for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Un client ne voit un post que s'il est rattaché à son organisation, soumis à validation et non supprimé.
create policy posts_select on public.posts for select to authenticated
  using (
    (select private.is_admin())
    or (
      approval_status <> 'none'
      and removed_at is null
      and channel_id in (select c.id from public.channels c where c.organization_id in (select private.my_org_ids()))
    )
  );

-- Les tables liées héritent de la visibilité du post (la sous-requête applique la règle ci-dessus).
create policy approval_decisions_select on public.approval_decisions for select to authenticated
  using (post_id in (select p.id from public.posts p));

create policy comments_select on public.comments for select to authenticated
  using (post_id in (select p.id from public.posts p));

create policy post_events_select on public.post_events for select to authenticated
  using (post_id in (select p.id from public.posts p));

create policy sync_runs_select on public.sync_runs for select to authenticated
  using ((select private.is_admin()));
