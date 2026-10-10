-- Cadence — gestion des clients, des canaux et des accès (9 octobre 2026)
-- Vérifiée sur une base PostgreSQL locale en mémoire (npm run test), NON appliquée à Supabase.
-- À appliquer après 0004. Ajoute trois colonnes et des fonctions réservées à l'administrateur.
-- Aucune donnée existante n'est modifiée ni supprimée.
begin;

-- ---------------------------------------------------------------------------
-- 1. Colonnes
-- ---------------------------------------------------------------------------

-- Un client archivé n'est pas supprimé : il disparaît des listes et ses membres perdent l'accès.
alter table public.organizations add column if not exists archived_at timestamptz;

-- Dernier client auquel le canal a appartenu (conservé quand le canal est détaché).
alter table public.channels add column if not exists last_organization_id uuid references public.organizations (id) on delete set null;
-- Après un transfert à un autre client : seules les publications apparues depuis cette date
-- sont visibles du nouveau client. Les publications, commentaires et décisions de l'ancien
-- client restent invisibles pour lui. L'administrateur voit toujours tout.
alter table public.channels add column if not exists visible_from timestamptz;
create index if not exists channels_last_organization_idx on public.channels (last_organization_id);

-- ---------------------------------------------------------------------------
-- 2. Visibilité côté client
-- ---------------------------------------------------------------------------

-- Les organisations archivées ne donnent plus aucun accès à leurs membres.
create or replace function private.my_org_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.organization_id
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid()) and o.archived_at is null;
$$;

-- Règle unique : l'utilisateur connecté peut-il voir et valider une publication de ce canal ?
create or replace function private.can_review_post(p_channel_id uuid, p_created_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.channels c
    where c.id = p_channel_id
      and c.organization_id in (select private.my_org_ids())
      and (c.visible_from is null or p_created_at >= c.visible_from)
  );
$$;
revoke execute on function private.can_review_post(uuid, timestamptz) from public, anon;
grant execute on function private.can_review_post(uuid, timestamptz) to authenticated;

alter policy posts_select on public.posts
  using (
    (select private.is_admin())
    or (
      approval_status <> 'none'
      and removed_at is null
      and private.can_review_post(channel_id, created_at)
    )
  );

-- Les fonctions de décision et de commentaire appliquent la même règle.
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

-- ---------------------------------------------------------------------------
-- 3. Administration : toutes les écritures passent par ces fonctions
-- ---------------------------------------------------------------------------

create or replace function private.require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not private.is_admin() then raise exception 'forbidden'; end if;
end;
$$;

-- Crée (p_id null) ou modifie un client. L'adresse (slug) est fixée à la création.
create or replace function public.admin_save_organization(
  p_id uuid, p_name text, p_slug text, p_sector text, p_timezone text, p_initials text, p_color text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_slug text := p_slug;
  v_n integer := 1;
  v_id uuid;
begin
  perform private.require_admin();
  if length(v_name) = 0 or length(v_name) > 80 then raise exception 'invalid_name'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then raise exception 'invalid_timezone'; end if;
  if p_color is null or p_color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'invalid_color'; end if;
  if p_initials is null or length(trim(p_initials)) not between 1 and 3 then raise exception 'invalid_initials'; end if;
  if exists (select 1 from public.organizations where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'name_taken';
  end if;

  if p_id is not null then
    update public.organizations set
      name = v_name, sector = trim(coalesce(p_sector, '')), timezone = p_timezone, initials = upper(trim(p_initials)), color = p_color
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
    return v_id;
  end if;

  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 60 then raise exception 'invalid_slug'; end if;
  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := p_slug || '-' || v_n;
  end loop;
  insert into public.organizations (slug, name, sector, timezone, initials, color)
  values (v_slug, v_name, trim(coalesce(p_sector, '')), p_timezone, upper(trim(p_initials)), p_color)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.admin_set_organization_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.organizations set archived_at = case when p_archived then coalesce(archived_at, now()) end where id = p_id;
  if not found then raise exception 'not_found'; end if;
end;
$$;

-- Rattache, détache ou transfère un canal. Un canal n'appartient qu'à un client à la fois.
-- Transfert = le canal a déjà appartenu à un autre client et porte des publications : il exige
-- une confirmation explicite, et l'historique antérieur reste invisible du nouveau client.
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

-- Associe ou dissocie un utilisateur client et une organisation.
-- Seule exception à la règle « aucune suppression » : un droit d'accès retiré doit réellement disparaître.
create or replace function public.admin_set_member(p_organization_id uuid, p_user_id uuid, p_member boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if not exists (select 1 from public.organizations where id = p_organization_id) then raise exception 'not_found'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id and role = 'client') then raise exception 'not_a_client'; end if;
  if p_member then
    insert into public.organization_members (organization_id, user_id) values (p_organization_id, p_user_id)
    on conflict do nothing;
  else
    delete from public.organization_members where organization_id = p_organization_id and user_id = p_user_id;
  end if;
end;
$$;

-- Donne accès à un compte déjà créé (ou invité) dans Supabase > Authentication, retrouvé par son e-mail.
create or replace function public.admin_add_user(p_organization_id uuid, p_email text, p_full_name text, p_job_title text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_role text;
begin
  perform private.require_admin();
  if not exists (select 1 from public.organizations where id = p_organization_id) then raise exception 'not_found'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(coalesce(p_email, ''))) limit 1;
  if v_user is null then raise exception 'user_not_found'; end if;

  select role into v_role from public.profiles where id = v_user;
  if v_role = 'admin' then raise exception 'not_a_client'; end if;
  if v_role is null then
    if length(trim(coalesce(p_full_name, ''))) = 0 then raise exception 'invalid_name'; end if;
    insert into public.profiles (id, full_name, job_title, role)
    values (v_user, trim(p_full_name), trim(coalesce(p_job_title, '')), 'client');
  end if;
  insert into public.organization_members (organization_id, user_id) values (p_organization_id, v_user)
  on conflict do nothing;
  return v_user;
end;
$$;

-- Adresses e-mail des utilisateurs, pour que l'administrateur les reconnaisse.
create or replace function public.admin_list_user_emails()
returns table (user_id uuid, email text) language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select p.id, u.email::text from public.profiles p join auth.users u on u.id = p.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Droits
-- ---------------------------------------------------------------------------

revoke execute on function private.require_admin() from public, anon, authenticated;
revoke execute on function
  public.admin_save_organization(uuid, text, text, text, text, text, text),
  public.admin_set_organization_archived(uuid, boolean),
  public.admin_assign_channel(uuid, uuid, boolean),
  public.admin_set_member(uuid, uuid, boolean),
  public.admin_add_user(uuid, text, text, text),
  public.admin_list_user_emails()
from public, anon;
grant execute on function
  public.admin_save_organization(uuid, text, text, text, text, text, text),
  public.admin_set_organization_archived(uuid, boolean),
  public.admin_assign_channel(uuid, uuid, boolean),
  public.admin_set_member(uuid, uuid, boolean),
  public.admin_add_user(uuid, text, text, text),
  public.admin_list_user_emails()
to authenticated;

-- Le rattachement d'un canal ne peut plus se faire par une écriture directe dans la table :
-- elle contournerait la confirmation de transfert et le masquage de l'historique.
drop policy if exists channels_assign on public.channels;
revoke update on public.channels from authenticated;

commit;
