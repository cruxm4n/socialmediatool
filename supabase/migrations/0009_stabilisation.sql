-- Cadence — stabilisation après l'audit du 9 octobre 2026 (migration corrective 0009)
-- Vérifiée sur une base PostgreSQL locale en mémoire (npm run test), NON appliquée à Supabase.
-- À appliquer après 0008. Aucune migration précédente n'est réécrite : les fonctions concernées sont
-- remplacées ici, et aucune donnée n'est supprimée.
--
--  B2  Appartenance historique explicite : chaque publication garde le client dont elle relève
--      (posts.owner_organization_id), indépendamment du propriétaire actuel du canal. Un import
--      dont l'origine est ambiguë (canal déjà transféré ou détaché) reste réservé à l'administrateur
--      (ownership = 'ambiguous') jusqu'à attribution par admin_set_post_owner.
--  B3  Une approbation est liée à un propriétaire (approved_organization_id), un contenu (empreinte)
--      et une version. Transfert, détachement et archivage suspendent les publications concernées :
--      l'approbation est retirée, une programmation externe passe en « annulation à confirmer »
--      (jamais présentée comme annulée tant que Buffer ne l'a pas confirmé).
--  B4  Réservation de programmation à jeton : la confirmation est conditionnelle (jeton, empreinte,
--      version, propriétaire). Une confirmation devenue invalide déclenche une compensation.
--  B5  Les notifications sont revalidées à chaque tentative de remise (membre, client actif,
--      version, préférences, rôle).
--  B6  Un résultat Buffer incertain (« unknown ») ne permet jamais une nouvelle création automatique.
--  P2  Versions de contenu immuables ; date d'approbation compatible avec la programmation ;
--      déprogrammation d'un post déjà publié signalée ; pause de quota enregistrée sans verrou.
begin;

do $$
begin
  if to_regclass('public.studio_variants') is null
     or to_regclass('public.post_versions') is null
     or to_regclass('public.notifications') is null
     or to_regclass('public.sync_state') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'channels' and column_name = 'last_organization_id') then
    raise exception 'migration_0009_requires_0004_to_0008: appliquez d''abord les migrations 0004 à 0008 (docs/ALIGNEMENT_SUPABASE.md).';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Colonnes
-- ---------------------------------------------------------------------------

alter table public.posts add column if not exists owner_organization_id uuid references public.organizations (id) on delete set null;
-- assigned : le client propriétaire est connu ; unassigned : canal jamais attribué ; ambiguous : à attribuer par l'administrateur.
alter table public.posts add column if not exists ownership text not null default 'unassigned';
alter table public.posts drop constraint if exists posts_ownership_check;
alter table public.posts add constraint posts_ownership_check check (ownership in ('assigned', 'unassigned', 'ambiguous'));
alter table public.posts add column if not exists approved_organization_id uuid references public.organizations (id) on delete set null;
-- Réservation de programmation : jeton, version et empreinte réservées.
alter table public.posts add column if not exists schedule_token uuid;
alter table public.posts add column if not exists schedule_claimed_hash text;
alter table public.posts add column if not exists schedule_claimed_version integer;
create index if not exists posts_owner_idx on public.posts (owner_organization_id);
create index if not exists posts_approved_organization_idx on public.posts (approved_organization_id);

alter table public.approval_decisions add column if not exists organization_id uuid references public.organizations (id) on delete set null;
create index if not exists approval_decisions_organization_idx on public.approval_decisions (organization_id);

-- Envoi Studio : un résultat incertain n'est ni un échec certain ni un succès.
alter table public.studio_variants drop constraint if exists studio_variants_push_state_check;
alter table public.studio_variants add constraint studio_variants_push_state_check
  check (push_state in ('idle', 'pushing', 'pushed', 'failed', 'unknown'));
alter table public.studio_variants add column if not exists push_unknown_at timestamptz;
-- Ce qui a été envoyé à la dernière tentative (texte complet, date, hashtags, révision) : sert à retrouver
-- le brouillon dans Buffer après un résultat inconnu, même si le contenu a été modifié depuis.
alter table public.studio_variants add column if not exists push_attempt jsonb;

-- ---------------------------------------------------------------------------
-- 2. Appartenance : règle unique
-- ---------------------------------------------------------------------------

-- Qui est propriétaire d'une publication qu'on découvre maintenant ?
--   1. elle vient du Studio : le client du contenu (explicite, jamais déduit) ;
--   2. canal attribué et jamais transféré : le client du canal ;
--   3. canal jamais attribué : personne pour l'instant (adopté à la première attribution) ;
--   4. canal transféré ou détaché : on ne peut pas savoir si c'est du contenu ancien ou nouveau → ambigu.
create or replace function private.resolve_post_owner(p_channel_id uuid, p_buffer_post_id text)
returns table (owner uuid, ownership text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_studio uuid;
  v_channel public.channels%rowtype;
begin
  select d.organization_id into v_studio
  from public.studio_variants v join public.studio_drafts d on d.id = v.draft_id
  where v.buffer_post_id = p_buffer_post_id limit 1;
  if v_studio is not null then
    return query select v_studio, 'assigned'::text;
    return;
  end if;

  select * into v_channel from public.channels where id = p_channel_id;
  if not found then
    return query select null::uuid, 'ambiguous'::text;
  elsif v_channel.organization_id is not null and v_channel.visible_from is null then
    return query select v_channel.organization_id, 'assigned'::text;
  elsif v_channel.organization_id is null and v_channel.last_organization_id is null then
    return query select null::uuid, 'unassigned'::text;
  else
    return query select null::uuid, 'ambiguous'::text;
  end if;
end;
$$;

-- Une publication peut-elle être décidée / programmée ? Propriétaire connu, canal encore à ce client, client actif.
create or replace function private.is_post_reviewable(p_owner uuid, p_ownership text, p_channel_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_owner is not null and p_ownership = 'assigned' and exists (
    select 1 from public.channels c join public.organizations o on o.id = c.organization_id
    where c.id = p_channel_id and c.organization_id = p_owner and o.archived_at is null
  );
$$;

-- L'utilisateur connecté peut-il décider ou commenter cette publication ?
create or replace function private.can_decide_post(p_owner uuid, p_ownership text, p_channel_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_post_reviewable(p_owner, p_ownership, p_channel_id)
     and p_owner in (select private.my_org_ids());
$$;

-- Reprise de l'existant (une seule fois, sur les publications sans propriétaire connu).
update public.posts p set owner_organization_id = d.organization_id, ownership = 'assigned'
from public.studio_variants v join public.studio_drafts d on d.id = v.draft_id
where v.buffer_post_id = p.buffer_post_id and p.owner_organization_id is null and p.ownership = 'unassigned';

update public.posts p set
  owner_organization_id = coalesce(c.organization_id, c.last_organization_id),
  ownership = 'assigned'
from public.channels c
where c.id = p.channel_id and p.ownership = 'unassigned' and p.owner_organization_id is null
  and c.visible_from is null and coalesce(c.organization_id, c.last_organization_id) is not null;

-- Canal déjà transféré : on ignore qui possédait quoi avant la date de transfert (created_at est une date d'import).
update public.posts p set ownership = 'ambiguous'
from public.channels c
where c.id = p.channel_id and p.ownership = 'unassigned' and p.owner_organization_id is null and c.visible_from is not null;

-- Approbations existantes : liées au propriétaire reconnu. Sans propriétaire, elles ne sont plus programmables.
update public.posts set approved_organization_id = owner_organization_id
where approval_status = 'approved' and ownership = 'assigned' and approved_organization_id is null;

update public.approval_decisions d set organization_id = p.owner_organization_id
from public.posts p
where p.id = d.post_id and d.organization_id is null and p.ownership = 'assigned';

-- ---------------------------------------------------------------------------
-- 3. Visibilité côté client : par propriétaire, plus par date d'import
-- ---------------------------------------------------------------------------

alter policy posts_select on public.posts
  using (
    (select private.is_admin())
    or (
      approval_status <> 'none'
      and removed_at is null
      and ownership = 'assigned'
      and owner_organization_id in (select private.my_org_ids())
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Historique des versions : append-only
-- ---------------------------------------------------------------------------

create or replace function private.record_post_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Une version existante n'est jamais réécrite : un changement de contenu crée une nouvelle version.
  insert into public.post_versions (post_id, version, text, due_at, assets, content_hash)
  values (new.id, new.version, new.text, new.due_at, new.assets, new.content_hash)
  on conflict (post_id, version) do nothing;
  return new;
exception when others then
  raise warning 'version non enregistrée : %', sqlerrm;
  return new;
end;
$$;

create or replace function private.post_versions_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- La suppression en cascade d'un post (pg_trigger_depth > 1) reste possible ; rien d'autre.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'post_versions_immutable';
end;
$$;

drop trigger if exists post_versions_immutable on public.post_versions;
create trigger post_versions_immutable before update or delete on public.post_versions
  for each row execute function private.post_versions_immutable();

-- ---------------------------------------------------------------------------
-- 5. Suspension des opérations devenues invalides (transfert, détachement, archivage)
-- ---------------------------------------------------------------------------

-- Retire la validation et la programmation des publications non publiées visées.
-- Une programmation déjà acceptée par Buffer passe en « unschedule_pending » : elle n'est
-- considérée comme annulée que lorsque la synchronisation l'a constaté dans Buffer.
create or replace function private.suspend_posts(p_channel_id uuid, p_organization_id uuid, p_reason text, p_post_ids uuid[] default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_post public.posts%rowtype;
  v_count integer := 0;
begin
  for v_post in
    select * from public.posts p
    where (p.channel_id = p_channel_id or p.owner_organization_id = p_organization_id or p.id = any (coalesce(p_post_ids, '{}')))
      and p.removed_at is null
      and p.buffer_status in ('draft', 'needs_approval', 'scheduled')
      and (p.approval_status <> 'none' or p.schedule_state <> 'idle')
    for update
  loop
    update public.posts set
      approval_status = 'none',
      approved_hash = null, approved_version = null, approved_at = null, approved_by = null, approved_organization_id = null,
      schedule_state = case
        when v_post.schedule_state in ('claimed', 'scheduled', 'unschedule_pending') or v_post.buffer_status = 'scheduled' then 'unschedule_pending'
        else 'idle' end,
      schedule_token = null, schedule_claimed_hash = null, schedule_claimed_version = null,
      schedule_attempts = 0,
      schedule_error = case
        when v_post.schedule_state in ('claimed', 'scheduled', 'unschedule_pending') or v_post.buffer_status = 'scheduled'
          then 'Suspendue (' || p_reason || ') : l''annulation de la programmation dans Buffer reste à confirmer.'
        else null end
    where id = v_post.id;
    perform private.add_event(v_post.id, 'suspended', null, left(p_reason, 200), v_post.version);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Attribution d'un canal : mêmes règles que 0005, plus suspension des publications du client précédent.
create or replace function public.admin_assign_channel(p_channel_id uuid, p_organization_id uuid, p_confirm_transfer boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_channel public.channels%rowtype;
  v_previous uuid;
  v_history integer;
  v_transfer boolean;
  v_suspended integer := 0;
begin
  perform private.require_admin();
  select * into v_channel from public.channels where id = p_channel_id for update;
  if not found then raise exception 'not_found'; end if;
  v_previous := coalesce(v_channel.organization_id, v_channel.last_organization_id);

  if p_organization_id is null then
    if v_channel.organization_id is not null then
      v_suspended := private.suspend_posts(p_channel_id, null, 'canal détaché du client');
    end if;
    update public.channels set organization_id = null, last_organization_id = v_previous where id = p_channel_id;
    return jsonb_build_object('transferred', false, 'hidden_posts', 0, 'suspended_posts', v_suspended);
  end if;

  if not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;

  select count(*) into v_history from public.posts where channel_id = p_channel_id;
  v_transfer := v_previous is not null and v_previous <> p_organization_id and v_history > 0;
  if v_transfer and not coalesce(p_confirm_transfer, false) then
    raise exception 'transfer_confirmation_required';
  end if;

  if v_transfer or (v_channel.organization_id is not null and v_channel.organization_id <> p_organization_id) then
    v_suspended := private.suspend_posts(p_channel_id, null, 'canal transféré à un autre client');
  end if;

  update public.channels set
    organization_id = p_organization_id,
    last_organization_id = p_organization_id,
    visible_from = case when v_transfer then now() else visible_from end
  where id = p_channel_id;

  -- Première attribution d'un canal jamais attribué : l'administrateur adopte l'historique existant.
  if v_previous is null then
    update public.posts set owner_organization_id = p_organization_id, ownership = 'assigned'
    where channel_id = p_channel_id and ownership = 'unassigned' and owner_organization_id is null;
  end if;

  return jsonb_build_object('transferred', v_transfer, 'hidden_posts', case when v_transfer then v_history else 0 end, 'suspended_posts', v_suspended);
end;
$$;

create or replace function public.admin_set_organization_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.organizations set archived_at = case when p_archived then coalesce(archived_at, now()) end where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if p_archived then
    perform private.suspend_posts(null, p_id, 'client archivé');
  end if;
end;
$$;

-- Attribue des publications ambiguës (ou jamais attribuées) à un client. Réservé à l'administrateur.
create or replace function public.admin_set_post_owner(p_post_ids uuid[], p_organization_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.require_admin();
  if not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;
  with changed as (
    update public.posts set owner_organization_id = p_organization_id, ownership = 'assigned'
    where id = any (p_post_ids) and ownership in ('ambiguous', 'unassigned')
    returning id, version
  ), logged as (
    insert into public.post_events (post_id, type, actor_id, version)
    select id, 'owner_assigned', (select auth.uid()), version from changed
    returning 1
  )
  select count(*) into v_count from logged;
  -- Attribuée à un client qui n'est pas (ou plus) celui du canal : rien à décider ni à programmer.
  perform private.suspend_posts(null, null, 'attribuée à un autre client que celui du canal', array(
    select p.id from public.posts p
    where p.id = any (p_post_ids) and p.ownership = 'assigned'
      and not private.is_post_reviewable(p.owner_organization_id, p.ownership, p.channel_id)));
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Décision du client : propriétaire, version, date compatible avec la programmation
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

  select * into v_post from public.posts where id = p_post_id for update;

  if not found or v_post.removed_at is not null or v_post.approval_status = 'none'
     or not private.can_decide_post(v_post.owner_organization_id, v_post.ownership, v_post.channel_id) then
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
  if p_decision = 'approved' then
    if v_post.due_at is null or v_post.due_at <= now() then
      raise exception 'date_invalid';
    end if;
    -- Marge supérieure à celle de la réservation (2 minutes) : une date approuvable reste programmable.
    if v_post.due_at <= now() + interval '10 minutes' then
      raise exception 'date_too_close';
    end if;
  end if;

  insert into public.approval_decisions (post_id, version, content_hash, decision, user_id, comment, organization_id)
  values (v_post.id, v_post.version, v_post.content_hash, p_decision, v_uid, v_comment, v_post.owner_organization_id);

  if p_decision = 'approved' then
    update public.posts set
      approval_status = 'approved', approved_hash = content_hash, approved_version = version,
      approved_at = now(), approved_by = v_uid, approved_organization_id = owner_organization_id,
      schedule_state = 'idle', schedule_attempts = 0, schedule_error = null,
      schedule_token = null, schedule_claimed_hash = null, schedule_claimed_version = null
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
      v_post.approval_status <> 'none' and v_post.removed_at is null
      and private.can_decide_post(v_post.owner_organization_id, v_post.ownership, v_post.channel_id)
    )
  ) then
    raise exception 'not_found';
  end if;
  insert into public.comments (post_id, author_id, body, version) values (v_post.id, v_uid, trim(p_body), v_post.version);
  perform private.add_event(v_post.id, 'commented', v_uid, null, v_post.version);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Synchronisation : remplace sync_buffer_posts (0004)
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
  v_owner uuid;
  v_ownership text;
  v_blocked boolean;
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
      select r.owner, r.ownership into v_owner, v_ownership from private.resolve_post_owner(v_channel_id, v_p ->> 'id') r;
      insert into public.posts (
        buffer_post_id, channel_id, service, text, assets, due_at, buffer_status, buffer_error, external_link,
        sent_at, buffer_updated_at, has_review_tag, content_hash, approval_status, submitted_at,
        owner_organization_id, ownership
      ) values (
        v_p ->> 'id', v_channel_id, v_p ->> 'service', coalesce(v_p ->> 'text', ''), coalesce(v_p -> 'assets', '[]'::jsonb),
        v_due, v_status, v_p ->> 'error', v_p ->> 'externalLink', (v_p ->> 'sentAt')::timestamptz,
        (v_p ->> 'updatedAt')::timestamptz, v_tag, v_hash,
        case when v_tag and v_status = 'draft' then 'pending' else 'none' end,
        case when v_tag and v_status = 'draft' then now() end,
        v_owner, v_ownership
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
    v_owner := v_row.owner_organization_id;
    v_ownership := v_row.ownership;

    -- Canal attribué depuis : une publication « sans propriétaire » est adoptée si la règle le permet.
    if v_owner is null and v_ownership = 'unassigned' then
      select r.owner, r.ownership into v_owner, v_ownership from private.resolve_post_owner(v_channel_id, v_row.buffer_post_id) r;
    end if;
    -- Propriétaire connu mais canal transféré, détaché ou client archivé : le circuit de validation est suspendu.
    v_blocked := v_ownership = 'assigned' and not private.is_post_reviewable(v_owner, v_ownership, v_channel_id);

    -- 1. Le contenu a changé : une nouvelle version est toujours créée, jamais une réécriture.
    if v_hash <> v_row.content_hash then
      v_version := v_version + 1;
      if v_status in ('draft', 'needs_approval', 'scheduled') then
        if v_approval = 'approved' then
          v_approval := 'pending';
          v_invalidated := v_invalidated + 1;
          -- Réservation en cours ou programmation déjà acceptée : à repasser en brouillon et à confirmer dans Buffer.
          v_sched := case when v_sched in ('claimed', 'scheduled', 'unschedule_pending') or v_status = 'scheduled' then 'unschedule_pending' else 'idle' end;
          v_attempts := 0;
          perform private.add_event(v_row.id, 'approval_invalidated', null, null, v_version);
        elsif v_approval = 'changes_requested' then
          v_approval := 'pending';
          perform private.add_event(v_row.id, 'resubmitted', null, null, v_version);
        elsif v_approval = 'pending' then
          perform private.add_event(v_row.id, 'updated', null, null, v_version);
        end if;
      elsif v_approval <> 'none' then
        -- Publié (ou en cours) avec un contenu différent de celui validé : la version approuvée reste intacte.
        perform private.add_event(v_row.id, 'content_changed', null, 'Contenu modifié après publication', v_version);
      end if;
    end if;

    -- 2. Le tag « à valider » a été posé ou retiré sur un brouillon
    if v_status = 'draft' then
      if v_approval = 'none' and v_tag and not v_blocked then
        v_approval := 'pending';
        perform private.add_event(v_row.id, 'submitted', null, null, v_version);
      elsif v_approval in ('pending', 'changes_requested') and not v_tag then
        v_approval := 'none';
        perform private.add_event(v_row.id, 'withdrawn', null, null, v_version);
      elsif v_approval = 'approved' and not v_tag then
        v_approval := 'none';
        v_sched := case when v_sched in ('claimed', 'scheduled', 'unschedule_pending') then 'unschedule_pending' else 'idle' end;
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

    -- 5. Validation devenue invalide (propriétaire, canal ou client) sur une publication non publiée
    if v_status in ('draft', 'needs_approval', 'scheduled') and v_approval <> 'none' and (
         v_blocked or (v_approval = 'approved' and (v_ownership <> 'assigned' or v_row.approved_organization_id is distinct from v_owner))
       ) then
      v_approval := case when v_blocked then 'none' else 'pending' end;
      v_sched := case when v_sched in ('claimed', 'scheduled', 'unschedule_pending') or v_status = 'scheduled' then 'unschedule_pending' else 'idle' end;
      v_attempts := 0;
      v_invalidated := v_invalidated + 1;
      perform private.add_event(v_row.id, 'suspended', null, 'Propriétaire ou canal modifié : validation retirée', v_version);
    end if;

    -- 6. Buffer indique « programmé » alors que la validation n'est plus valable : il faut le repasser en brouillon.
    --    (Ne concerne que les posts passés par le circuit de Cadence, jamais une programmation faite à la main.)
    if v_status = 'scheduled' and v_approval <> 'approved'
       and (v_row.approval_status = 'approved' or v_row.schedule_state in ('claimed', 'scheduled', 'failed', 'unschedule_pending')) then
      v_sched := 'unschedule_pending';
    -- 7. Buffer confirme une programmation dont la confirmation locale a été perdue (résultat incertain).
    elsif v_status = 'scheduled' and v_approval = 'approved' and v_hash = v_row.approved_hash and v_sched in ('claimed', 'failed') then
      v_sched := 'scheduled';
      v_attempts := 0;
      perform private.add_event(v_row.id, 'scheduled', null, 'Constaté dans Buffer', v_version);
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
      owner_organization_id = v_owner,
      ownership = v_ownership,
      approval_status = v_approval,
      approved_hash = case when v_approval = 'approved' then approved_hash end,
      approved_version = case when v_approval = 'approved' then approved_version end,
      approved_at = case when v_approval = 'approved' then approved_at end,
      approved_by = case when v_approval = 'approved' then approved_by end,
      approved_organization_id = case when v_approval = 'approved' then approved_organization_id end,
      submitted_at = case when v_approval = 'pending' and v_row.approval_status <> 'pending' then now() else submitted_at end,
      schedule_state = v_sched,
      schedule_attempts = v_attempts,
      schedule_error = case when v_sched = 'idle' then null else schedule_error end,
      -- Une réservation dont le contenu ou la validation a changé n'est plus confirmable.
      schedule_token = case when v_sched = 'claimed' and v_approval = 'approved' and v_hash = v_row.content_hash then schedule_token end,
      schedule_claimed_hash = case when v_sched = 'claimed' and v_approval = 'approved' and v_hash = v_row.content_hash then schedule_claimed_hash end,
      schedule_claimed_version = case when v_sched = 'claimed' and v_approval = 'approved' and v_hash = v_row.content_hash then schedule_claimed_version end,
      removed_at = null,
      synced_at = now()
    where id = v_row.id;
    v_updated := v_updated + 1;
  end loop;

  -- Posts absents de Buffer : supprimés là-bas (voir 0004 pour les posts programmés à date passée).
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

-- ---------------------------------------------------------------------------
-- 8. Programmation : réservation à jeton, confirmation conditionnelle, compensation
-- ---------------------------------------------------------------------------

drop function if exists public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer);
drop function if exists public.claim_posts_for_scheduling(text, uuid, integer);
drop function if exists public.complete_scheduling(text, uuid, boolean, text);
drop function if exists public.complete_unscheduling(text, uuid, boolean, text);

-- Réserve les posts programmables. Conditions : validation courante (empreinte et version), propriétaire
-- connu, canal encore à ce propriétaire, client actif, date assez lointaine. Renvoie le contenu réservé
-- et un jeton que la confirmation devra représenter.
create or replace function public.claim_posts_for_scheduling_in_mode(p_secret text, p_mode text, p_post_id uuid default null, p_limit integer default 10)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text, version integer, content_hash text, token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return query
  update public.posts p set
    schedule_state = 'claimed', schedule_claimed_at = now(), schedule_attempts = p.schedule_attempts + 1,
    schedule_token = gen_random_uuid(), schedule_claimed_hash = p.content_hash, schedule_claimed_version = p.version
  where p.id in (
    select c.id from public.posts c
    join public.channels ch on ch.id = c.channel_id
    join public.organizations o on o.id = ch.organization_id
    where (case when p_mode = 'mock' then c.buffer_post_id like 'mock-%' else c.buffer_post_id not like 'mock-%' end)
      and c.approval_status = 'approved'
      and c.approved_hash = c.content_hash
      and c.approved_version = c.version
      and c.ownership = 'assigned'
      and c.owner_organization_id is not null
      and c.approved_organization_id = c.owner_organization_id
      and ch.organization_id = c.owner_organization_id
      and o.archived_at is null
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
  returning p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service, p.version, p.content_hash, p.schedule_token;
end;
$$;

create or replace function public.claim_posts_for_scheduling(p_secret text, p_post_id uuid default null, p_limit integer default 10)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text, version integer, content_hash text, token uuid)
language sql security definer set search_path = '' as $$
  select * from public.claim_posts_for_scheduling_in_mode(p_secret, 'real', p_post_id, p_limit);
$$;

-- Confirme (ou constate l'échec de) la programmation d'une réservation.
-- Réponses : 'scheduled' | 'failed' | 'stale' (Buffer a accepté une réservation devenue invalide : compensation
-- demandée, le post reste « à repasser en brouillon » tant que Buffer ne l'a pas confirmé) | 'ignored'.
create or replace function public.complete_scheduling(p_secret text, p_post_id uuid, p_ok boolean, p_error text default null, p_token uuid default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_post public.posts%rowtype;
  v_valid boolean;
begin
  perform private.check_secret(p_secret);
  select * into v_post from public.posts where id = p_post_id for update;
  if not found then return 'ignored'; end if;

  v_valid := v_post.schedule_state = 'claimed'
    and (p_token is null or v_post.schedule_token = p_token)
    and v_post.removed_at is null
    and v_post.approval_status = 'approved'
    and v_post.approved_hash = v_post.content_hash
    and v_post.approved_version = v_post.version
    and (v_post.schedule_claimed_hash is null or v_post.schedule_claimed_hash = v_post.content_hash)
    and private.is_post_reviewable(v_post.owner_organization_id, v_post.ownership, v_post.channel_id)
    and v_post.approved_organization_id = v_post.owner_organization_id;

  if p_ok then
    if v_valid then
      update public.posts set schedule_state = 'scheduled', buffer_status = 'scheduled', schedule_error = null,
        schedule_token = null
      where id = p_post_id;
      perform private.add_event(p_post_id, 'scheduled', null, null, v_post.version);
      return 'scheduled';
    end if;
    -- Buffer a accepté une réservation qui n'est plus valable : on ne l'enregistre pas comme programmée
    -- avec une validation, on la signale « à annuler » et on garde la trace de l'état externe réel.
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

  if v_post.schedule_state = 'claimed' and (p_token is null or v_post.schedule_token = p_token) then
    update public.posts set schedule_state = 'failed', schedule_error = left(coalesce(p_error, 'Erreur inconnue'), 500),
      schedule_token = null
    where id = p_post_id;
    perform private.add_event(p_post_id, 'schedule_failed', null, left(p_error, 500), v_post.version);
    return 'failed';
  end if;
  return 'ignored';
end;
$$;

-- p_observed_status : statut réellement constaté dans Buffer par l'appelant. Un post déjà publié n'est
-- jamais présenté comme « repassé en brouillon ».
create or replace function public.complete_unscheduling(p_secret text, p_post_id uuid, p_ok boolean, p_error text default null, p_observed_status text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_version integer;
begin
  perform private.check_secret(p_secret);
  if p_ok then
    if p_observed_status = 'missing' then
      -- Le post n'existe plus dans Buffer : rien à repasser en brouillon (la synchronisation le marquera retiré).
      update public.posts set schedule_state = 'idle', schedule_error = null, schedule_attempts = 0, schedule_token = null
      where id = p_post_id and schedule_state = 'unschedule_pending' returning version into v_version;
      if found then perform private.add_event(p_post_id, 'unschedule_missing', null, null, v_version); end if;
    elsif p_observed_status in ('sent', 'sending', 'error') then
      update public.posts set schedule_state = 'idle', buffer_status = p_observed_status, schedule_error = null, schedule_attempts = 0,
        schedule_token = null
      where id = p_post_id and schedule_state = 'unschedule_pending' returning version into v_version;
      if found then perform private.add_event(p_post_id, 'unschedule_too_late', null, 'Statut Buffer : ' || p_observed_status, v_version); end if;
    else
      update public.posts set schedule_state = 'idle', buffer_status = 'draft', schedule_error = null, schedule_attempts = 0,
        schedule_token = null
      where id = p_post_id and schedule_state = 'unschedule_pending' returning version into v_version;
      if found then perform private.add_event(p_post_id, 'unscheduled', null, null, v_version); end if;
    end if;
  else
    update public.posts set schedule_error = left(coalesce(p_error, 'Erreur inconnue'), 500)
    where id = p_post_id and schedule_state = 'unschedule_pending';
  end if;
end;
$$;

-- Pause des exécutions planifiées, enregistrée sans détenir le verrou (quota atteint pendant une action isolée).
create or replace function public.set_sync_backoff(p_secret text, p_mode text, p_seconds integer, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  insert into public.sync_state (mode) values (p_mode) on conflict (mode) do nothing;
  update public.sync_state set
    backoff_until = greatest(coalesce(backoff_until, now()), now() + make_interval(secs => greatest(1, least(coalesce(p_seconds, 0), 86400)))),
    backoff_reason = left(coalesce(p_reason, 'Quota de requêtes Buffer atteint.'), 300),
    updated_at = now()
  where mode = p_mode;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Notifications : revalidation à chaque tentative de remise (B5)
-- ---------------------------------------------------------------------------

create or replace function private.enqueue_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_post public.posts%rowtype;
  v_mode text;
  v_detail text;
begin
  -- Contenu d'une publication encore en attente modifié : une demande pas encore remise suit la nouvelle
  -- version (elle est alors remise avec le contenu à jour) ; une demande déjà remise n'est pas répétée.
  if new.type = 'updated' then
    update public.notifications n set
      post_version = new.version,
      dedupe_key = 'review_requested:' || n.post_id || ':' || new.version || ':' || n.recipient_id
    where n.post_id = new.post_id and n.kind = 'review_requested' and n.status in ('pending', 'failed')
      and not exists (select 1 from public.notifications x
                      where x.dedupe_key = 'review_requested:' || n.post_id || ':' || new.version || ':' || n.recipient_id);
    return new;
  end if;

  v_kind := case
    when new.type in ('submitted', 'resubmitted', 'approval_invalidated', 'unscheduled_in_buffer') then 'review_requested'
    when new.type = 'changes_requested' then 'changes_requested'
    when new.type = 'approved' then 'approved'
    when new.type in ('schedule_failed', 'failed') then 'schedule_error'
  end;
  if v_kind is null then return new; end if;

  select * into v_post from public.posts where id = new.post_id;
  if not found then return new; end if;
  v_mode := case when v_post.buffer_post_id like 'mock-%' then 'mock' else 'real' end;

  if v_kind = 'review_requested' then
    -- Seuls les membres du client propriétaire, quand le canal est encore à ce client et qu'il est actif.
    if not private.is_post_reviewable(v_post.owner_organization_id, v_post.ownership, v_post.channel_id) then return new; end if;
    insert into public.notifications (kind, mode, recipient_id, post_id, organization_id, post_version, dedupe_key)
    select v_kind, v_mode, m.user_id, v_post.id, o.id, new.version, v_kind || ':' || v_post.id || ':' || new.version || ':' || m.user_id
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id and o.archived_at is null
    join public.profiles pr on pr.id = m.user_id and pr.role = 'client'
    left join public.notification_preferences np on np.user_id = m.user_id
    where m.organization_id = v_post.owner_organization_id
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
  select v_kind, v_mode, pr.id, v_post.id, v_post.owner_organization_id, new.version,
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
  raise warning 'notification non créée : %', sqlerrm;
  return new;
end;
$$;

create or replace function public.claim_notifications(p_secret text, p_mode text, p_limit integer default 50)
returns table (
  id uuid, kind text, recipient_id uuid, recipient_name text, recipient_email text,
  organization_name text, organization_slug text, timezone text,
  post_id uuid, post_text text, service text, due_at timestamptz, detail text, created_at timestamptz
) language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;

  -- Revalidation de TOUTES les notifications encore à remettre (en attente, échouées à reprendre, bloquées) :
  -- une notification qui n'est plus légitime est annulée, jamais envoyée.
  update public.notifications n set status = 'cancelled', error = 'Destinataire ou publication plus éligible au moment de l''envoi.'
  where n.mode = p_mode
    and (n.status = 'pending' or (n.status = 'failed' and n.attempts < 5)
         or (n.status = 'sending' and n.claimed_at < now() - interval '10 minutes'))
    and not (
      exists (select 1 from public.profiles pr where pr.id = n.recipient_id)
      and exists (select 1 from public.posts p where p.id = n.post_id and p.removed_at is null)
      and case n.kind
        when 'review_requested' then
          -- Client : toujours membre du client propriétaire, client actif, publication encore à valider, même version.
          exists (
            select 1 from public.posts p
            join public.organization_members m on m.user_id = n.recipient_id and m.organization_id = p.owner_organization_id
            join public.profiles pr on pr.id = n.recipient_id and pr.role = 'client'
            where p.id = n.post_id
              and p.approval_status = 'pending'
              and p.version = n.post_version
              and p.buffer_status = 'draft'
              and n.organization_id is not distinct from p.owner_organization_id
              and private.is_post_reviewable(p.owner_organization_id, p.ownership, p.channel_id)
          )
          and coalesce((select np.review_requested from public.notification_preferences np where np.user_id = n.recipient_id), true)
        else
          -- Administrateur : toujours administrateur, préférence toujours active.
          exists (select 1 from public.profiles pr where pr.id = n.recipient_id and pr.role = 'admin')
          and case n.kind
            when 'changes_requested' then coalesce((select np.changes_requested from public.notification_preferences np where np.user_id = n.recipient_id), true)
            when 'approved' then coalesce((select np.approved from public.notification_preferences np where np.user_id = n.recipient_id), false)
            else coalesce((select np.schedule_error from public.notification_preferences np where np.user_id = n.recipient_id), true)
          end
      end
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

-- ---------------------------------------------------------------------------
-- 10. Studio : photographie cohérente de l'envoi et résultat incertain (B6)
-- ---------------------------------------------------------------------------

drop function if exists public.studio_claim_push(uuid, boolean);
drop function if exists public.studio_complete_push(uuid, boolean, text, text, integer);

-- Réserve les textes à envoyer et renvoie, dans la même opération verrouillée, tout le contenu (révision,
-- date, hashtags, médias) : l'envoi n'utilise que cette photographie, jamais une relecture séparée.
create or replace function public.studio_claim_push(p_draft_id uuid, p_force boolean default false)
returns table (
  variant_id uuid, channel_id uuid, buffer_channel_id text, service text, text text, buffer_post_id text, revision integer,
  due_at timestamptz, hashtags text[], media_ids uuid[], organization_id uuid
)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.studio_drafts%rowtype;
begin
  perform private.require_admin();
  select * into v_draft from public.studio_drafts d where d.id = p_draft_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_draft.status = 'archived' then raise exception 'draft_archived'; end if;
  if not exists (select 1 from public.organizations o where o.id = v_draft.organization_id and o.archived_at is null) then
    raise exception 'organization_unavailable';
  end if;
  -- Même marge que le domaine (MIN_LEAD_MS) : elle laisse au client le temps de répondre avant l'échéance.
  if v_draft.due_at is null or v_draft.due_at <= now() + interval '15 minutes' then raise exception 'date_invalid'; end if;
  if not exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null) then raise exception 'no_variant'; end if;
  if exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null
             and v.push_state = 'pushing' and v.push_claimed_at > now() - interval '5 minutes') then
    raise exception 'push_in_progress';
  end if;
  -- Résultat inconnu : aucune nouvelle création tant que Buffer n'a pas été interrogé (studio_resolve_unknown).
  if exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null and v.push_state = 'unknown') then
    raise exception 'push_unknown';
  end if;
  if not coalesce(p_force, false) and exists (
    select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null and v.push_state = 'pushing') then
    raise exception 'push_uncertain';
  end if;
  if exists (select 1 from public.studio_variants v join public.channels c on c.id = v.channel_id
             where v.draft_id = p_draft_id and v.removed_at is null and c.organization_id is distinct from v_draft.organization_id) then
    raise exception 'invalid_channel';
  end if;

  return query
  update public.studio_variants v set push_state = 'pushing', push_claimed_at = now(), push_error = null, updated_at = now(),
    push_attempt = jsonb_build_object('text', v.text, 'dueAt', v_draft.due_at, 'hashtags', to_jsonb(v_draft.hashtags), 'revision', v_draft.revision)
  from public.channels c
  where c.id = v.channel_id and v.draft_id = p_draft_id and v.removed_at is null
    and (v.push_state in ('idle', 'failed', 'pushing') or v.pushed_revision is distinct from v_draft.revision)
  returning v.id, v.channel_id, c.buffer_channel_id, c.service, v.text, v.buffer_post_id, v_draft.revision,
            v_draft.due_at, v_draft.hashtags, v_draft.media_ids, v_draft.organization_id;
end;
$$;

-- p_uncertain : la réponse de Buffer a été perdue (délai, coupure, réponse illisible). Le brouillon a peut-être
-- été créé : l'état « unknown » interdit toute nouvelle création automatique.
create or replace function public.studio_complete_push(
  p_variant_id uuid, p_ok boolean, p_buffer_post_id text default null, p_error text default null, p_revision integer default null,
  p_uncertain boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_draft uuid;
begin
  perform private.require_admin();
  update public.studio_variants set
    push_state = case when p_ok then 'pushed' when coalesce(p_uncertain, false) and coalesce(p_buffer_post_id, buffer_post_id) is null then 'unknown' else 'failed' end,
    buffer_post_id = coalesce(p_buffer_post_id, buffer_post_id),
    push_error = case when p_ok then null else left(coalesce(p_error, 'Erreur inconnue'), 500) end,
    pushed_revision = case when p_ok then p_revision else pushed_revision end,
    pushed_at = case when p_ok then now() else pushed_at end,
    push_unknown_at = case when p_ok then null when coalesce(p_uncertain, false) and coalesce(p_buffer_post_id, buffer_post_id) is null then now() else push_unknown_at end,
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

-- Résolution d'un envoi dont le résultat est inconnu, après interrogation de Buffer par l'application :
--   p_buffer_post_id : le brouillon a été retrouvé → il est adopté (jamais recréé) ;
--   p_confirmed_absent : rien trouvé et le délai de sécurité est écoulé → un nouvel envoi redevient possible.
create or replace function public.studio_resolve_unknown(p_variant_id uuid, p_buffer_post_id text default null, p_confirmed_absent boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_variant public.studio_variants%rowtype;
begin
  perform private.require_admin();
  select * into v_variant from public.studio_variants where id = p_variant_id for update;
  if not found or v_variant.push_state <> 'unknown' then raise exception 'not_found'; end if;

  if p_buffer_post_id is not null then
    if exists (select 1 from public.studio_variants v where v.buffer_post_id = p_buffer_post_id and v.id <> p_variant_id) then
      raise exception 'buffer_post_taken';
    end if;
    update public.studio_variants set
      buffer_post_id = p_buffer_post_id, push_state = 'failed', push_error = 'Brouillon retrouvé dans Buffer : renvoyez pour le mettre à jour.',
      pushed_revision = null, push_unknown_at = null, updated_at = now()
    where id = p_variant_id;
    return 'adopted';
  end if;

  if coalesce(p_confirmed_absent, false) then
    if v_variant.push_unknown_at is not null and v_variant.push_unknown_at > now() - interval '10 minutes' then
      raise exception 'unknown_too_recent';
    end if;
    update public.studio_variants set push_state = 'failed', push_error = 'Aucun brouillon trouvé dans Buffer après vérification : renvoi possible.',
      push_unknown_at = null, updated_at = now()
    where id = p_variant_id;
    return 'retry_allowed';
  end if;
  return 'unchanged';
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Droits
-- ---------------------------------------------------------------------------

revoke execute on function
  private.resolve_post_owner(uuid, text),
  private.is_post_reviewable(uuid, text, uuid),
  private.can_decide_post(uuid, text, uuid),
  private.suspend_posts(uuid, uuid, text, uuid[]),
  private.post_versions_immutable()
from public, anon, authenticated;

revoke execute on function
  public.admin_set_post_owner(uuid[], uuid),
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer, boolean),
  public.studio_resolve_unknown(uuid, text, boolean)
from public, anon;
grant execute on function
  public.admin_set_post_owner(uuid[], uuid),
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer, boolean),
  public.studio_resolve_unknown(uuid, text, boolean)
to authenticated;

revoke execute on function
  public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer),
  public.claim_posts_for_scheduling(text, uuid, integer),
  public.complete_scheduling(text, uuid, boolean, text, uuid),
  public.complete_unscheduling(text, uuid, boolean, text, text),
  public.set_sync_backoff(text, text, integer, text)
from public;
-- Fonctions d'automatisation : protégées par le secret partagé, appelables sans session utilisateur.
grant execute on function
  public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer),
  public.claim_posts_for_scheduling(text, uuid, integer),
  public.complete_scheduling(text, uuid, boolean, text, uuid),
  public.complete_unscheduling(text, uuid, boolean, text, text),
  public.set_sync_backoff(text, text, integer, text)
to anon, authenticated;

commit;
