-- Cadence — fiabilité de la validation et de la programmation
-- Appliqué au projet « socialflow-dev » le 8 octobre 2026.

-- 1. Une approbation n'a de sens que si la publication peut encore être programmée :
--    refus si la date prévue est absente ou dépassée. La demande de modifications reste possible.
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

-- 2. Programmation : après cinq échecs rapprochés, on ne renonce plus définitivement.
--    Une nouvelle tentative a lieu au plus une fois par heure (panne Buffer prolongée, quota atteint).
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
        or (c.schedule_state = 'failed' and (c.schedule_attempts < 5 or c.schedule_claimed_at < now() - interval '1 hour'))
        or (c.schedule_state = 'claimed' and c.schedule_claimed_at < now() - interval '10 minutes')
      )
    order by c.due_at
    limit p_limit
    for update skip locked
  )
  returning p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service, p.version;
end;
$$;

-- 3. Historique : un client ne lit plus, même en interrogeant l'API directement,
--    les événements techniques (échecs de programmation, erreurs Buffer) ni leur détail.
alter policy post_events_select on public.post_events
  using (
    post_id in (select p.id from public.posts p)
    and (
      (select private.is_admin())
      or type in ('submitted', 'resubmitted', 'approved', 'changes_requested', 'commented', 'approval_invalidated', 'scheduled', 'published')
    )
  );
