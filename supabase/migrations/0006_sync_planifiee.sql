-- Cadence — synchronisation planifiée (9 octobre 2026)
-- Vérifiée sur une base PostgreSQL locale en mémoire (npm run test), NON appliquée à Supabase.
-- À appliquer après 0005. Ajoute une table et deux fonctions ; aucune donnée existante n'est modifiée.
--
-- 1. Verrou : une seule synchronisation à la fois par mode, même si le planificateur, le bouton
--    et n8n se déclenchent en même temps. Un verrou jamais rendu (serveur arrêté en cours de route)
--    expire tout seul.
-- 2. État : dernier démarrage, dernier succès, dernier échec, anomalies de la dernière exécution.
-- 3. Pause : après un quota Buffer atteint ou presque épuisé, les exécutions planifiées sont
--    suspendues jusqu'à une date ; le bouton manuel reste utilisable.

begin;

create table if not exists public.sync_state (
  mode text primary key check (mode in ('real', 'mock')),
  lock_token uuid,
  locked_until timestamptz,
  lock_triggered_by text,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  -- Dernier déclenchement par le planificateur : permet de voir s'il tourne.
  last_scheduled_at timestamptz,
  backoff_until timestamptz,
  backoff_reason text,
  anomalies jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sync_state enable row level security;
revoke all on public.sync_state from anon, authenticated;
grant select on public.sync_state to authenticated;

drop policy if exists sync_state_select on public.sync_state;
create policy sync_state_select on public.sync_state for select to authenticated
  using ((select private.is_admin()));

-- Demande le droit de synchroniser. Réponse : { acquired, token } ou { acquired: false, reason, until }.
create or replace function public.begin_sync_run(
  p_secret text, p_mode text, p_triggered_by text default 'manual', p_scheduled boolean default false, p_ttl_seconds integer default 300
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.sync_state%rowtype;
  v_token uuid := gen_random_uuid();
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;

  insert into public.sync_state (mode) values (p_mode) on conflict (mode) do nothing;
  -- Verrou de ligne : deux demandes simultanées sont traitées l'une après l'autre.
  select * into v_state from public.sync_state where mode = p_mode for update;

  if v_state.locked_until is not null and v_state.locked_until > now() then
    return jsonb_build_object('acquired', false, 'reason', 'running', 'until', v_state.locked_until);
  end if;
  if coalesce(p_scheduled, false) and v_state.backoff_until is not null and v_state.backoff_until > now() then
    return jsonb_build_object('acquired', false, 'reason', 'backoff', 'until', v_state.backoff_until, 'detail', v_state.backoff_reason);
  end if;

  update public.sync_state set
    lock_token = v_token,
    locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_ttl_seconds, 300), 900))),
    lock_triggered_by = left(coalesce(p_triggered_by, 'manual'), 60),
    last_started_at = now(),
    last_scheduled_at = case when coalesce(p_scheduled, false) then now() else last_scheduled_at end,
    updated_at = now()
  where mode = p_mode;
  return jsonb_build_object('acquired', true, 'token', v_token);
end;
$$;

-- Rend le verrou et enregistre le résultat. Sans effet si le verrou a expiré et a été repris par une autre exécution.
create or replace function public.finish_sync_run(
  p_secret text, p_mode text, p_token uuid, p_ok boolean, p_error text default null,
  p_backoff_seconds integer default 0, p_backoff_reason text default null, p_anomalies jsonb default '[]'::jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
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
    backoff_until = case when coalesce(p_backoff_seconds, 0) > 0 then now() + make_interval(secs => least(p_backoff_seconds, 86400)) end,
    backoff_reason = case when coalesce(p_backoff_seconds, 0) > 0 then left(p_backoff_reason, 300) end,
    anomalies = case when jsonb_typeof(p_anomalies) = 'array' then p_anomalies else '[]'::jsonb end,
    updated_at = now()
  where mode = p_mode and lock_token = p_token;
  return found;
end;
$$;

revoke execute on function public.begin_sync_run(text, text, text, boolean, integer) from public;
revoke execute on function public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb) from public;
-- Fonctions d'automatisation : protégées par le secret partagé, appelables sans session utilisateur.
grant execute on function public.begin_sync_run(text, text, text, boolean, integer) to anon, authenticated;
grant execute on function public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb) to anon, authenticated;

commit;
