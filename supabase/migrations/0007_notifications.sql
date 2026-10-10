-- Cadence — notifications (9 octobre 2026)
-- Vérifiée sur une base PostgreSQL locale en mémoire (npm run test), NON appliquée à Supabase.
-- À appliquer après 0006. Ajoute deux tables, un déclencheur et quatre fonctions.
-- Aucune donnée existante n'est modifiée ; aucune notification n'est créée pour le passé.
--
-- Principe : chaque événement de l'historique d'une publication (post_events) peut mettre une
-- notification en file d'attente. La base ne sait pas envoyer d'e-mail : le serveur de l'application
-- réserve les notifications en attente, les regroupe par destinataire et les remet (ou les simule).
--
--   Publication soumise ou à revalider      → utilisateurs du client      (review_requested)
--   Modifications demandées par le client   → administrateurs             (changes_requested)
--   Publication approuvée                   → administrateurs, facultatif (approved)
--   Échec de programmation ou de publication→ administrateurs             (schedule_error)

begin;

create table if not exists public.notification_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  review_requested boolean not null default true,
  changes_requested boolean not null default true,
  approved boolean not null default false,
  schedule_error boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('review_requested', 'changes_requested', 'approved', 'schedule_error')),
  -- Les publications simulées (« mock- ») ne déclenchent jamais d'envoi réel.
  mode text not null check (mode in ('real', 'mock')),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  post_id uuid not null references public.posts (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  post_version integer not null,
  -- Anti-doublon : un même fait n'est notifié qu'une fois à une même personne.
  dedupe_key text not null unique,
  detail text,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'simulated', 'failed', 'cancelled')),
  attempts integer not null default 0,
  error text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists notifications_queue_idx on public.notifications (mode, status, created_at);
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_post_idx on public.notifications (post_id);
create index if not exists notifications_organization_idx on public.notifications (organization_id);

alter table public.notification_preferences enable row level security;
alter table public.notifications enable row level security;
revoke all on public.notification_preferences, public.notifications from anon, authenticated;
grant select on public.notification_preferences, public.notifications to authenticated;

-- Chacun lit ses préférences et son historique ; l'administrateur voit tout.
drop policy if exists notification_preferences_select on public.notification_preferences;
create policy notification_preferences_select on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()) or (select private.is_admin()));

-- ---------------------------------------------------------------------------
-- Mise en file d'attente
-- ---------------------------------------------------------------------------

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

drop trigger if exists post_events_notify on public.post_events;
create trigger post_events_notify after insert on public.post_events
  for each row execute function private.enqueue_notifications();

-- ---------------------------------------------------------------------------
-- Préférences : chacun règle les siennes
-- ---------------------------------------------------------------------------

create or replace function public.set_notification_preferences(
  p_review_requested boolean default null, p_changes_requested boolean default null,
  p_approved boolean default null, p_schedule_error boolean default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'not_authenticated';
  end if;
  insert into public.notification_preferences (user_id) values (v_uid) on conflict (user_id) do nothing;
  update public.notification_preferences set
    review_requested = coalesce(p_review_requested, review_requested),
    changes_requested = coalesce(p_changes_requested, changes_requested),
    approved = coalesce(p_approved, approved),
    schedule_error = coalesce(p_schedule_error, schedule_error),
    updated_at = now()
  where user_id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Remise : réservation atomique, pour qu'une notification ne parte jamais deux fois
-- ---------------------------------------------------------------------------

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

create or replace function public.complete_notifications(p_secret text, p_ids uuid[], p_status text, p_error text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.check_secret(p_secret);
  if p_status is null or p_status not in ('sent', 'simulated', 'failed') then raise exception 'invalid_status'; end if;
  update public.notifications set
    status = p_status,
    error = case when p_status = 'failed' then left(coalesce(p_error, 'Erreur inconnue'), 500) end,
    sent_at = case when p_status = 'failed' then null else now() end
  where id = any (p_ids) and status = 'sending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function private.enqueue_notifications() from public, anon, authenticated;
revoke execute on function public.set_notification_preferences(boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_notification_preferences(boolean, boolean, boolean, boolean) to authenticated;
revoke execute on function public.claim_notifications(text, text, integer) from public;
revoke execute on function public.complete_notifications(text, uuid[], text, text) from public;
-- Fonctions d'automatisation : protégées par le secret partagé, appelables sans session utilisateur.
grant execute on function public.claim_notifications(text, text, integer) to anon, authenticated;
grant execute on function public.complete_notifications(text, uuid[], text, text) to anon, authenticated;

commit;
