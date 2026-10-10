-- Cadence — connexions fournisseur par client (migration 0012)
-- Vérifiée sur PGlite et sur PostgreSQL 17 (pile isolée, copie restaurée de la production). NON appliquée à la
-- production ni au projet Supabase hébergé. À appliquer après 0011. Aucune migration précédente n'est réécrite ;
-- aucune donnée n'est supprimée ; les colonnes ajoutées sont nulles ou remplies par reprise.
--
-- Modèle : Organisation → Connexion fournisseur → Canaux → Publications.
--   provider_connections     une connexion = un compte chez le fournisseur (Buffer), réel ou simulé. Elle appartient à
--                            UN client (organization_id) ou elle est « partagée » (organization_id nul : le compte
--                            historique de l'agence, qui sert plusieurs clients).
--   private.provider_credentials   le secret de la connexion, CHIFFRÉ par le serveur avant l'écriture (AES-256-GCM,
--                            clé hors base). Schéma privé : invisible de l'API, d'un client et du navigateur.
--   provider_connection_events     journal des opérations (création, clé remplacée, révocation), sans aucune valeur secrète.
--   channels.provider_connection_id   la connexion d'origine d'un canal : posée une fois, JAMAIS modifiée.
--
-- Garanties posées dans la base (et non dans l'interface) :
--   - un canal ne change jamais de connexion ; un canal déjà connu sous une connexion est refusé s'il est annoncé
--     par une autre (aucune fusion entre comptes) ;
--   - un canal d'une connexion appartenant à un client ne peut être attribué qu'à CE client ;
--   - la lecture d'une connexion ne retire que les publications de CETTE connexion (une connexion en panne ou
--     révoquée ne fait jamais « disparaître » ses publications) ;
--   - une connexion ne peut pas être révoquée tant que des effets externes ne sont pas rapprochés (programmations,
--     annulations à confirmer, envois incertains), sauf décision explicite et tracée ;
--   - le secret d'une connexion révoquée est effacé ; l'historique reste.
--
-- Politique de rejeu : rejouable (if not exists / create or replace). Retour arrière : voir
-- supabase/outils/0012_retour_arriere.sql (aucune donnée supprimée ; les colonnes restent, inutilisées).

begin;

do $$
begin
  if to_regprocedure('public.schema_status(text)') is null or to_regclass('public.studio_push_events') is null then
    raise exception 'La migration 0011 doit être appliquée avant 0012.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'buffer' check (provider in ('buffer')),
  mode text not null check (mode in ('real', 'mock')),
  -- nul : connexion partagée (compte de l'agence) ; sinon le client propriétaire de ce compte.
  organization_id uuid references public.organizations (id) on delete restrict,
  label text not null check (length(trim(label)) between 1 and 80),
  status text not null default 'active' check (status in ('active', 'revoked')),
  -- « none » : compte simulé, aucun secret ; « environment » : clé du serveur (compte historique, variable
  -- BUFFER_API_KEY) ; « stored » : secret chiffré dans private.provider_credentials.
  credential_source text not null check (credential_source in ('none', 'environment', 'stored')),
  -- Compte simulé : suffixe qui isole ses identifiants. Compte réel : identifiant du compte constaté chez le fournisseur.
  account_key text check (account_key is null or account_key ~ '^[a-z0-9]{1,24}$'),
  external_account_id text,
  external_account_label text,
  is_default boolean not null default false,
  last_verified_at timestamptz,
  last_sync_at timestamptz,
  last_sync_ok boolean,
  last_error text,
  paused_until timestamptz,
  pause_reason text,
  rate_limit jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  constraint provider_connections_source_check check (
    (mode = 'mock' and credential_source = 'none') or (mode = 'real' and credential_source in ('environment', 'stored'))
  ),
  constraint provider_connections_revoked_check check ((status = 'revoked') = (revoked_at is not null))
);
create index if not exists provider_connections_org_idx on public.provider_connections (organization_id);
-- Une seule connexion par défaut par mode ; une seule connexion active tirant sa clé du serveur.
create unique index if not exists provider_connections_default_idx on public.provider_connections (mode) where is_default;
create unique index if not exists provider_connections_environment_idx on public.provider_connections (credential_source)
  where credential_source = 'environment' and status = 'active';
-- Deux comptes simulés ne partagent jamais leur suffixe (leurs identifiants se mélangeraient).
create unique index if not exists provider_connections_account_key_idx on public.provider_connections (mode, account_key)
  where account_key is not null and mode = 'mock';

create table if not exists private.provider_credentials (
  connection_id uuid primary key references public.provider_connections (id) on delete restrict,
  ciphertext text not null check (ciphertext like 'v1.%'),
  key_version integer not null default 1,
  -- Quatre derniers caractères au plus, pour reconnaître la clé sans la révéler.
  hint text check (hint is null or length(hint) <= 4),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.provider_connection_events (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.provider_connections (id) on delete restrict,
  type text not null check (type in ('created', 'credential_replaced', 'verified', 'revoked', 'revoke_refused', 'collision')),
  actor_id uuid references auth.users (id) on delete set null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists provider_connection_events_conn_idx on public.provider_connection_events (connection_id, created_at desc);

alter table public.channels add column if not exists provider_connection_id uuid references public.provider_connections (id) on delete restrict;
create index if not exists channels_provider_connection_idx on public.channels (provider_connection_id);

-- ---------------------------------------------------------------------------
-- 2. Reprise de l'existant : rien n'est deviné, chaque canal reçoit la connexion de son mode
-- ---------------------------------------------------------------------------

-- Compte simulé de démonstration : toujours présent (aucun secret, aucun appel externe).
insert into public.provider_connections (mode, label, credential_source, is_default)
select 'mock', 'Buffer simulé (démonstration)', 'none', true
where not exists (select 1 from public.provider_connections where mode = 'mock' and is_default);

-- Compte réel historique : créé seulement s'il existe des canaux réels. Sa clé reste celle du serveur, explicitement.
insert into public.provider_connections (mode, label, credential_source, is_default)
select 'real', 'Compte Buffer historique (clé du serveur)', 'environment', true
where exists (select 1 from public.channels where buffer_channel_id not like 'mock-%')
  and not exists (select 1 from public.provider_connections where mode = 'real' and is_default);

update public.channels c set provider_connection_id = pc.id
from public.provider_connections pc
where c.provider_connection_id is null and pc.is_default
  and pc.mode = case when c.buffer_channel_id like 'mock-%' then 'mock' else 'real' end;

-- ---------------------------------------------------------------------------
-- 3. Garde-fous
-- ---------------------------------------------------------------------------

create or replace function private.guard_channel_connection() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  if tg_op = 'UPDATE' and old.provider_connection_id is not null and new.provider_connection_id is distinct from old.provider_connection_id then
    raise exception 'channel_connection_immutable' using hint = 'Un canal ne change jamais de connexion fournisseur.';
  end if;
  if new.provider_connection_id is null then return new; end if;
  select * into v_conn from public.provider_connections where id = new.provider_connection_id;
  if (new.buffer_channel_id like 'mock-%') <> (v_conn.mode = 'mock') then
    raise exception 'channel_connection_mode_mismatch';
  end if;
  -- Compte appartenant à un client : ses canaux ne peuvent servir aucun autre client.
  if v_conn.organization_id is not null and new.organization_id is not null and new.organization_id <> v_conn.organization_id then
    raise exception 'channel_connection_org_mismatch' using hint = 'Ce canal vient du compte d''un autre client.';
  end if;
  return new;
end;
$$;

drop trigger if exists channels_connection_guard on public.channels;
create trigger channels_connection_guard before insert or update of provider_connection_id, organization_id on public.channels
  for each row execute function private.guard_channel_connection();

create or replace function private.guard_provider_connection() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id <> old.id or new.provider <> old.provider or new.mode <> old.mode
     or new.organization_id is distinct from old.organization_id or new.account_key is distinct from old.account_key then
    raise exception 'provider_connection_identity_immutable' using hint = 'Créez une nouvelle connexion : l''identité d''une connexion ne change pas.';
  end if;
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'provider_connection_revoked' using hint = 'Une connexion révoquée ne se réactive pas : créez-en une nouvelle.';
  end if;
  -- Le compte constaté chez le fournisseur ne change pas non plus : une autre clé d'un autre compte = autre connexion.
  if old.external_account_id is not null and new.external_account_id is distinct from old.external_account_id then
    raise exception 'provider_account_mismatch';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists provider_connections_guard on public.provider_connections;
create trigger provider_connections_guard before update on public.provider_connections
  for each row execute function private.guard_provider_connection();

-- Effets externes non rapprochés d'une connexion (rien n'est modifié).
create or replace function private.connection_unresolved(p_connection_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'scheduled', (select count(*) from public.posts p join public.channels c on c.id = p.channel_id
                  where c.provider_connection_id = p_connection_id and p.removed_at is null
                    and (p.schedule_state = 'scheduled' or p.buffer_status = 'scheduled') and p.buffer_status not in ('sent', 'error')),
    'pending', (select count(*) from public.posts p join public.channels c on c.id = p.channel_id
                where c.provider_connection_id = p_connection_id and p.removed_at is null
                  and p.schedule_state in ('claimed', 'unschedule_pending')),
    'uncertain', (select count(*) from public.studio_variants v join public.channels c on c.id = v.channel_id
                  where c.provider_connection_id = p_connection_id and v.push_state in ('pushing', 'unknown'))
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Administration (session d'un administrateur)
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_provider_connection(
  p_id uuid, p_mode text, p_label text, p_organization_id uuid default null,
  p_credential_source text default 'none', p_ciphertext text default null, p_key_version integer default 1, p_hint text default null,
  p_account_key text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_id is null then raise exception 'invalid_connection'; end if;
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  if p_organization_id is not null and not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;
  if p_mode = 'mock' and (p_account_key is null or p_ciphertext is not null) then raise exception 'invalid_connection'; end if;
  if p_credential_source = 'stored' and (p_ciphertext is null or p_ciphertext not like 'v1.%') then raise exception 'credential_required'; end if;
  if p_credential_source <> 'stored' and p_ciphertext is not null then raise exception 'invalid_connection'; end if;

  insert into public.provider_connections (id, mode, label, organization_id, credential_source, account_key, created_by)
  values (p_id, p_mode, trim(p_label), p_organization_id, p_credential_source, case when p_mode = 'mock' then p_account_key end, (select auth.uid()));
  if p_credential_source = 'stored' then
    insert into private.provider_credentials (connection_id, ciphertext, key_version, hint, updated_by)
    values (p_id, p_ciphertext, coalesce(p_key_version, 1), left(p_hint, 4), (select auth.uid()));
  end if;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_id, 'created', (select auth.uid()), case p_credential_source when 'stored' then 'Clé enregistrée, chiffrée' when 'environment' then 'Clé du serveur' else 'Compte simulé' end);
  return p_id;
end;
$$;

-- Remplace la clé d'une connexion réelle. Le compte fournisseur constaté (p_external_account_id) doit être le MÊME :
-- changer de compte, c'est créer une autre connexion, pour ne jamais perdre la trace des publications de l'ancienne.
create or replace function public.admin_set_provider_credential(
  p_connection_id uuid, p_ciphertext text, p_key_version integer default 1, p_hint text default null, p_external_account_id text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  perform private.require_admin();
  select * into v_conn from public.provider_connections where id = p_connection_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_conn.status <> 'active' then raise exception 'provider_connection_revoked'; end if;
  if v_conn.mode <> 'real' then raise exception 'invalid_connection'; end if;
  if p_ciphertext is null or p_ciphertext not like 'v1.%' then raise exception 'credential_required'; end if;
  if v_conn.external_account_id is not null and p_external_account_id is not null and p_external_account_id <> v_conn.external_account_id then
    raise exception 'provider_account_mismatch' using hint = 'Cette clé appartient à un autre compte : créez une nouvelle connexion.';
  end if;
  insert into private.provider_credentials (connection_id, ciphertext, key_version, hint, updated_by)
  values (p_connection_id, p_ciphertext, coalesce(p_key_version, 1), left(p_hint, 4), (select auth.uid()))
  on conflict (connection_id) do update set ciphertext = excluded.ciphertext, key_version = excluded.key_version,
    hint = excluded.hint, updated_at = now(), updated_by = excluded.updated_by;
  update public.provider_connections set credential_source = 'stored', last_verified_at = null,
    external_account_id = coalesce(external_account_id, p_external_account_id) where id = p_connection_id;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_connection_id, 'credential_replaced', (select auth.uid()), 'Clé remplacée (chiffrée)');
end;
$$;

-- Révoque une connexion : plus aucune opération ne passera par elle, son secret est effacé, son historique reste.
-- Refusée tant que des effets externes ne sont pas rapprochés, sauf p_force (décision tracée de l'administrateur).
create or replace function public.admin_revoke_provider_connection(p_connection_id uuid, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.provider_connections%rowtype;
  v_open jsonb;
  v_total integer;
begin
  perform private.require_admin();
  select * into v_conn from public.provider_connections where id = p_connection_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_conn.status = 'revoked' then return jsonb_build_object('revoked', true, 'already', true); end if;
  if v_conn.is_default and v_conn.mode = 'mock' then raise exception 'default_connection' using hint = 'Le compte simulé de démonstration ne se révoque pas.'; end if;
  v_open := private.connection_unresolved(p_connection_id);
  v_total := (v_open ->> 'scheduled')::int + (v_open ->> 'pending')::int + (v_open ->> 'uncertain')::int;
  if v_total > 0 and not coalesce(p_force, false) then
    insert into public.provider_connection_events (connection_id, type, actor_id, detail)
    values (p_connection_id, 'revoke_refused', (select auth.uid()), v_open::text);
    return jsonb_build_object('revoked', false, 'unresolved', v_open);
  end if;
  update public.provider_connections set status = 'revoked', revoked_at = now(), revoked_by = (select auth.uid()), is_default = false
  where id = p_connection_id;
  -- Retrait d'un accès : le secret disparaît réellement (seule suppression de cette migration).
  delete from private.provider_credentials where connection_id = p_connection_id;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_connection_id, 'revoked', (select auth.uid()),
          case when v_total > 0 then 'Révocation FORCÉE avec effets non rapprochés : ' || v_open::text else 'Aucun effet externe en attente' end);
  return jsonb_build_object('revoked', true, 'unresolved', v_open);
end;
$$;

-- Vue d'ensemble pour l'écran Paramètres (administrateur uniquement, aucune valeur secrète).
create or replace function public.admin_provider_connections()
returns table (
  id uuid, provider text, mode text, organization_id uuid, label text, status text, credential_source text, hint text,
  account_key text, external_account_label text, is_default boolean, last_verified_at timestamptz, last_sync_at timestamptz,
  last_sync_ok boolean, last_error text, paused_until timestamptz, pause_reason text, created_at timestamptz, revoked_at timestamptz,
  channels integer, unresolved jsonb
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
  select pc.id, pc.provider, pc.mode, pc.organization_id, pc.label, pc.status, pc.credential_source, cr.hint,
         pc.account_key, pc.external_account_label, pc.is_default, pc.last_verified_at, pc.last_sync_at,
         pc.last_sync_ok, pc.last_error, pc.paused_until, pc.pause_reason, pc.created_at, pc.revoked_at,
         (select count(*)::int from public.channels c where c.provider_connection_id = pc.id),
         private.connection_unresolved(pc.id)
  from public.provider_connections pc
  left join private.provider_credentials cr on cr.connection_id = pc.id
  order by pc.status, pc.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Serveur à serveur (secret d'automatisation) : chargement, routage, état
-- ---------------------------------------------------------------------------

-- Connexions ACTIVES d'un mode, avec leur secret chiffré (déchiffré par le serveur seulement).
create or replace function public.provider_connections_for_run(p_secret text, p_mode text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pc.id, 'label', pc.label, 'organizationId', pc.organization_id, 'credentialSource', pc.credential_source,
      'ciphertext', cr.ciphertext, 'keyVersion', cr.key_version, 'accountKey', pc.account_key, 'isDefault', pc.is_default,
      'pausedUntil', case when pc.paused_until > now() then pc.paused_until end, 'pauseReason', pc.pause_reason
    ) order by pc.created_at)
    from public.provider_connections pc
    left join private.provider_credentials cr on cr.connection_id = pc.id
    where pc.mode = p_mode and pc.status = 'active'), '[]'::jsonb);
end;
$$;

-- Connexion d'origine de publications et de canaux, par leurs identifiants chez le fournisseur.
-- Une publication ou un canal inconnu, ou sans connexion, n'apparaît pas : aucun routage par défaut.
create or replace function public.provider_routes(p_secret text, p_mode text, p_post_ids text[] default '{}', p_channel_ids text[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return jsonb_build_object(
    'posts', coalesce((
      select jsonb_object_agg(p.buffer_post_id, c.provider_connection_id)
      from public.posts p join public.channels c on c.id = p.channel_id
      where p.buffer_post_id = any (coalesce(p_post_ids, '{}')) and c.provider_connection_id is not null
        and (p.buffer_post_id like 'mock-%') = (p_mode = 'mock')), '{}'::jsonb),
    'channels', coalesce((
      select jsonb_object_agg(c.buffer_channel_id, c.provider_connection_id)
      from public.channels c
      where c.buffer_channel_id = any (coalesce(p_channel_ids, '{}')) and c.provider_connection_id is not null
        and (c.buffer_channel_id like 'mock-%') = (p_mode = 'mock')), '{}'::jsonb)
  );
end;
$$;

-- État d'une connexion après une lecture ou un refus de quota. Une pause ne se raccourcit jamais.
create or replace function public.record_provider_connection_state(
  p_secret text, p_connection_id uuid, p_ok boolean, p_error text default null, p_rate_limit jsonb default null,
  p_pause_seconds integer default 0, p_pause_reason text default null, p_synced boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  update public.provider_connections set
    last_sync_at = case when p_synced then now() else last_sync_at end,
    last_sync_ok = case when p_synced then p_ok else last_sync_ok end,
    last_error = case when p_ok then null else left(coalesce(p_error, 'Erreur'), 500) end,
    rate_limit = coalesce(p_rate_limit, rate_limit),
    paused_until = case when coalesce(p_pause_seconds, 0) > 0
                        then greatest(coalesce(paused_until, now()), now() + make_interval(secs => p_pause_seconds)) else paused_until end,
    pause_reason = case when coalesce(p_pause_seconds, 0) > 0 then left(p_pause_reason, 300) else pause_reason end
  where id = p_connection_id and status = 'active';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Lecture du fournisseur : connexion d'origine posée, retraits limités aux connexions lues en entier
--    (corps de 0009 ; seules différences : connectionId, scopeConnectionIds, compteur « conflicts »)
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
  -- 0012 : connexions fournisseur. Absent du relevé (ancien appelant) : comportement inchangé.
  v_conn uuid;
  v_known_conn uuid;
  v_conflicts integer := 0;
  v_scoped boolean := p_payload ? 'scopeConnectionIds';
  v_scope uuid[] := coalesce(
    (select array_agg(value::uuid) from jsonb_array_elements_text(coalesce(p_payload -> 'scopeConnectionIds', '[]'::jsonb))), '{}');
begin
  perform private.check_secret(p_secret);

  for v_c in select * from jsonb_array_elements(coalesce(p_payload -> 'channels', '[]'::jsonb)) loop
    v_conn := nullif(v_c ->> 'connectionId', '')::uuid;
    if v_conn is not null then
      select provider_connection_id into v_known_conn from public.channels where buffer_channel_id = v_c ->> 'id';
      if found and v_known_conn is not null and v_known_conn <> v_conn then
        -- Même identifiant de canal annoncé par un AUTRE compte : jamais fusionné, jamais réattribué.
        v_conflicts := v_conflicts + 1;
        continue;
      end if;
    end if;
    insert into public.channels (buffer_channel_id, service, name, display_name, avatar_url, is_disconnected, organization_id, provider_connection_id)
    values (
      v_c ->> 'id', v_c ->> 'service', v_c ->> 'name', v_c ->> 'displayName', v_c ->> 'avatar',
      coalesce((v_c ->> 'isDisconnected')::boolean, false),
      (select id from public.organizations where slug = v_c ->> 'organizationSlug'),
      v_conn
    )
    on conflict (buffer_channel_id) do update set
      service = excluded.service,
      name = excluded.name,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      is_disconnected = excluded.is_disconnected,
      provider_connection_id = coalesce(public.channels.provider_connection_id, excluded.provider_connection_id),
      updated_at = now();
  end loop;

  for v_p in select * from jsonb_array_elements(coalesce(p_payload -> 'posts', '[]'::jsonb)) loop
    v_fetched := v_fetched + 1;
    v_seen := v_seen || (v_p ->> 'id');

    select id, provider_connection_id into v_channel_id, v_known_conn from public.channels where buffer_channel_id = v_p ->> 'channelId';
    continue when v_channel_id is null;
    v_conn := nullif(v_p ->> 'connectionId', '')::uuid;
    if v_conn is not null and v_known_conn is distinct from v_conn then
      v_conflicts := v_conflicts + 1;
      continue;
    end if;

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
      and (not v_scoped or buffer_post_id = any (v_confirmed_gone) or exists (
            select 1 from public.channels sc where sc.id = public.posts.channel_id and sc.provider_connection_id = any (v_scope)))
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
        and (not v_scoped or exists (
              select 1 from public.channels sc where sc.id = p.channel_id and sc.provider_connection_id = any (v_scope)))
      order by p.due_at
      limit 25
    ) s;
  end if;

  insert into public.sync_runs (mode, status, triggered_by, fetched, created, updated, invalidated, removed, rate_limit)
  values (v_mode, 'success', coalesce(p_payload ->> 'triggeredBy', 'manual'), v_fetched, v_created, v_updated, v_invalidated, v_removed, p_payload -> 'rateLimit');

  return jsonb_build_object('fetched', v_fetched, 'created', v_created, 'updated', v_updated, 'invalidated', v_invalidated, 'removed', v_removed, 'unresolved', v_unresolved, 'conflicts', v_conflicts);
end;
$$;
-- ---------------------------------------------------------------------------
-- 7. État du schéma (préparation au service)
-- ---------------------------------------------------------------------------

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
            and to_regprocedure('public.begin_urgent_run(text, text, integer)') is not null,
    '0012', to_regclass('public.provider_connections') is not null
            and to_regprocedure('public.provider_routes(text, text, text[], text[])') is not null
  );
  return jsonb_build_object('checks', v_checks, 'ready', not exists (select 1 from jsonb_each(v_checks) c where c.value = 'false'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Isolation et droits
-- ---------------------------------------------------------------------------

alter table public.provider_connections enable row level security;
alter table public.provider_connection_events enable row level security;
alter table private.provider_credentials enable row level security;

-- Seul l'administrateur lit les connexions et leur journal. Un client n'y a aucun accès, pas même à la sienne :
-- aucune règle ne lui est donnée. Le secret, lui, n'a AUCUNE règle de lecture (schéma privé, fonctions seulement).
drop policy if exists provider_connections_select on public.provider_connections;
create policy provider_connections_select on public.provider_connections for select to authenticated
  using ((select private.is_admin()));
drop policy if exists provider_connection_events_select on public.provider_connection_events;
create policy provider_connection_events_select on public.provider_connection_events for select to authenticated
  using ((select private.is_admin()));

revoke all on public.provider_connections, public.provider_connection_events from public, anon, authenticated;
revoke all on private.provider_credentials from public, anon, authenticated;
grant select on public.provider_connections, public.provider_connection_events to authenticated;

revoke execute on function
  private.guard_channel_connection(),
  private.guard_provider_connection(),
  private.connection_unresolved(uuid)
from public, anon, authenticated;

revoke execute on function
  public.admin_create_provider_connection(uuid, text, text, uuid, text, text, integer, text, text),
  public.admin_set_provider_credential(uuid, text, integer, text, text),
  public.admin_revoke_provider_connection(uuid, boolean),
  public.admin_provider_connections(),
  public.provider_connections_for_run(text, text),
  public.provider_routes(text, text, text[], text[]),
  public.record_provider_connection_state(text, uuid, boolean, text, jsonb, integer, text, boolean)
from public, anon;
grant execute on function
  public.admin_create_provider_connection(uuid, text, text, uuid, text, text, integer, text, text),
  public.admin_set_provider_credential(uuid, text, integer, text, text),
  public.admin_revoke_provider_connection(uuid, boolean),
  public.admin_provider_connections()
to authenticated;
grant execute on function
  public.provider_connections_for_run(text, text),
  public.provider_routes(text, text, text[], text[]),
  public.record_provider_connection_state(text, uuid, boolean, text, jsonb, integer, text, boolean)
to anon, authenticated;

notify pgrst, 'reload schema';

commit;
