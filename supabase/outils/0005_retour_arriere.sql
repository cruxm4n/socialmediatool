-- Retour arrière de la migration 0005 : remet les règles d'accès et les fonctions d'avant.
-- À n'utiliser que si 0005 pose problème. Aucune donnée n'est supprimée : les colonnes ajoutées
-- (archived_at, last_organization_id, visible_from) restent en place, simplement ignorées.
-- ATTENTION : après ce retour arrière, un client archivé retrouve l'accès à son espace, et un canal
-- transféré montre de nouveau tout son historique au client actuel. Détachez d'abord ces canaux.
begin;

create or replace function private.my_org_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select organization_id from public.organization_members where user_id = (select auth.uid());
$$;

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

alter policy posts_select on public.posts
  using (
    (select private.is_admin())
    or (
      approval_status <> 'none'
      and removed_at is null
      and channel_id in (select c.id from public.channels c where c.organization_id in (select private.my_org_ids()))
    )
  );

drop function if exists public.admin_save_organization(uuid, text, text, text, text, text, text);
drop function if exists public.admin_set_organization_archived(uuid, boolean);
drop function if exists public.admin_assign_channel(uuid, uuid, boolean);
drop function if exists public.admin_set_member(uuid, uuid, boolean);
drop function if exists public.admin_add_user(uuid, text, text, text);
drop function if exists public.admin_list_user_emails();
drop function if exists private.can_review_post(uuid, timestamptz);
drop function if exists private.require_admin();

grant update (organization_id) on public.channels to authenticated;
drop policy if exists channels_assign on public.channels;
create policy channels_assign on public.channels for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

commit;
