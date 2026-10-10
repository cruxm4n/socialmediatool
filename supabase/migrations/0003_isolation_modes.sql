-- Préparée localement, NON appliquée par la session Codex.
-- Appliquer dans une base de test isolée avant de lancer l'application modifiée.
-- Les anciennes signatures restent compatibles et ne traitent désormais que le mode réel.
begin;

-- Empreinte sans concaténation ambiguë : l'instant exact et chaque média ordonné comptent.
create or replace function private.post_hash(p_text text, p_due_at timestamptz, p_channel text, p_assets jsonb)
returns text language sql immutable set search_path = '' as $$
  select md5(jsonb_build_object(
    'text', coalesce(p_text, ''),
    'dueAt', to_char(p_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    'channel', coalesce(p_channel, ''),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_array(a.value ->> 'type', a.value ->> 'source') order by a.ordinality)
      from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) with ordinality as a
    ), '[]'::jsonb)
  )::text);
$$;

-- Recalculer l'empreinte de la version stockée sans annuler les validations encore cohérentes.
-- Les anciennes décisions restent inchangées dans l'historique.
with hashes as materialized (
  select p.id, private.post_hash(p.text, p.due_at, c.buffer_channel_id, p.assets) as new_hash
  from public.posts p join public.channels c on c.id = p.channel_id
)
update public.posts p set
  approved_hash = case when p.approved_hash = p.content_hash then h.new_hash else p.approved_hash end,
  content_hash = h.new_hash
from hashes h where p.id = h.id;

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

create or replace function public.list_posts_to_unschedule_in_mode(p_secret text, p_mode text)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return query
  select p.id, p.buffer_post_id, p.text, p.assets, p.due_at, p.service
  from public.posts p where (case when p_mode = 'mock' then p.buffer_post_id like 'mock-%' else p.buffer_post_id not like 'mock-%' end)
    and p.schedule_state = 'unschedule_pending' and p.removed_at is null;
end;
$$;

create or replace function public.claim_posts_for_scheduling(p_secret text, p_post_id uuid default null, p_limit integer default 10)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text, version integer)
language sql security definer set search_path = '' as $$
  select * from public.claim_posts_for_scheduling_in_mode(p_secret, 'real', p_post_id, p_limit);
$$;

create or replace function public.list_posts_to_unschedule(p_secret text)
returns table (id uuid, buffer_post_id text, text text, assets jsonb, due_at timestamptz, service text)
language sql security definer set search_path = '' as $$
  select * from public.list_posts_to_unschedule_in_mode(p_secret, 'real');
$$;

revoke execute on function public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer) from public;
revoke execute on function public.list_posts_to_unschedule_in_mode(text, text) from public;
grant execute on function public.claim_posts_for_scheduling_in_mode(text, text, uuid, integer) to anon, authenticated;
grant execute on function public.list_posts_to_unschedule_in_mode(text, text) to anon, authenticated;

commit;
