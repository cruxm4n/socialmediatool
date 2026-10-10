-- Cadence — retour arrière de la migration 0009 (stabilisation)
-- NE PAS exécuter à la légère : revenir avant 0009 RÉOUVRE les défauts corrigés par l'audit du 9 octobre 2026
-- (approbation exploitable après transfert, imports tardifs visibles du nouveau client, confirmations de
-- programmation sans jeton, notifications sans revalidation, renvoi après résultat Buffer inconnu).
-- Aucune donnée n'est supprimée : les colonnes ajoutées par 0009 restent en place (inoffensives), seules les
-- fonctions et règles d'avant sont rétablies. Les envois Studio à l'état « unknown » doivent être résolus à la
-- main avant de revenir en arrière (ils ne seraient plus reconnus par les anciennes fonctions).
-- 0009 peut être rejouée ensuite.
begin;

-- Objets créés par 0009
drop trigger if exists post_versions_immutable on public.post_versions;
drop function if exists private.post_versions_immutable();
drop function if exists public.admin_set_post_owner(uuid[], uuid);
drop function if exists public.studio_resolve_unknown(uuid, text, boolean);
drop function if exists public.set_sync_backoff(text, text, integer, text);
drop function if exists public.complete_scheduling(text, uuid, boolean, text, uuid);
drop function if exists public.complete_unscheduling(text, uuid, boolean, text, text);
drop function if exists public.claim_posts_for_scheduling(text, uuid, integer);
drop function if exists public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer);
drop function if exists public.studio_claim_push(uuid, boolean);
drop function if exists public.studio_complete_push(uuid, boolean, text, text, integer, boolean);
drop function if exists private.suspend_posts(uuid, uuid, text, uuid[]);
drop function if exists private.can_decide_post(uuid, text, uuid);
drop function if exists private.is_post_reviewable(uuid, text, uuid);
drop function if exists private.resolve_post_owner(uuid, text);

-- Règle de visibilité d'avant (propriétaire actuel du canal + date de transfert)
alter policy posts_select on public.posts
  using (
    (select private.is_admin())
    or (
      approval_status <> 'none'
      and removed_at is null
      and private.can_review_post(channel_id, created_at)
    )
  );

-- claim_posts_for_scheduling_in_mode (0003)
create or replace function public.claim_posts_for_scheduling_in_mode(p_secret text, p_mode text, p_post_id uuid default null, p_limit integer default 10)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text, version integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return query
  update public.posts p set
    schedule_state = 'claimed', schedule_claimed_at = now(), schedule_attempts = p.schedule_attempts + 1
  where p.id in (
    select c.id from public.posts c
    where (case when p_mode = 'mock' then c.buffer_post_id like 'mock-%' else c.buffer_post_id not like 'mock-%' end)
      and c.approval_status = 'approved'
      and c.approved_hash = c.content_hash
      and c.buffer_status = 'draft'
      and c.removed_at is null
      and c.due_at > now() + interval '2 minutes'
      and (p_post_id is null or c.id = p_post_id)
      and (
        c.schedule_state = 'idle'
        or (c.schedule_state = 'failed' and (c.schedule_attempts < 5 or c.schedule_claimed_at < now() - interval '1 hour'))
        or (c.schedule_state = 'claimed' and c.schedule_claimed_at < now() - interval '10 minutes')
      )
    order by c.due_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  )
  returning p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service, p.version;
end;
$$;

-- claim_posts_for_scheduling (0003)
create or replace function public.claim_posts_for_scheduling(p_secret text, p_post_id uuid default null, p_limit integer default 10)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text, version integer)
language sql security definer set search_path = '' as $$
  select * from public.claim_posts_for_scheduling_in_mode(p_secret, 'real', p_post_id, p_limit);
$$;

-- complete_scheduling (0001)
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

-- complete_unscheduling (0001)
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

-- sync_buffer_posts (0004)
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
  v_complete boolean := coalesce((p_payload ->> 'complete')::boolean, false);
  v_confirmed_gone text[] := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_payload -> 'confirmedGone', '[]'::jsonb))), '{}');
  v_unresolved jsonb := '[]'::jsonb;
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
      elsif v_approval = 'approved' and not v_tag then
        -- Tag retiré après la validation, avant la programmation : le post est retiré du circuit.
        -- Sans cela il resterait « approuvé » et sa programmation échouerait à chaque synchronisation.
        v_approval := 'none';
        v_sched := 'idle';
        v_attempts := 0;
        v_invalidated := v_invalidated + 1;
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
  -- Exception : un post programmé dont la date est passée a très probablement été publié, mais il peut
  -- être sorti de la liste des derniers posts publiés lue dans Buffer. On ne conclut rien : son identifiant
  -- est renvoyé dans « unresolved », l'appelant le relit un par un puis confirme les vraies disparitions
  -- dans « confirmedGone ».
  with gone as (
    update public.posts set removed_at = now()
    where removed_at is null
      and buffer_status <> 'sent'
      and (buffer_post_id like 'mock-%') = v_is_mock
      and not (buffer_post_id = any (v_seen))
      and (
        buffer_post_id = any (v_confirmed_gone)
        or (v_complete and not (buffer_status in ('scheduled', 'sending') and due_at is not null and due_at <= now()))
      )
    returning id, version
  ), logged as (
    insert into public.post_events (post_id, type, version)
    select id, 'removed', version from gone
    returning 1
  )
  select count(*) into v_removed from logged;

  if v_complete then
    select coalesce(jsonb_agg(s.buffer_post_id), '[]'::jsonb) into v_unresolved from (
      select p.buffer_post_id from public.posts p
      where p.removed_at is null
        and p.buffer_status in ('scheduled', 'sending')
        and p.due_at is not null and p.due_at <= now()
        and (p.buffer_post_id like 'mock-%') = v_is_mock
        and not (p.buffer_post_id = any (v_seen))
        and not (p.buffer_post_id = any (v_confirmed_gone))
      order by p.due_at
      limit 25
    ) s;
  end if;

  insert into public.sync_runs (mode, status, triggered_by, fetched, created, updated, invalidated, removed, rate_limit)
  values (v_mode, 'success', coalesce(p_payload ->> 'triggeredBy', 'manual'), v_fetched, v_created, v_updated, v_invalidated, v_removed, p_payload -> 'rateLimit');

  return jsonb_build_object('fetched', v_fetched, 'created', v_created, 'updated', v_updated, 'invalidated', v_invalidated, 'removed', v_removed, 'unresolved', v_unresolved);
end;
$$;

-- decide_post (0005)
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

  select * into v_post from public.posts where id = p_post_id for update;

  if not found or v_post.removed_at is not null or v_post.approval_status = 'none' or not private.can_review_post(v_post.channel_id, v_post.created_at) then
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
  if p_decision = 'approved' and (v_post.due_at is null or v_post.due_at <= now()) then
    raise exception 'date_invalid';
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

-- add_comment (0005)
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
      v_post.approval_status <> 'none' and v_post.removed_at is null and private.can_review_post(v_post.channel_id, v_post.created_at)
    )
  ) then
    raise exception 'not_found';
  end if;
  insert into public.comments (post_id, author_id, body, version) values (v_post.id, v_uid, trim(p_body), v_post.version);
  perform private.add_event(v_post.id, 'commented', v_uid, null, v_post.version);
end;
$$;

-- admin_assign_channel (0005)
create or replace function public.admin_assign_channel(p_channel_id uuid, p_organization_id uuid, p_confirm_transfer boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_channel public.channels%rowtype;
  v_previous uuid;
  v_history integer;
  v_transfer boolean;
begin
  perform private.require_admin();
  select * into v_channel from public.channels where id = p_channel_id for update;
  if not found then raise exception 'not_found'; end if;
  v_previous := coalesce(v_channel.organization_id, v_channel.last_organization_id);

  if p_organization_id is null then
    update public.channels set organization_id = null, last_organization_id = v_previous where id = p_channel_id;
    return jsonb_build_object('transferred', false, 'hidden_posts', 0);
  end if;

  if not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;

  select count(*) into v_history from public.posts where channel_id = p_channel_id;
  v_transfer := v_previous is not null and v_previous <> p_organization_id and v_history > 0;
  if v_transfer and not coalesce(p_confirm_transfer, false) then
    raise exception 'transfer_confirmation_required';
  end if;

  update public.channels set
    organization_id = p_organization_id,
    last_organization_id = p_organization_id,
    visible_from = case when v_transfer then now() else visible_from end
  where id = p_channel_id;
  return jsonb_build_object('transferred', v_transfer, 'hidden_posts', case when v_transfer then v_history else 0 end);
end;
$$;

-- admin_set_organization_archived (0005)
create or replace function public.admin_set_organization_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.organizations set archived_at = case when p_archived then coalesce(archived_at, now()) end where id = p_id;
  if not found then raise exception 'not_found'; end if;
end;
$$;

-- record_post_version (0008)
create or replace function private.record_post_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.post_versions (post_id, version, text, due_at, assets, content_hash)
  values (new.id, new.version, new.text, new.due_at, new.assets, new.content_hash)
  on conflict (post_id, version) do update set
    text = excluded.text, due_at = excluded.due_at, assets = excluded.assets, content_hash = excluded.content_hash
  where public.post_versions.content_hash <> excluded.content_hash;
  return new;
exception when others then
  raise warning 'version non enregistrée : %', sqlerrm;
  return new;
end;
$$;

-- enqueue_notifications (0007)
create or replace function private.enqueue_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_post public.posts%rowtype;
  v_channel public.channels%rowtype;
  v_mode text;
  v_detail text;
begin
  v_kind := case
    when new.type in ('submitted', 'resubmitted', 'approval_invalidated', 'unscheduled_in_buffer') then 'review_requested'
    when new.type = 'changes_requested' then 'changes_requested'
    when new.type = 'approved' then 'approved'
    when new.type in ('schedule_failed', 'failed') then 'schedule_error'
  end;
  if v_kind is null then return new; end if;

  select * into v_post from public.posts where id = new.post_id;
  if not found then return new; end if;
  select * into v_channel from public.channels where id = v_post.channel_id;
  v_mode := case when v_post.buffer_post_id like 'mock-%' then 'mock' else 'real' end;

  if v_kind = 'review_requested' then
    -- L'événement est écrit avant que le statut de la publication soit mis à jour : on ne peut pas
    -- vérifier ici qu'elle attend une décision. Ce contrôle a lieu à la remise (claim_notifications).
    -- Mêmes règles que la visibilité : membres du client du canal, client actif, publication postérieure au transfert.
    insert into public.notifications (kind, mode, recipient_id, post_id, organization_id, post_version, dedupe_key)
    select v_kind, v_mode, m.user_id, v_post.id, o.id, new.version, v_kind || ':' || v_post.id || ':' || new.version || ':' || m.user_id
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id and o.archived_at is null
    join public.profiles pr on pr.id = m.user_id and pr.role = 'client'
    left join public.notification_preferences np on np.user_id = m.user_id
    where m.organization_id = v_channel.organization_id
      and (v_channel.visible_from is null or v_post.created_at >= v_channel.visible_from)
      and coalesce(np.review_requested, true)
    on conflict (dedupe_key) do nothing;
    return new;
  end if;

  v_detail := case
    when v_kind = 'changes_requested' then (
      select left(c.body, 500) from public.comments c
      where c.post_id = v_post.id and c.kind = 'change_request' order by c.created_at desc limit 1)
    when v_kind = 'schedule_error' then left(coalesce(new.detail, v_post.schedule_error, v_post.buffer_error), 500)
  end;

  insert into public.notifications (kind, mode, recipient_id, post_id, organization_id, post_version, dedupe_key, detail)
  select v_kind, v_mode, pr.id, v_post.id, v_channel.organization_id, new.version,
         v_kind || ':' || v_post.id || ':' || new.version || ':' || pr.id, v_detail
  from public.profiles pr
  left join public.notification_preferences np on np.user_id = pr.id
  where pr.role = 'admin'
    and case v_kind
      when 'changes_requested' then coalesce(np.changes_requested, true)
      when 'approved' then coalesce(np.approved, false)
      else coalesce(np.schedule_error, true)
    end
  on conflict (dedupe_key) do nothing;
  return new;
exception when others then
  -- Une notification qui échoue ne doit jamais empêcher une validation ou une synchronisation.
  raise warning 'notification non créée : %', sqlerrm;
  return new;
end;
$$;

-- claim_notifications (0007)
create or replace function public.claim_notifications(p_secret text, p_mode text, p_limit integer default 50)
returns table (
  id uuid, kind text, recipient_id uuid, recipient_name text, recipient_email text,
  organization_name text, organization_slug text, timezone text,
  post_id uuid, post_text text, service text, due_at timestamptz, detail text, created_at timestamptz
) language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  -- Une demande de validation n'a plus lieu d'être si la publication n'attend plus de décision
  -- (déjà validée, retirée, supprimée) : elle est annulée plutôt qu'envoyée.
  update public.notifications n set status = 'cancelled'
  where n.mode = p_mode and n.status = 'pending' and n.kind = 'review_requested'
    and not exists (
      select 1 from public.posts p
      where p.id = n.post_id and p.approval_status = 'pending' and p.removed_at is null
    );

  return query
  with claimed as (
    update public.notifications n set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
    where n.id in (
      select q.id from public.notifications q
      where q.mode = p_mode and (
        q.status = 'pending'
        or (q.status = 'failed' and q.attempts < 5 and q.claimed_at < now() - interval '15 minutes')
        or (q.status = 'sending' and q.claimed_at < now() - interval '10 minutes')
      )
      order by q.created_at
      limit greatest(1, least(coalesce(p_limit, 50), 200))
      for update skip locked
    )
    returning n.*
  )
  select c.id, c.kind, c.recipient_id, pr.full_name, u.email::text,
         o.name, o.slug, coalesce(o.timezone, 'Europe/Paris'),
         c.post_id, left(p.text, 200), p.service, p.due_at, c.detail, c.created_at
  from claimed c
  join public.profiles pr on pr.id = c.recipient_id
  join public.posts p on p.id = c.post_id
  left join auth.users u on u.id = c.recipient_id
  left join public.organizations o on o.id = c.organization_id
  order by c.created_at;
end;
$$;

-- studio_claim_push (0008)
create or replace function public.studio_claim_push(p_draft_id uuid, p_force boolean default false)
returns table (variant_id uuid, channel_id uuid, buffer_channel_id text, service text, text text, buffer_post_id text, revision integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.studio_drafts%rowtype;
begin
  perform private.require_admin();
  select * into v_draft from public.studio_drafts d where d.id = p_draft_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_draft.status = 'archived' then raise exception 'draft_archived'; end if;
  if v_draft.due_at is null or v_draft.due_at <= now() + interval '5 minutes' then raise exception 'date_invalid'; end if;
  if not exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null) then raise exception 'no_variant'; end if;
  if exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null
             and v.push_state = 'pushing' and v.push_claimed_at > now() - interval '5 minutes') then
    raise exception 'push_in_progress';
  end if;
  if not coalesce(p_force, false) and exists (
    select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null and v.push_state = 'pushing') then
    raise exception 'push_uncertain';
  end if;
  -- Canal détaché ou transféré depuis la préparation : rien ne part vers le canal d'un autre client.
  if exists (select 1 from public.studio_variants v join public.channels c on c.id = v.channel_id
             where v.draft_id = p_draft_id and v.removed_at is null and c.organization_id is distinct from v_draft.organization_id) then
    raise exception 'invalid_channel';
  end if;

  return query
  update public.studio_variants v set push_state = 'pushing', push_claimed_at = now(), push_error = null, updated_at = now()
  from public.channels c
  where c.id = v.channel_id and v.draft_id = p_draft_id and v.removed_at is null
    and (v.push_state in ('idle', 'failed', 'pushing') or v.pushed_revision is distinct from v_draft.revision)
  returning v.id, v.channel_id, c.buffer_channel_id, c.service, v.text, v.buffer_post_id, v_draft.revision;
end;
$$;

-- studio_complete_push (0008)
create or replace function public.studio_complete_push(
  p_variant_id uuid, p_ok boolean, p_buffer_post_id text default null, p_error text default null, p_revision integer default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_draft uuid;
begin
  perform private.require_admin();
  update public.studio_variants set
    push_state = case when p_ok then 'pushed' else 'failed' end,
    -- L'identifiant Buffer est gardé même en cas d'échec ultérieur : le brouillon existe, il ne faut pas le recréer.
    buffer_post_id = coalesce(p_buffer_post_id, buffer_post_id),
    push_error = case when p_ok then null else left(coalesce(p_error, 'Erreur inconnue'), 500) end,
    pushed_revision = case when p_ok then p_revision else pushed_revision end,
    pushed_at = case when p_ok then now() else pushed_at end,
    updated_at = now()
  where id = p_variant_id and push_state = 'pushing'
  returning draft_id into v_draft;
  if not found then raise exception 'not_found'; end if;

  if not exists (select 1 from public.studio_variants where draft_id = v_draft and removed_at is null and push_state <> 'pushed') then
    update public.studio_drafts set status = 'submitted', submitted_at = coalesce(submitted_at, now())
    where id = v_draft and status <> 'archived';
  end if;
end;
$$;

-- Droits d'exécution d'avant
revoke execute on function
  public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer),
  public.claim_posts_for_scheduling(text, uuid, integer),
  public.complete_scheduling(text, uuid, boolean, text),
  public.complete_unscheduling(text, uuid, boolean, text)
from public;
grant execute on function
  public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer),
  public.claim_posts_for_scheduling(text, uuid, integer),
  public.complete_scheduling(text, uuid, boolean, text),
  public.complete_unscheduling(text, uuid, boolean, text)
to anon, authenticated;
revoke execute on function
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer)
from public, anon;
grant execute on function
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer)
to authenticated;
revoke execute on function private.record_post_version() from public, anon, authenticated;

commit;
