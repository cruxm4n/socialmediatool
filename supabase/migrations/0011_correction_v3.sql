-- Cadence — mission de correction V3 (migration corrective 0011)
-- Vérifiée sur PGlite et sur PostgreSQL 17 (pile isolée) ; NON appliquée à Supabase distant.
-- À appliquer après 0010. Aucune migration précédente n'est réécrite ; aucune donnée n'est supprimée.
--
--  C03  Reprise URGENTE des compensations et des tentatives interrompues, indépendante du poll général :
--       horodatage et compteur d'annulation, verrou propre au traitement urgent (avec bail renouvelable),
--       renouvellement du bail de synchronisation, liste des réservations abandonnées, marquage explicite
--       d'une programmation à annuler, confirmation « incertaine » qui ne vaut pas échec. Une annulation en
--       échec reste visible (tentatives, dernier essai).
--  C01  Un destinataire ne lit une notification que si la publication concernée lui est encore visible.
--  C05  Un changement de rôle qui rend un approbateur inéligible retire ses accords non publiés.
--  C02  Chaque envoi Studio porte un identifiant de tentative ; une réponse tardive est rapprochée de SA
--       tentative (jamais d'une autre) ; une création sans tentative correspondante est consignée comme
--       « brouillon orphelin » ; l'absence confirmée par une personne exige une preuve consignée.
--
-- Politique de rejeu : rejouable (create or replace / if not exists). Pas de script de retour arrière : revenir
-- aux fonctions de 0010 rouvrirait les défauts corrigés ici (voir docs/ALIGNEMENT_SUPABASE.md).

begin;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'channel_owner_history')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sync_state' and column_name = 'backoff_set_at') then
    raise exception 'migration_0011_requires_0010: appliquez d''abord la migration 0010.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. C03 — suivi des annulations à confirmer
-- ---------------------------------------------------------------------------

alter table public.posts add column if not exists unschedule_since timestamptz;
alter table public.posts add column if not exists unschedule_attempted_at timestamptz;
alter table public.posts add column if not exists unschedule_attempts integer not null default 0;

update public.posts set unschedule_since = coalesce(unschedule_since, now())
where schedule_state = 'unschedule_pending' and unschedule_since is null;

create or replace function private.track_unschedule()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.schedule_state = 'unschedule_pending' and old.schedule_state is distinct from 'unschedule_pending' then
    new.unschedule_since := now();
    new.unschedule_attempts := 0;
    new.unschedule_attempted_at := null;
  elsif new.schedule_state <> 'unschedule_pending' and old.schedule_state = 'unschedule_pending' then
    new.unschedule_since := null;
    new.unschedule_attempts := 0;
    new.unschedule_attempted_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_track_unschedule on public.posts;
create trigger posts_track_unschedule before update of schedule_state on public.posts
  for each row execute function private.track_unschedule();

-- Annulation constatée / échouée : les tentatives sont comptées et datées (visibles de l'administrateur).
create or replace function public.complete_unscheduling(p_secret text, p_post_id uuid, p_ok boolean, p_error text default null, p_observed_status text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_version integer;
begin
  perform private.check_secret(p_secret);
  if p_ok then
    if p_observed_status = 'missing' then
      update public.posts set schedule_state = 'idle', schedule_error = null, schedule_attempts = 0, schedule_token = null
      where id = p_post_id and schedule_state = 'unschedule_pending' returning version into v_version;
      if found then perform private.add_event(p_post_id, 'unschedule_missing', null, null, v_version); end if;
    elsif p_observed_status in ('sent', 'sending', 'error') then
      update public.posts set schedule_state = 'idle', buffer_status = p_observed_status, schedule_error = null, schedule_attempts = 0,
        schedule_token = null
      where id = p_post_id and schedule_state = 'unschedule_pending' returning version into v_version;
      if found then perform private.add_event(p_post_id, 'unschedule_too_late', null, 'Statut Buffer : ' || p_observed_status, v_version); end if;
    elsif p_observed_status in ('draft', 'needs_approval') or p_observed_status is null then
      update public.posts set schedule_state = 'idle', buffer_status = 'draft', schedule_error = null, schedule_attempts = 0,
        schedule_token = null
      where id = p_post_id and schedule_state = 'unschedule_pending' returning version into v_version;
      if found then perform private.add_event(p_post_id, 'unscheduled', null, null, v_version); end if;
    else
      -- Un statut non reconnu n'est jamais une annulation constatée.
      update public.posts set unschedule_attempts = unschedule_attempts + 1, unschedule_attempted_at = now(),
        schedule_error = left('Statut Buffer inattendu après la déprogrammation : « ' || p_observed_status || ' ». Annulation non confirmée.', 500)
      where id = p_post_id and schedule_state = 'unschedule_pending';
    end if;
  else
    update public.posts set schedule_error = left(coalesce(p_error, 'Erreur inconnue'), 500),
      unschedule_attempts = unschedule_attempts + 1, unschedule_attempted_at = now()
    where id = p_post_id and schedule_state = 'unschedule_pending';
  end if;
end;
$$;

-- Programmation à annuler constatée par le serveur (contenu relu dans Buffer différent de ce qui a été validé,
-- réservation abandonnée dont la programmation est vérifiée…). Idempotente ; un post déjà parti n'est pas touché.
create or replace function public.mark_unschedule_needed(p_secret text, p_post_id uuid, p_reason text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_post public.posts%rowtype;
begin
  perform private.check_secret(p_secret);
  select * into v_post from public.posts where id = p_post_id for update;
  if not found or v_post.removed_at is not null then return 'ignored'; end if;
  if v_post.buffer_status in ('sent', 'sending', 'error') then return 'too_late'; end if;
  if v_post.schedule_state = 'unschedule_pending' then return 'pending'; end if;
  update public.posts set
    schedule_state = 'unschedule_pending', buffer_status = 'scheduled', schedule_token = null,
    schedule_claimed_hash = null, schedule_claimed_version = null,
    schedule_error = left(coalesce(p_reason, 'Programmation à annuler dans Buffer.'), 500)
  where id = p_post_id;
  perform private.add_event(p_post_id, 'schedule_stale', null, left(coalesce(p_reason, 'Programmation à annuler dans Buffer'), 200), v_post.version);
  return 'pending';
end;
$$;

-- Confirmation d'une réservation (0010) + résultat INCERTAIN. Une réponse perdue ou illisible de Buffer n'est pas un
-- échec certain : p_uncertain laisse la réservation « en cours » (même jeton) avec la note ; le traitement urgent la
-- rapprochera de l'état réel de Buffer. Une invalidation intervenue entre-temps la fait passer en « annulation à
-- confirmer » (reprise immédiate).
drop function if exists public.complete_scheduling(text, uuid, boolean, text, uuid);
create or replace function public.complete_scheduling(p_secret text, p_post_id uuid, p_ok boolean, p_error text default null, p_token uuid default null, p_uncertain boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_post public.posts%rowtype;
  v_token_ok boolean;
  v_valid boolean;
begin
  perform private.check_secret(p_secret);
  select * into v_post from public.posts where id = p_post_id for update;
  if not found then return 'ignored'; end if;

  v_token_ok := p_token is not null and v_post.schedule_token is not null
    and v_post.schedule_token = p_token and v_post.schedule_state = 'claimed';

  if v_token_ok and not coalesce(p_ok, false) and coalesce(p_uncertain, false) then
    update public.posts set schedule_error = left(coalesce(p_error, 'Résultat incertain : vérification en cours.'), 500)
    where id = p_post_id;
    return 'uncertain';
  end if;

  if not v_token_ok then
    if not coalesce(p_ok, false) then return 'ignored'; end if;
    if v_post.buffer_status in ('sent', 'sending', 'error') or v_post.removed_at is not null then return 'ignored'; end if;
    if v_post.schedule_state = 'claimed' then return 'superseded'; end if;
    if v_post.schedule_state = 'unschedule_pending' then
      update public.posts set buffer_status = case when buffer_status = 'draft' then 'scheduled' else buffer_status end,
        schedule_token = null
      where id = p_post_id;
      perform private.add_event(p_post_id, 'schedule_stale', null, 'Programmation à annuler dans Buffer', v_post.version);
      return 'stale';
    end if;
    if v_post.schedule_state = 'scheduled' and v_post.approval_status = 'approved'
       and v_post.approved_hash = v_post.content_hash and v_post.approved_version = v_post.version then
      return 'ignored';
    end if;
    update public.posts set
      schedule_state = 'unschedule_pending', buffer_status = case when buffer_status = 'draft' then 'scheduled' else buffer_status end,
      schedule_token = null, schedule_claimed_hash = null, schedule_claimed_version = null,
      schedule_error = 'Confirmation tardive d''une opération périmée : annulation de la programmation à confirmer dans Buffer.'
    where id = p_post_id;
    perform private.add_event(p_post_id, 'schedule_stale', null, 'Confirmation tardive : programmation à annuler dans Buffer', v_post.version);
    return 'stale';
  end if;

  v_valid := v_post.removed_at is null
    and v_post.approval_status = 'approved'
    and v_post.approved_hash = v_post.content_hash
    and v_post.approved_version = v_post.version
    and (v_post.schedule_claimed_hash is null or v_post.schedule_claimed_hash = v_post.content_hash)
    and (v_post.schedule_claimed_version is null or v_post.schedule_claimed_version = v_post.version)
    and private.is_post_reviewable(v_post.owner_organization_id, v_post.ownership, v_post.channel_id)
    and v_post.approved_organization_id = v_post.owner_organization_id
    and private.approver_is_valid(v_post.approved_by, v_post.owner_organization_id);

  if coalesce(p_ok, false) then
    if v_valid then
      update public.posts set schedule_state = 'scheduled', buffer_status = 'scheduled', schedule_error = null, schedule_token = null
      where id = p_post_id;
      perform private.add_event(p_post_id, 'scheduled', null, null, v_post.version);
      return 'scheduled';
    end if;
    if v_post.buffer_status in ('sent', 'sending') then
      perform private.add_event(p_post_id, 'schedule_stale', null, 'Réservation périmée, post déjà en cours de publication', v_post.version);
      return 'ignored';
    end if;
    update public.posts set
      schedule_state = 'unschedule_pending', buffer_status = 'scheduled', schedule_token = null,
      schedule_claimed_hash = null, schedule_claimed_version = null,
      schedule_error = 'Programmé dans Buffer par une réservation devenue invalide : annulation à confirmer.'
    where id = p_post_id;
    perform private.add_event(p_post_id, 'schedule_stale', null, 'Programmation à annuler dans Buffer', v_post.version);
    return 'stale';
  end if;

  update public.posts set schedule_state = 'failed', schedule_error = left(coalesce(p_error, 'Erreur inconnue'), 500), schedule_token = null
  where id = p_post_id;
  perform private.add_event(p_post_id, 'schedule_failed', null, left(p_error, 500), v_post.version);
  return 'failed';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. C03 — traitement urgent : verrou, état, travail en attente
-- ---------------------------------------------------------------------------

alter table public.sync_state add column if not exists urgent_token uuid;
alter table public.sync_state add column if not exists urgent_until timestamptz;
alter table public.sync_state add column if not exists urgent_last_run_at timestamptz;
alter table public.sync_state add column if not exists urgent_last_ok boolean;
alter table public.sync_state add column if not exists urgent_last_error text;
alter table public.sync_state add column if not exists urgent_last_done integer not null default 0;

create or replace function public.begin_urgent_run(p_secret text, p_mode text, p_ttl_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.sync_state%rowtype;
  v_token uuid := gen_random_uuid();
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  insert into public.sync_state (mode) values (p_mode) on conflict (mode) do nothing;
  select * into v_state from public.sync_state where mode = p_mode for update;
  if v_state.urgent_until is not null and v_state.urgent_until > now() then
    return jsonb_build_object('acquired', false, 'reason', 'running', 'until', v_state.urgent_until);
  end if;
  update public.sync_state set urgent_token = v_token,
    urgent_until = now() + make_interval(secs => greatest(30, least(coalesce(p_ttl_seconds, 120), 600))),
    urgent_last_run_at = now()
  where mode = p_mode;
  return jsonb_build_object('acquired', true, 'token', v_token);
end;
$$;

-- Renouvelle le bail. Faux : le bail a été perdu (expiré puis repris) → l'appelant doit s'arrêter, il n'agit plus
-- comme détenteur.
create or replace function public.renew_urgent_run(p_secret text, p_mode text, p_token uuid, p_ttl_seconds integer default 120)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  update public.sync_state set urgent_until = now() + make_interval(secs => greatest(30, least(coalesce(p_ttl_seconds, 120), 600)))
  where mode = p_mode and urgent_token = p_token and urgent_until > now();
  return found;
end;
$$;

create or replace function public.finish_urgent_run(p_secret text, p_mode text, p_token uuid, p_ok boolean, p_error text default null, p_done integer default 0)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  update public.sync_state set urgent_token = null, urgent_until = null, urgent_last_run_at = now(),
    urgent_last_ok = p_ok, urgent_last_error = case when p_ok then null else left(coalesce(p_error, 'Erreur inconnue'), 500) end,
    urgent_last_done = greatest(coalesce(p_done, 0), 0)
  where mode = p_mode and urgent_token = p_token;
  return found;
end;
$$;

-- Renouvelle le bail de la synchronisation générale (exécution de plus de cinq minutes).
create or replace function public.renew_sync_run(p_secret text, p_mode text, p_token uuid, p_ttl_seconds integer default 300)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  update public.sync_state set locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_ttl_seconds, 300), 900))),
    updated_at = now()
  where mode = p_mode and lock_token = p_token and locked_until > now();
  return found;
end;
$$;

-- Travail urgent en attente : lecture locale, sans appel à Buffer. Sert au réveil fréquent du serveur.
create or replace function public.urgent_work_summary(p_secret text, p_mode text, p_orphan_grace_seconds integer default 120)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_pending integer;
  v_since timestamptz;
  v_due timestamptz;
  v_attempted timestamptz;
  v_orphans integer;
  v_state public.sync_state%rowtype;
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  select count(*)::int, min(p.unschedule_since), min(p.due_at), max(p.unschedule_attempted_at)
    into v_pending, v_since, v_due, v_attempted
  from public.posts p
  where p.schedule_state = 'unschedule_pending' and p.removed_at is null
    and (case when p_mode = 'mock' then p.buffer_post_id like 'mock-%' else p.buffer_post_id not like 'mock-%' end);
  select count(*)::int into v_orphans
  from public.posts p
  where p.schedule_state = 'claimed' and p.removed_at is null
    and p.schedule_claimed_at < now() - make_interval(secs => greatest(coalesce(p_orphan_grace_seconds, 120), 30))
    and (case when p_mode = 'mock' then p.buffer_post_id like 'mock-%' else p.buffer_post_id not like 'mock-%' end);
  select * into v_state from public.sync_state where mode = p_mode;
  return jsonb_build_object(
    'pending_unschedule', v_pending, 'oldest_since', v_since, 'earliest_due', v_due, 'last_attempt', v_attempted,
    'orphan_claims', v_orphans,
    'paused_until', case when v_state.backoff_until is not null and v_state.backoff_until > now() then v_state.backoff_until end,
    'urgent_last_run_at', v_state.urgent_last_run_at, 'urgent_last_ok', v_state.urgent_last_ok, 'urgent_last_error', v_state.urgent_last_error
  );
end;
$$;

-- Réservations abandonnées : « claimed » depuis plus longtemps que le délai de grâce. Le processus qui les
-- tenait s'est probablement arrêté ; Buffer a pu programmer le post. Elles sont rapprochées de l'état réel.
create or replace function public.list_orphan_claims_in_mode(p_secret text, p_mode text, p_grace_seconds integer default 120)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text, token uuid, claimed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return query
  select p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service, p.schedule_token, p.schedule_claimed_at
  from public.posts p
  where p.schedule_state = 'claimed' and p.removed_at is null and p.schedule_token is not null
    and p.schedule_claimed_at < now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 120), 30))
    and (case when p_mode = 'mock' then p.buffer_post_id like 'mock-%' else p.buffer_post_id not like 'mock-%' end)
  order by p.due_at nulls last, p.id;
end;
$$;

-- Liste des annulations à confirmer : avec les compteurs, la plus proche de l'échéance d'abord.
drop function if exists public.list_posts_to_unschedule_in_mode(text, text);
create or replace function public.list_posts_to_unschedule_in_mode(p_secret text, p_mode text)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return query
  select p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service
  from public.posts p where (case when p_mode = 'mock' then p.buffer_post_id like 'mock-%' else p.buffer_post_id not like 'mock-%' end)
    and p.schedule_state = 'unschedule_pending' and p.removed_at is null
  order by p.due_at nulls last, p.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. C01 — une notification n'est lisible que si la publication l'est encore
-- ---------------------------------------------------------------------------

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (
    (select private.is_admin())
    or (
      recipient_id = (select auth.uid())
      and (post_id is null or post_id in (select p.id from public.posts p))
    )
  );

-- ---------------------------------------------------------------------------
-- 4. C05 — un changement de rôle retire les accords de l'approbateur devenu inéligible
-- ---------------------------------------------------------------------------

create or replace function private.on_profile_role_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if new.role is distinct from old.role and old.role = 'client' then
    for v_org in select m.organization_id from public.organization_members m where m.user_id = old.id loop
      perform private.revoke_member_approvals(old.id, v_org, 'rôle modifié');
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_revoke_approvals on public.profiles;
create trigger profiles_revoke_approvals after update of role on public.profiles
  for each row execute function private.on_profile_role_changed();

-- ---------------------------------------------------------------------------
-- 5. C02 — identité de la tentative d'envoi Studio, réponses tardives, preuve d'absence
-- ---------------------------------------------------------------------------

alter table public.studio_variants add column if not exists push_attempt_id uuid;
alter table public.studio_variants add column if not exists push_orphans jsonb not null default '[]'::jsonb;

create table if not exists public.studio_push_events (
  id bigint generated always as identity primary key,
  variant_id uuid not null references public.studio_variants (id),
  attempt_id uuid,
  outcome text not null check (outcome in ('applied', 'late_applied', 'orphan', 'ignored')),
  ok boolean not null,
  uncertain boolean not null default false,
  buffer_post_id text,
  revision integer,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists studio_push_events_variant_idx on public.studio_push_events (variant_id, created_at);
alter table public.studio_push_events enable row level security;
revoke all on public.studio_push_events from anon, authenticated;
grant select on public.studio_push_events to authenticated;
drop policy if exists studio_push_events_select on public.studio_push_events;
create policy studio_push_events_select on public.studio_push_events for select to authenticated
  using ((select private.is_admin()));

drop function if exists public.studio_claim_push(uuid, boolean);
create or replace function public.studio_claim_push(p_draft_id uuid, p_force boolean default false)
returns table (
  variant_id uuid, channel_id uuid, buffer_channel_id text, service text, text text, buffer_post_id text, revision integer,
  due_at timestamptz, hashtags text[], media_ids uuid[], organization_id uuid, attempt_id uuid
)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.studio_drafts%rowtype;
  v_kinds jsonb;
begin
  perform private.require_admin();
  select * into v_draft from public.studio_drafts d where d.id = p_draft_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_draft.status = 'archived' then raise exception 'draft_archived'; end if;
  if not exists (select 1 from public.organizations o where o.id = v_draft.organization_id and o.archived_at is null) then
    raise exception 'organization_unavailable';
  end if;
  if v_draft.due_at is null or v_draft.due_at <= now() + interval '15 minutes' then raise exception 'date_invalid'; end if;
  if not exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null) then raise exception 'no_variant'; end if;
  if exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id
             and v.push_state = 'pushing' and v.push_claimed_at > now() - interval '5 minutes') then
    raise exception 'push_in_progress';
  end if;
  -- Aucune nouvelle création, forcée ou non, tant qu'une tentative n'est pas résolue (variantes retirées comprises).
  if exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id
             and (v.push_state = 'unknown' or (v.push_state = 'pushing' and v.push_claimed_at <= now() - interval '5 minutes'))) then
    raise exception 'push_unknown';
  end if;
  if exists (select 1 from public.studio_variants v join public.channels c on c.id = v.channel_id
             where v.draft_id = p_draft_id and v.removed_at is null and c.organization_id is distinct from v_draft.organization_id) then
    raise exception 'invalid_channel';
  end if;

  select coalesce(jsonb_agg(m.kind order by u.ord), '[]'::jsonb) into v_kinds
  from unnest(v_draft.media_ids) with ordinality as u(id, ord)
  join public.media_assets m on m.id = u.id;

  return query
  update public.studio_variants v set push_state = 'pushing', push_claimed_at = now(), push_error = null, updated_at = now(),
    push_attempt_id = gen_random_uuid(),
    push_attempt = jsonb_build_object(
      'text', v.text, 'dueAt', v_draft.due_at, 'hashtags', to_jsonb(v_draft.hashtags), 'revision', v_draft.revision,
      'bufferChannelId', c.buffer_channel_id, 'service', c.service, 'priorBufferPostId', v.buffer_post_id,
      'assetKinds', v_kinds, 'mediaIds', to_jsonb(v_draft.media_ids), 'organizationId', v_draft.organization_id,
      'draftId', v_draft.id, 'claimedAt', now())
  from public.channels c
  where c.id = v.channel_id and v.draft_id = p_draft_id and v.removed_at is null
    and (v.push_state in ('idle', 'failed') or v.pushed_revision is distinct from v_draft.revision)
  returning v.id, v.channel_id, c.buffer_channel_id, c.service, v.text, v.buffer_post_id, v_draft.revision,
            v_draft.due_at, v_draft.hashtags, v_draft.media_ids, v_draft.organization_id, v.push_attempt_id;
end;
$$;

-- Réponses : 'applied' (tentative courante), 'late_applied' (tentative interrompue devenue « inconnue » dont la
-- réponse arrive enfin), 'orphan' (création qui ne correspond à aucune tentative courante : consignée, jamais
-- rattachée à une autre tentative), 'ignored' (échec sans effet).
drop function if exists public.studio_complete_push(uuid, boolean, text, text, integer, boolean);
create or replace function public.studio_complete_push(
  p_variant_id uuid, p_ok boolean, p_buffer_post_id text default null, p_error text default null, p_revision integer default null,
  p_uncertain boolean default false, p_attempt_id uuid default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_variant public.studio_variants%rowtype;
  v_unknown boolean := not coalesce(p_ok, false) and coalesce(p_uncertain, false) and p_buffer_post_id is null;
  v_match boolean;
  v_outcome text;
begin
  perform private.require_admin();
  select * into v_variant from public.studio_variants where id = p_variant_id for update;
  if not found then raise exception 'not_found'; end if;

  -- Sans identifiant (ancien appelant), seule la tentative en cours (« pushing ») peut être complétée. Avec un
  -- identifiant, il doit être celui de la tentative courante : une réponse d'une autre tentative n'est jamais
  -- appliquée à celle-ci.
  v_match := case when p_attempt_id is null then v_variant.push_state = 'pushing'
                  else v_variant.push_attempt_id is not distinct from p_attempt_id end;

  if v_match and v_variant.push_state = 'pushing' then
    update public.studio_variants set
      push_state = case when p_ok then 'pushed' when v_unknown then 'unknown' else 'failed' end,
      buffer_post_id = coalesce(p_buffer_post_id, buffer_post_id),
      push_error = case when p_ok then null else left(coalesce(p_error, 'Erreur inconnue'), 500) end,
      pushed_revision = case when p_ok then p_revision else pushed_revision end,
      pushed_at = case when p_ok then now() else pushed_at end,
      push_unknown_at = case when p_ok then null when v_unknown then now() else push_unknown_at end,
      updated_at = now()
    where id = p_variant_id;
    v_outcome := 'applied';
  elsif v_match and p_attempt_id is not null and v_variant.push_state = 'unknown' and coalesce(p_ok, false) and p_buffer_post_id is not null then
    -- Réponse tardive de la MÊME tentative : le brouillon créé est enfin connu, sans réconciliation.
    update public.studio_variants set push_state = 'pushed', buffer_post_id = p_buffer_post_id, push_error = null,
      pushed_revision = p_revision, pushed_at = now(), push_unknown_at = null, updated_at = now()
    where id = p_variant_id;
    v_outcome := 'late_applied';
  elsif coalesce(p_ok, false) and p_buffer_post_id is not null and p_buffer_post_id is distinct from v_variant.buffer_post_id then
    -- Un brouillon a été créé par une tentative qui n'est plus la courante : il existe dans Buffer, sans lien.
    update public.studio_variants set push_orphans = push_orphans || to_jsonb(p_buffer_post_id), updated_at = now()
    where id = p_variant_id and not push_orphans ? p_buffer_post_id;
    v_outcome := 'orphan';
  else
    v_outcome := 'ignored';
  end if;

  insert into public.studio_push_events (variant_id, attempt_id, outcome, ok, uncertain, buffer_post_id, revision, error)
  values (p_variant_id, p_attempt_id, v_outcome, coalesce(p_ok, false), coalesce(p_uncertain, false), p_buffer_post_id, p_revision, left(p_error, 500));

  if v_outcome in ('applied', 'late_applied')
     and not exists (select 1 from public.studio_variants where draft_id = v_variant.draft_id and removed_at is null and push_state <> 'pushed') then
    update public.studio_drafts set status = 'submitted', submitted_at = coalesce(submitted_at, now())
    where id = v_variant.draft_id and status <> 'archived';
  end if;
  return v_outcome;
end;
$$;

-- Résolution d'un envoi inconnu : adoption (brouillon retrouvé) ou absence confirmée par une personne, avec une
-- PREUVE consignée (ce qui a été vérifié et où). Jamais une absence prouvée par l'API.
drop function if exists public.studio_resolve_unknown(uuid, text, boolean, boolean);
create or replace function public.studio_resolve_unknown(
  p_variant_id uuid, p_buffer_post_id text default null, p_confirmed_absent boolean default false, p_operator_confirmed boolean default false,
  p_evidence text default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_variant public.studio_variants%rowtype;
begin
  perform private.require_admin();
  select * into v_variant from public.studio_variants where id = p_variant_id for update;
  if not found or v_variant.push_state <> 'unknown' then raise exception 'not_found'; end if;

  if p_buffer_post_id is not null then
    if exists (select 1 from public.studio_variants v where v.buffer_post_id = p_buffer_post_id and v.id <> p_variant_id)
       or exists (select 1 from public.studio_variants v where v.id <> p_variant_id and v.push_orphans ? p_buffer_post_id) then
      raise exception 'buffer_post_taken';
    end if;
    if exists (select 1 from public.posts p where p.buffer_post_id = p_buffer_post_id and p.buffer_status in ('sent', 'sending')) then
      raise exception 'post_already_published';
    end if;
    update public.studio_variants set
      buffer_post_id = p_buffer_post_id, push_state = 'failed', push_error = 'Brouillon retrouvé dans Buffer : renvoyez pour le mettre à jour.',
      pushed_revision = null, push_unknown_at = null, updated_at = now(),
      push_attempt = coalesce(push_attempt, '{}'::jsonb) || jsonb_build_object(
        'adoptedBufferPostId', p_buffer_post_id, 'adoptedBy', (select auth.uid()), 'adoptedAt', now(),
        'adoptionConfirmedByOperator', coalesce(p_operator_confirmed, false))
    where id = p_variant_id;
    return 'adopted';
  end if;

  if coalesce(p_confirmed_absent, false) then
    if v_variant.push_unknown_at is not null and v_variant.push_unknown_at > now() - interval '10 minutes' then
      raise exception 'unknown_too_recent';
    end if;
    if not coalesce(p_operator_confirmed, false) then raise exception 'absence_requires_operator'; end if;
    if p_evidence is null or length(btrim(p_evidence)) < 10 then raise exception 'evidence_required'; end if;
    update public.studio_variants set push_state = 'failed',
      push_error = 'Absence du brouillon confirmée manuellement dans Buffer : renvoi possible, avec risque résiduel de doublon.',
      push_unknown_at = null, updated_at = now(),
      push_attempt = coalesce(push_attempt, '{}'::jsonb) || jsonb_build_object(
        'absenceConfirmedBy', (select auth.uid()), 'absenceConfirmedAt', now(), 'absenceEvidence', left(btrim(p_evidence), 500),
        'attemptId', push_attempt_id)
    where id = p_variant_id;
    return 'retry_allowed';
  end if;
  return 'unchanged';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b. C08 — une pause posée par un REFUS de Buffer (429) se distingue d'une pause préventive
-- ---------------------------------------------------------------------------
-- Une compensation ne contourne jamais un refus : si Buffer a répondu 429, aucune requête (même d'annulation)
-- n'est tentée avant l'échéance demandée. Une pause préventive (quota presque épuisé) laisse passer les
-- compensations, qui ont priorité sur toute nouvelle programmation.

alter table public.sync_state add column if not exists backoff_hard boolean not null default false;

create or replace function public.set_sync_backoff(p_secret text, p_mode text, p_seconds integer, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  insert into public.sync_state (mode) values (p_mode) on conflict (mode) do nothing;
  -- Jamais réduite : la plus longue des pauses l'emporte. 30 jours : la plus longue fenêtre de quota de Buffer.
  update public.sync_state set
    backoff_until = greatest(coalesce(backoff_until, now()), now() + make_interval(secs => greatest(1, least(coalesce(p_seconds, 0), 2592000)))),
    backoff_reason = left(coalesce(p_reason, 'Quota de requêtes Buffer atteint.'), 300),
    backoff_set_at = now(),
    backoff_hard = true,
    updated_at = now()
  where mode = p_mode;
end;
$$;

create or replace function public.get_sync_pause(p_secret text, p_mode text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_state public.sync_state%rowtype;
begin
  perform private.check_secret(p_secret);
  select * into v_state from public.sync_state where mode = p_mode;
  if not found or v_state.backoff_until is null or v_state.backoff_until <= now() then return null; end if;
  return jsonb_build_object('until', v_state.backoff_until, 'reason', v_state.backoff_reason, 'hard', v_state.backoff_hard);
end;
$$;

drop function if exists public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb);
create or replace function public.finish_sync_run(
  p_secret text, p_mode text, p_token uuid, p_ok boolean, p_error text default null,
  p_backoff_seconds integer default 0, p_backoff_reason text default null, p_anomalies jsonb default '[]'::jsonb,
  p_backoff_hard boolean default false
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_new timestamptz := case when coalesce(p_backoff_seconds, 0) > 0
    then now() + make_interval(secs => least(p_backoff_seconds, 2592000)) end;
begin
  perform private.check_secret(p_secret);
  update public.sync_state set
    lock_token = null,
    locked_until = null,
    last_finished_at = now(),
    last_success_at = case when p_ok then now() else last_success_at end,
    last_failure_at = case when p_ok then last_failure_at else now() end,
    last_error = case when p_ok then last_error else left(coalesce(p_error, 'Erreur inconnue'), 1000) end,
    consecutive_failures = case when p_ok then 0 else consecutive_failures + 1 end,
    -- Une pause plus longue déjà en place n'est jamais raccourcie ; une pause posée PENDANT cette exécution (autre
    -- action isolée) est conservée. Une exécution réussie lève seulement une pause antérieure à son début.
    backoff_reason = case
      when v_new is not null and (backoff_until is null or backoff_until <= v_new) then left(p_backoff_reason, 300)
      when backoff_until is not null and backoff_until > now() and (v_new is not null or backoff_set_at >= last_started_at) then backoff_reason
      end,
    backoff_hard = case
      when v_new is not null and (backoff_until is null or backoff_until <= v_new) then coalesce(p_backoff_hard, false) or (backoff_hard and backoff_until > now())
      when backoff_until is not null and backoff_until > now() and (v_new is not null or backoff_set_at >= last_started_at) then backoff_hard
      else false end,
    backoff_until = case
      when v_new is not null and backoff_until is not null and backoff_until > v_new then backoff_until
      when v_new is not null then v_new
      when backoff_until is not null and backoff_until > now() and backoff_set_at >= last_started_at then backoff_until
      end,
    backoff_set_at = case
      when v_new is not null and (backoff_until is null or backoff_until <= v_new) then now()
      else backoff_set_at end,
    anomalies = case when jsonb_typeof(p_anomalies) = 'array' then p_anomalies else '[]'::jsonb end,
    updated_at = now()
  where mode = p_mode and lock_token = p_token;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5c. C04 — revalidation de l'éligibilité JUSTE avant la remise
-- ---------------------------------------------------------------------------
-- 'verify' : parmi les notifications réservées (« sending »), celles qui ne sont plus légitimes sont annulées ; la
-- fonction renvoie le nombre de celles qui le restent. Le serveur l'appelle immédiatement avant l'appel au
-- prestataire : un lot réservé n'est jamais considéré comme définitivement autorisé.
create or replace function public.complete_notifications(p_secret text, p_ids uuid[], p_status text, p_error text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.check_secret(p_secret);
  if p_status is null or p_status not in ('sent', 'simulated', 'failed', 'released', 'verify') then raise exception 'invalid_status'; end if;
  if p_status = 'verify' then
    update public.notifications n set status = 'cancelled', error = 'Destinataire ou publication plus éligible juste avant la remise.'
    where n.id = any (p_ids) and n.status = 'sending' and not private.notification_is_eligible(n.id);
    select count(*)::int into v_count from public.notifications n where n.id = any (p_ids) and n.status = 'sending';
    return v_count;
  end if;
  if p_status = 'released' then
    update public.notifications set status = 'pending', attempts = greatest(attempts - 1, 0), claimed_at = null
    where id = any (p_ids) and status = 'sending';
  else
    update public.notifications set
      status = p_status,
      error = case when p_status = 'failed' then left(coalesce(p_error, 'Erreur inconnue'), 500) end,
      sent_at = case when p_status = 'failed' then null else now() end
    where id = any (p_ids) and status = 'sending';
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5d. C11 — état du schéma pour le contrôle de préparation (jamais de détail de schéma côté public)
-- ---------------------------------------------------------------------------
-- Réservé au secret d'automatisation : l'application l'appelle pour savoir si les migrations REQUISES sont en place
-- avant d'annoncer qu'elle est prête. Elle ne renvoie que des booléens par migration.
create or replace function public.schema_status(p_secret text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_checks jsonb;
begin
  perform private.check_secret(p_secret);
  v_checks := jsonb_build_object(
    '0006', to_regprocedure('public.begin_sync_run(text, text, text, boolean, integer)') is not null,
    '0007', to_regclass('public.notifications') is not null,
    '0008', to_regclass('public.studio_drafts') is not null,
    '0009', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'posts' and column_name = 'schedule_token'),
    '0010', to_regclass('public.channel_owner_history') is not null,
    '0011', to_regclass('public.studio_push_events') is not null
            and to_regprocedure('public.begin_urgent_run(text, text, integer)') is not null
  );
  return jsonb_build_object('checks', v_checks, 'ready', not exists (select 1 from jsonb_each(v_checks) c where c.value = 'false'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Droits
-- ---------------------------------------------------------------------------

revoke execute on function
  private.track_unschedule(),
  private.on_profile_role_changed()
from public, anon, authenticated;

revoke execute on function
  public.complete_unscheduling(text, uuid, boolean, text, text),
  public.list_posts_to_unschedule_in_mode(text, text),
  public.mark_unschedule_needed(text, uuid, text),
  public.complete_scheduling(text, uuid, boolean, text, uuid, boolean),
  public.begin_urgent_run(text, text, integer),
  public.renew_urgent_run(text, text, uuid, integer),
  public.finish_urgent_run(text, text, uuid, boolean, text, integer),
  public.renew_sync_run(text, text, uuid, integer),
  public.set_sync_backoff(text, text, integer, text),
  public.get_sync_pause(text, text),
  public.complete_notifications(text, uuid[], text, text),
  public.schema_status(text),
  public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb, boolean),
  public.urgent_work_summary(text, text, integer),
  public.list_orphan_claims_in_mode(text, text, integer)
from public;
grant execute on function
  public.complete_unscheduling(text, uuid, boolean, text, text),
  public.list_posts_to_unschedule_in_mode(text, text),
  public.mark_unschedule_needed(text, uuid, text),
  public.complete_scheduling(text, uuid, boolean, text, uuid, boolean),
  public.begin_urgent_run(text, text, integer),
  public.renew_urgent_run(text, text, uuid, integer),
  public.finish_urgent_run(text, text, uuid, boolean, text, integer),
  public.renew_sync_run(text, text, uuid, integer),
  public.set_sync_backoff(text, text, integer, text),
  public.get_sync_pause(text, text),
  public.complete_notifications(text, uuid[], text, text),
  public.schema_status(text),
  public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb, boolean),
  public.urgent_work_summary(text, text, integer),
  public.list_orphan_claims_in_mode(text, text, integer)
to anon, authenticated;

revoke execute on function
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer, boolean, uuid),
  public.studio_resolve_unknown(uuid, text, boolean, boolean, text)
from public, anon;
grant execute on function
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer, boolean, uuid),
  public.studio_resolve_unknown(uuid, text, boolean, boolean, text)
to authenticated;

commit;
