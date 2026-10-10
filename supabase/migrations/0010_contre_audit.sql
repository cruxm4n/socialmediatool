-- Cadence — corrections du contre-audit indépendant du 10 octobre 2026 (migration corrective 0010)
-- Vérifiée sur une base PostgreSQL locale en mémoire (npm run test), NON appliquée à Supabase.
-- À appliquer après 0009. Aucune migration précédente n'est réécrite ; aucune donnée n'est supprimée.
--
--  B2  Toute transition de propriétaire d'un canal laisse une trace durable (channel_owner_history +
--      visible_from), même lorsque le canal ne contient encore aucune publication importée. Un déclencheur
--      applique cette règle quelle que soit la voie d'écriture. Un import dont l'origine n'est pas prouvée
--      reste « ambiguous » (administrateur seul) jusqu'à admin_set_post_owner.
--  B3  Le retrait d'un membre retire ses approbations (déclencheur sur organization_members). Une
--      réservation et sa confirmation revalident l'approbateur (membre du client, rôle client).
--  B4  Une confirmation sans jeton (ou avec un jeton périmé) ne peut plus confirmer une autre réservation.
--      Une confirmation tardive d'une opération périmée place le post en « annulation à confirmer ».
--      Marge de réservation alignée (5 minutes) sur la chaîne 5 / 10 / 15 minutes.
--  B5  claim_notifications revalide à chaque appel ; complete_notifications sait « rendre » une notification
--      réservée mais pas encore remise (status 'released').
--  B6  Un envoi Studio abandonné (« pushing » ancien) ou inconnu bloque tout nouvel envoi, y compris
--      forcé. L'absence d'un brouillon n'est jamais déduite : elle exige une confirmation humaine explicite.
--  Q   Retry-After : pause conservée jusqu'à 30 jours ; une pause posée en cours d'exécution n'est plus effacée.
--
-- Pas de script de retour arrière : revenir aux fonctions de 0009 rouvrirait les défauts corrigés ici. Un défaut
-- se corrige en avant (nouvelle migration). Aucune donnée n'est supprimée ; les colonnes et tables ajoutées restent.

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'posts' and column_name = 'schedule_token')
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'studio_variants' and column_name = 'push_attempt') then
    raise exception 'migration_0010_requires_0009: appliquez d''abord la migration 0009.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. B2 — trace durable de chaque changement de propriétaire d'un canal
-- ---------------------------------------------------------------------------

create table if not exists public.channel_owner_history (
  id bigint generated always as identity primary key,
  channel_id uuid not null references public.channels (id),
  from_organization_id uuid references public.organizations (id),
  to_organization_id uuid references public.organizations (id),
  -- first_assignment : jamais attribué avant ; transfer : autre client ; detach : retiré ; reattach : même client.
  kind text not null check (kind in ('first_assignment', 'transfer', 'detach', 'reattach', 'backfill')),
  existing_posts integer not null default 0,
  note text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists channel_owner_history_channel_idx on public.channel_owner_history (channel_id, changed_at);

alter table public.channel_owner_history enable row level security;
revoke all on public.channel_owner_history from anon, authenticated;
grant select on public.channel_owner_history to authenticated;
drop policy if exists channel_owner_history_select on public.channel_owner_history;
create policy channel_owner_history_select on public.channel_owner_history for select to authenticated
  using ((select private.is_admin()));

-- Quelle que soit la voie d'écriture (fonction d'administration, SQL direct, ancien code), un changement de
-- propriétaire est enregistré et marque le canal comme transféré. Il n'y a plus de dépendance au nombre
-- de publications déjà importées : une publication ancienne découverte plus tard reste donc « ambiguë ».
create or replace function private.channel_owner_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_previous uuid;
  v_kind text;
begin
  if new.organization_id is not distinct from old.organization_id then
    return new;
  end if;
  v_previous := coalesce(old.organization_id, old.last_organization_id);
  if new.organization_id is null then
    v_kind := 'detach';
    new.last_organization_id := v_previous;
  elsif v_previous is null then
    v_kind := 'first_assignment';
    new.last_organization_id := new.organization_id;
  elsif v_previous <> new.organization_id then
    v_kind := 'transfer';
    -- Jamais remis à NULL ensuite : le détachement puis le rattachement ne réinitialisent pas la protection.
    new.visible_from := now();
    new.last_organization_id := new.organization_id;
  else
    v_kind := 'reattach';
    new.last_organization_id := new.organization_id;
  end if;
  insert into public.channel_owner_history (channel_id, from_organization_id, to_organization_id, kind, existing_posts, changed_by)
  values (new.id, v_previous, new.organization_id, v_kind,
          (select count(*)::int from public.posts p where p.channel_id = new.id), (select auth.uid()));
  return new;
end;
$$;

drop trigger if exists channels_owner_guard on public.channels;
create trigger channels_owner_guard before update on public.channels
  for each row execute function private.channel_owner_guard();

-- Reprise de l'existant : un canal dont des publications attribuées ont un autre propriétaire que le
-- canal a forcément changé de main sans laisser de marque (0009 ne la posait qu'avec un historique).
with changed as (
  update public.channels c set visible_from = now()
  where c.visible_from is null and exists (
    select 1 from public.posts p
    where p.channel_id = c.id and p.ownership = 'assigned'
      and p.owner_organization_id is distinct from coalesce(c.organization_id, c.last_organization_id)
  )
  returning c.id, c.organization_id, c.last_organization_id
)
insert into public.channel_owner_history (channel_id, to_organization_id, kind, note)
select id, coalesce(organization_id, last_organization_id), 'backfill', 'Transfert non enregistré déduit de propriétaires de publications différents.'
from changed;

-- Attribution d'un canal : le transfert est détecté sur le changement de client, pas sur l'historique local.
-- La confirmation reste exigée dès qu'un historique existe ; sans historique, la trace est tout de même posée.
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
    update public.channels set organization_id = null where id = p_channel_id;
    return jsonb_build_object('transferred', false, 'hidden_posts', 0, 'suspended_posts', v_suspended);
  end if;

  if not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;

  select count(*) into v_history from public.posts where channel_id = p_channel_id;
  v_transfer := v_previous is not null and v_previous <> p_organization_id;
  if v_transfer and v_history > 0 and not coalesce(p_confirm_transfer, false) then
    raise exception 'transfer_confirmation_required';
  end if;

  if v_transfer or (v_channel.organization_id is not null and v_channel.organization_id <> p_organization_id) then
    v_suspended := private.suspend_posts(p_channel_id, null, 'canal transféré à un autre client');
  end if;

  -- Le déclencheur channels_owner_guard pose visible_from, last_organization_id et la trace.
  update public.channels set organization_id = p_organization_id where id = p_channel_id;

  -- Première attribution d'un canal jamais attribué : l'administrateur adopte l'historique existant.
  if v_previous is null then
    update public.posts set owner_organization_id = p_organization_id, ownership = 'assigned'
    where channel_id = p_channel_id and ownership = 'unassigned' and owner_organization_id is null;
  end if;

  return jsonb_build_object('transferred', v_transfer, 'hidden_posts', case when v_transfer then v_history else 0 end, 'suspended_posts', v_suspended);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. B3 — approbations d'un membre retiré
-- ---------------------------------------------------------------------------

-- L'approbateur est-il encore habilité (membre du client propriétaire, rôle client) ?
create or replace function private.approver_is_valid(p_user_id uuid, p_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and p_organization_id is not null and exists (
    select 1 from public.organization_members m
    join public.profiles pr on pr.id = m.user_id and pr.role = 'client'
    where m.user_id = p_user_id and m.organization_id = p_organization_id
  );
$$;

-- Retire les approbations d'un utilisateur pour un client. La publication repasse « à valider » ; une
-- programmation déjà acceptée par Buffer passe en « annulation à confirmer » (jamais présentée comme annulée).
create or replace function private.revoke_member_approvals(p_user_id uuid, p_organization_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_post public.posts%rowtype;
  v_count integer := 0;
begin
  for v_post in
    select * from public.posts p
    where p.approved_by = p_user_id and p.approved_organization_id = p_organization_id
      and p.approval_status = 'approved' and p.removed_at is null
      and p.buffer_status in ('draft', 'needs_approval', 'scheduled')
    for update
  loop
    update public.posts set
      approval_status = 'pending', submitted_at = now(),
      approved_hash = null, approved_version = null, approved_at = null, approved_by = null, approved_organization_id = null,
      schedule_state = case
        when v_post.schedule_state in ('claimed', 'scheduled', 'unschedule_pending') or v_post.buffer_status = 'scheduled' then 'unschedule_pending'
        else 'idle' end,
      schedule_token = null, schedule_claimed_hash = null, schedule_claimed_version = null, schedule_attempts = 0,
      schedule_error = case
        when v_post.schedule_state in ('claimed', 'scheduled', 'unschedule_pending') or v_post.buffer_status = 'scheduled'
          then 'Validation retirée (' || left(p_reason, 100) || ') : l''annulation de la programmation dans Buffer reste à confirmer.'
        else null end
    where id = v_post.id;
    perform private.add_event(v_post.id, 'approval_revoked', null, left(p_reason, 200), v_post.version);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function private.on_member_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.revoke_member_approvals(old.user_id, old.organization_id, 'membre retiré du client');
  return old;
end;
$$;

drop trigger if exists organization_members_revoke_approvals on public.organization_members;
create trigger organization_members_revoke_approvals after delete on public.organization_members
  for each row execute function private.on_member_removed();

-- ---------------------------------------------------------------------------
-- 3. B4 — réservation et confirmation de programmation
-- ---------------------------------------------------------------------------

drop function if exists public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer);
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
      -- L'approbateur doit être, au moment de la réservation, un membre habilité du client propriétaire.
      and private.approver_is_valid(c.approved_by, c.owner_organization_id)
      and ch.organization_id = c.owner_organization_id
      and o.archived_at is null
      and c.buffer_status = 'draft'
      and c.removed_at is null
      -- Chaîne de marges : Studio 15 min > approbation 10 min > réservation 5 min (voir src/lib/domain/schedule-margins.ts).
      and c.due_at > now() + interval '5 minutes'
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

-- Confirmation d'une réservation. Réponses :
--   'scheduled'  : réservation courante, toujours valable ;
--   'failed'     : échec certain constaté pour la réservation courante ;
--   'stale'      : Buffer a peut-être programmé une opération périmée → le post est (ou reste) « annulation à
--                  confirmer » ; l'appelant doit compenser immédiatement ;
--   'superseded' : une réservation plus récente est en cours, c'est elle qui décidera ;
--   'ignored'    : rien à faire.
-- Le jeton est OBLIGATOIRE : une confirmation sans jeton n'a aucun effet sur une réservation.
drop function if exists public.complete_scheduling(text, uuid, boolean, text, uuid);
create or replace function public.complete_scheduling(p_secret text, p_post_id uuid, p_ok boolean, p_error text default null, p_token uuid default null)
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

  if not v_token_ok then
    if not coalesce(p_ok, false) then return 'ignored'; end if;
    -- Succès annoncé par une opération qui n'est plus la réservation courante.
    if v_post.buffer_status in ('sent', 'sending', 'error') or v_post.removed_at is not null then return 'ignored'; end if;
    if v_post.schedule_state = 'claimed' then return 'superseded'; end if;
    if v_post.schedule_state = 'unschedule_pending' then
      -- Buffer a accepté une opération que la validation a déjà rendue caduque : on garde la trace de l'état externe.
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
    -- Buffer a pu programmer un contenu que plus rien ne valide : annulation à confirmer.
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

-- La compensation la plus proche de l'échéance passe en premier.
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
-- 4. Quota : pauses longues conservées, jamais raccourcies par une fin d'exécution
-- ---------------------------------------------------------------------------

alter table public.sync_state add column if not exists backoff_set_at timestamptz;

create or replace function public.set_sync_backoff(p_secret text, p_mode text, p_seconds integer, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  insert into public.sync_state (mode) values (p_mode) on conflict (mode) do nothing;
  -- 30 jours : la plus longue fenêtre de quota de Buffer.
  update public.sync_state set
    backoff_until = greatest(coalesce(backoff_until, now()), now() + make_interval(secs => greatest(1, least(coalesce(p_seconds, 0), 2592000)))),
    backoff_reason = left(coalesce(p_reason, 'Quota de requêtes Buffer atteint.'), 300),
    backoff_set_at = now(),
    updated_at = now()
  where mode = p_mode;
end;
$$;

-- Pause de quota en cours pour un mode, ou NULL. Lue par les actions qui écrivent dans Buffer (envoi du Studio,
-- changement de date, programmation après approbation) : elles ne doivent pas ignorer une pause.
create or replace function public.get_sync_pause(p_secret text, p_mode text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_state public.sync_state%rowtype;
begin
  perform private.check_secret(p_secret);
  select * into v_state from public.sync_state where mode = p_mode;
  if not found or v_state.backoff_until is null or v_state.backoff_until <= now() then return null; end if;
  return jsonb_build_object('until', v_state.backoff_until, 'reason', v_state.backoff_reason);
end;
$$;

create or replace function public.finish_sync_run(
  p_secret text, p_mode text, p_token uuid, p_ok boolean, p_error text default null,
  p_backoff_seconds integer default 0, p_backoff_reason text default null, p_anomalies jsonb default '[]'::jsonb
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
    -- Une pause posée PENDANT cette exécution (autre action isolée) est conservée, même plus courte ; une pause
    -- plus longue déjà en place n'est jamais raccourcie. Une exécution réussie lève seulement une pause antérieure.
    backoff_reason = case
      when v_new is not null and (backoff_until is null or backoff_until <= v_new) then left(p_backoff_reason, 300)
      when backoff_until is not null and backoff_until > now() and (v_new is not null or backoff_set_at >= last_started_at) then backoff_reason
      end,
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
-- 5. B5 — notifications : revalidation à chaque réservation, restitution d'une notification non remise
-- ---------------------------------------------------------------------------

-- Une notification est-elle encore légitime ? (destinataire, publication, client, version, préférences.)
create or replace function private.notification_is_eligible(p_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  n public.notifications%rowtype;
begin
  select * into n from public.notifications where id = p_id;
  if not found then return false; end if;
  if not exists (select 1 from public.profiles pr where pr.id = n.recipient_id) then return false; end if;
  if not exists (select 1 from public.posts p where p.id = n.post_id and p.removed_at is null) then return false; end if;
  if n.kind = 'review_requested' then
    return exists (
      select 1 from public.posts p
      join public.organization_members m on m.user_id = n.recipient_id and m.organization_id = p.owner_organization_id
      join public.profiles pr on pr.id = n.recipient_id and pr.role = 'client'
      where p.id = n.post_id
        and p.approval_status = 'pending'
        and p.version = n.post_version
        and p.buffer_status = 'draft'
        and n.organization_id is not distinct from p.owner_organization_id
        and private.is_post_reviewable(p.owner_organization_id, p.ownership, p.channel_id)
    ) and coalesce((select np.review_requested from public.notification_preferences np where np.user_id = n.recipient_id), true);
  end if;
  return exists (select 1 from public.profiles pr where pr.id = n.recipient_id and pr.role = 'admin')
    and case n.kind
      when 'changes_requested' then coalesce((select np.changes_requested from public.notification_preferences np where np.user_id = n.recipient_id), true)
      when 'approved' then coalesce((select np.approved from public.notification_preferences np where np.user_id = n.recipient_id), false)
      else coalesce((select np.schedule_error from public.notification_preferences np where np.user_id = n.recipient_id), true)
    end;
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

  -- Toute notification encore à remettre qui n'est plus légitime est annulée, jamais envoyée.
  update public.notifications n set status = 'cancelled', error = 'Destinataire ou publication plus éligible au moment de l''envoi.'
  where n.mode = p_mode
    and (n.status = 'pending' or (n.status = 'failed' and n.attempts < 5)
         or (n.status = 'sending' and n.claimed_at < now() - interval '10 minutes'))
    and not private.notification_is_eligible(n.id);

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

-- 'released' : réservée mais pas remise (le lot est traité un message à la fois, avec revalidation avant chacun).
create or replace function public.complete_notifications(p_secret text, p_ids uuid[], p_status text, p_error text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.check_secret(p_secret);
  if p_status is null or p_status not in ('sent', 'simulated', 'failed', 'released') then raise exception 'invalid_status'; end if;
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
-- 6. B6 — envoi Studio : abandon, résultat inconnu et absence jamais déduits
-- ---------------------------------------------------------------------------

drop function if exists public.studio_claim_push(uuid, boolean);
create or replace function public.studio_claim_push(p_draft_id uuid, p_force boolean default false)
returns table (
  variant_id uuid, channel_id uuid, buffer_channel_id text, service text, text text, buffer_post_id text, revision integer,
  due_at timestamptz, hashtags text[], media_ids uuid[], organization_id uuid
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
  -- Résultat inconnu OU envoi abandonné (processus arrêté après l'appel Buffer, avant l'enregistrement local) :
  -- Buffer a peut-être créé le brouillon. Aucune nouvelle création, forcée ou non, tant que l'envoi n'est
  -- pas résolu (adopté ou confirmé absent par une personne). Les variantes retirées comptent aussi.
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
    -- Tout ce qui permet de retrouver le brouillon dans Buffer plus tard, même si la variante est retirée.
    push_attempt = jsonb_build_object(
      'text', v.text, 'dueAt', v_draft.due_at, 'hashtags', to_jsonb(v_draft.hashtags), 'revision', v_draft.revision,
      'bufferChannelId', c.buffer_channel_id, 'service', c.service, 'priorBufferPostId', v.buffer_post_id,
      'assetKinds', v_kinds, 'organizationId', v_draft.organization_id, 'draftId', v_draft.id, 'claimedAt', now())
  from public.channels c
  where c.id = v.channel_id and v.draft_id = p_draft_id and v.removed_at is null
    and (v.push_state in ('idle', 'failed') or v.pushed_revision is distinct from v_draft.revision)
  returning v.id, v.channel_id, c.buffer_channel_id, c.service, v.text, v.buffer_post_id, v_draft.revision,
            v_draft.due_at, v_draft.hashtags, v_draft.media_ids, v_draft.organization_id;
end;
$$;

-- p_uncertain : la réponse de Buffer a été perdue. Le brouillon a peut-être été créé : « unknown », même si un
-- ancien identifiant (peut-être supprimé dans Buffer) est connu en base. L'appelant ne transmet p_buffer_post_id
-- que pour un post réellement CRÉÉ ou mis à jour : il est alors conservé et l'état n'est plus « inconnu ».
drop function if exists public.studio_complete_push(uuid, boolean, text, text, integer, boolean);
create or replace function public.studio_complete_push(
  p_variant_id uuid, p_ok boolean, p_buffer_post_id text default null, p_error text default null, p_revision integer default null,
  p_uncertain boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_draft uuid;
  v_unknown boolean := not coalesce(p_ok, false) and coalesce(p_uncertain, false) and p_buffer_post_id is null;
begin
  perform private.require_admin();
  update public.studio_variants set
    push_state = case when p_ok then 'pushed' when v_unknown then 'unknown' else 'failed' end,
    buffer_post_id = coalesce(p_buffer_post_id, buffer_post_id),
    push_error = case when p_ok then null else left(coalesce(p_error, 'Erreur inconnue'), 500) end,
    pushed_revision = case when p_ok then p_revision else pushed_revision end,
    pushed_at = case when p_ok then now() else pushed_at end,
    push_unknown_at = case when p_ok then null when v_unknown then now() else push_unknown_at end,
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

-- Envois abandonnés : « pushing » ancien → « unknown » (c'est ce qu'ils sont). Appelée avant toute réconciliation.
create or replace function public.studio_expire_abandoned(p_draft_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.require_admin();
  update public.studio_variants set push_state = 'unknown', push_unknown_at = coalesce(push_claimed_at, now()),
    push_error = 'Envoi interrompu : le brouillon existe peut-être dans Buffer. Vérification requise avant tout renvoi.',
    updated_at = now()
  where draft_id = p_draft_id and push_state = 'pushing' and push_claimed_at <= now() - interval '5 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Résolution d'un envoi dont le résultat est inconnu :
--   p_buffer_post_id : brouillon retrouvé → adopté (jamais recréé) ;
--   p_confirmed_absent : Cadence ne peut PAS prouver l'absence (recherche partielle, texte modifié dans Buffer,
--     médias). Seule une personne qui a vérifié dans Buffer peut l'affirmer : p_operator_confirmed est exigé.
drop function if exists public.studio_resolve_unknown(uuid, text, boolean);
create or replace function public.studio_resolve_unknown(
  p_variant_id uuid, p_buffer_post_id text default null, p_confirmed_absent boolean default false, p_operator_confirmed boolean default false
) returns text language plpgsql security definer set search_path = '' as $$
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
    if not coalesce(p_operator_confirmed, false) then raise exception 'absence_requires_operator'; end if;
    update public.studio_variants set push_state = 'failed',
      push_error = 'Absence du brouillon confirmée manuellement dans Buffer : renvoi possible.',
      push_unknown_at = null, updated_at = now()
    where id = p_variant_id;
    perform private.add_studio_note(p_variant_id);
    return 'retry_allowed';
  end if;
  return 'unchanged';
end;
$$;

-- Trace de la confirmation manuelle (qui, quand) dans la tentative conservée.
create or replace function private.add_studio_note(p_variant_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.studio_variants set push_attempt = coalesce(push_attempt, '{}'::jsonb)
    || jsonb_build_object('absenceConfirmedBy', (select auth.uid()), 'absenceConfirmedAt', now())
  where id = p_variant_id;
$$;

-- ---------------------------------------------------------------------------
-- 7. Droits
-- ---------------------------------------------------------------------------

revoke execute on function
  private.channel_owner_guard(),
  private.approver_is_valid(uuid, uuid),
  private.revoke_member_approvals(uuid, uuid, text),
  private.on_member_removed(),
  private.notification_is_eligible(uuid),
  private.add_studio_note(uuid)
from public, anon, authenticated;

revoke execute on function
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer, boolean),
  public.studio_expire_abandoned(uuid),
  public.studio_resolve_unknown(uuid, text, boolean, boolean)
from public, anon;
grant execute on function
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer, boolean),
  public.studio_expire_abandoned(uuid),
  public.studio_resolve_unknown(uuid, text, boolean, boolean)
to authenticated;

revoke execute on function
  public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer),
  public.claim_posts_for_scheduling(text, uuid, integer),
  public.complete_scheduling(text, uuid, boolean, text, uuid),
  public.list_posts_to_unschedule_in_mode(text, text),
  public.set_sync_backoff(text, text, integer, text),
  public.get_sync_pause(text, text),
  public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb),
  public.claim_notifications(text, text, integer),
  public.complete_notifications(text, uuid[], text, text)
from public;
grant execute on function
  public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer),
  public.claim_posts_for_scheduling(text, uuid, integer),
  public.complete_scheduling(text, uuid, boolean, text, uuid),
  public.list_posts_to_unschedule_in_mode(text, text),
  public.set_sync_backoff(text, text, integer, text),
  public.get_sync_pause(text, text),
  public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb),
  public.claim_notifications(text, text, integer),
  public.complete_notifications(text, uuid[], text, text)
to anon, authenticated;

commit;
