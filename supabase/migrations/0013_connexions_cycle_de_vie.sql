-- Cadence — connexions fournisseur : cycle de vie sûr, identité vérifiée, collisions refusées (migration 0013)
-- Migration CORRECTIVE de 0012 (qui n'est pas réécrite). Elle répond aux constats P1-01 à P1-05 du contrôle
-- indépendant du 10 octobre 2026 (AUDIT_CODEX_MULTITENANT_FINAL.md). Vérifiée sur PGlite et PostgreSQL 17 (pile
-- isolée). NON appliquée à la production ni au projet Supabase hébergé. À appliquer après 0012.
-- Aucune donnée n'est supprimée ; les colonnes ajoutées sont nulles.
--
--   P1-01  Révocation et réservations partagent un verrou : toute réservation d'effet externe (programmation,
--          envoi Studio) verrouille la connexion du canal et exige qu'elle soit ACTIVE dans la même transaction.
--          Une révocation qui a constaté « aucun effet en attente » ne peut donc plus être doublée par une
--          réservation concurrente. Nouvel état « revoking » (révocation demandée) : plus aucun NOUVEL effet, mais
--          la clé est conservée pour annuler et rapprocher ce qui est déjà engagé. Les workers déjà chargés relisent
--          l'état durable de la connexion avant chaque opération (provider_connection_states).
--   P1-02  L'identité du compte fournisseur (account.id) est constatée PAR LE SERVEUR et enregistrée par des
--          fonctions protégées par le secret d'automatisation : une session de navigateur, même administrateur, ne
--          peut ni enregistrer une clé réelle ni déclarer une identité. Remplacer une clé exige le même compte.
--          Un compte fournisseur = une seule connexion non révoquée ; une clé = une seule connexion.
--   P1-03  Une publication déjà connue garde son compte d'origine : le même identifiant annoncé par un autre compte
--          est refusé sans aucune mutation (ni canal, ni texte, ni version).
--   P1-04  Pauses durables lues par tous les workers ; espacement des lectures planifiées par compte.
--   P1-05  Un ancien appelant (relevé sans périmètre, application 2f51602) ne vaut que pour le compte historique du
--          mode : il ne retire ni ne modifie rien des autres connexions.
--
-- Politique de rejeu : rejouable (if not exists / create or replace / drop … if exists).
-- Retour arrière : supabase/outils/0013_retour_arriere.sql (aucune donnée supprimée).

begin;

do $$
begin
  if to_regclass('public.provider_connections') is null or to_regprocedure('public.provider_routes(text, text, text[], text[])') is null then
    raise exception 'La migration 0012 doit être appliquée avant 0013.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Colonnes, contraintes, index
-- ---------------------------------------------------------------------------

alter table public.provider_connections add column if not exists read_backoff_until timestamptz;
alter table public.provider_connections add column if not exists read_backoff_reason text;
alter table public.provider_connections add column if not exists revoke_requested_at timestamptz;
alter table public.provider_connections add column if not exists revoke_requested_by uuid references auth.users (id) on delete set null;

-- « revoking » : révocation demandée, effets engagés encore à annuler ou rapprocher.
alter table public.provider_connections drop constraint if exists provider_connections_status_check;
alter table public.provider_connections add constraint provider_connections_status_check check (status in ('active', 'revoking', 'revoked'));

-- Empreinte de la clé (HMAC calculé par le serveur avec la clé maître) : ne permet pas de retrouver la clé.
alter table private.provider_credentials add column if not exists fingerprint text
  check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$');
create unique index if not exists provider_credentials_fingerprint_idx on private.provider_credentials (fingerprint)
  where fingerprint is not null;

-- Un compte fournisseur réel = une seule connexion non révoquée.
create unique index if not exists provider_connections_external_account_idx on public.provider_connections (provider, external_account_id)
  where external_account_id is not null and status <> 'revoked' and mode = 'real';
-- Une seule connexion non révoquée tire sa clé du serveur (0012 ne comptait que les « active »).
drop index if exists public.provider_connections_environment_idx;
create unique index if not exists provider_connections_environment_idx on public.provider_connections (credential_source)
  where credential_source = 'environment' and status <> 'revoked';

alter table public.provider_connection_events drop constraint if exists provider_connection_events_type_check;
alter table public.provider_connection_events add constraint provider_connection_events_type_check
  check (type in ('created', 'credential_replaced', 'verified', 'verification_failed', 'credential_reencrypted',
                  'revoke_requested', 'revoke_cancelled', 'revoked', 'revoke_refused', 'collision'));

-- ---------------------------------------------------------------------------
-- 2. Outils privés
-- ---------------------------------------------------------------------------

-- L'acteur déclaré par le serveur doit être un administrateur (fonctions protégées par le secret d'automatisation).
create or replace function private.require_admin_actor(p_actor uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_actor is null or not exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
    raise exception 'forbidden';
  end if;
end;
$$;

-- Collision d'identifiant entre comptes : consignée sans aucun contenu (au plus une par objet et par jour).
create or replace function private.log_connection_collision(p_connection_id uuid, p_kind text, p_external_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_detail text := format('Identifiant de %s annoncé par un autre compte : %s', p_kind, left(coalesce(p_external_id, '?'), 80));
begin
  if p_connection_id is null then return; end if;
  if exists (select 1 from public.provider_connection_events
             where connection_id = p_connection_id and type = 'collision' and detail = v_detail and created_at > now() - interval '1 day') then
    return;
  end if;
  insert into public.provider_connection_events (connection_id, type, detail) values (p_connection_id, 'collision', v_detail);
end;
$$;

-- Effets externes non rapprochés d'une connexion ; les envois Studio orphelins comptent aussi.
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
                  where c.provider_connection_id = p_connection_id
                    and (v.push_state in ('pushing', 'unknown') or jsonb_array_length(coalesce(v.push_orphans, '[]'::jsonb)) > 0))
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. P1-01 — réservation d'un effet externe : la connexion du canal est verrouillée et doit être active
-- ---------------------------------------------------------------------------
-- Ordre des verrous : la réservation tient d'abord sa ligne (publication ou variante), puis prend la connexion en
-- partage ; la révocation ne prend QUE la connexion, en exclusif, puis compte les effets en attente. Aucune des deux
-- n'attend un verrou que l'autre demande ensuite : pas d'interblocage. La réservation qui attend une révocation
-- en cours relit l'état validé : révoquée → la ligne n'est pas réservée (renvoyer NULL saute la ligne, elle est
-- absente du « returning » de la fonction appelante). Un canal sans connexion (créé avant 0012) n'est pas concerné.

create or replace function private.connection_emittable(p_channel_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_connection uuid;
  v_status text;
begin
  select provider_connection_id into v_connection from public.channels where id = p_channel_id;
  if v_connection is null then return true; end if;
  select status into v_status from public.provider_connections where id = v_connection for share;
  return v_status = 'active';
end;
$$;

create or replace function private.guard_schedule_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.schedule_state = 'claimed' and (old.schedule_state <> 'claimed' or new.schedule_token is distinct from old.schedule_token) then
    if not private.connection_emittable(new.channel_id) then return null; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists posts_schedule_claim_guard on public.posts;
create trigger posts_schedule_claim_guard before update of schedule_state, schedule_token on public.posts
  for each row execute function private.guard_schedule_claim();

create or replace function private.guard_push_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.push_state = 'pushing' and (old.push_state <> 'pushing' or new.push_attempt_id is distinct from old.push_attempt_id) then
    if not private.connection_emittable(new.channel_id) then return null; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists studio_variants_push_claim_guard on public.studio_variants;
create trigger studio_variants_push_claim_guard before update of push_state, push_attempt_id on public.studio_variants
  for each row execute function private.guard_push_claim();

-- Garde-fou de 0012, complété : la demande de révocation s'annule (revoking → active), une révocation jamais.
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

-- ---------------------------------------------------------------------------
-- 4. Administration (session d'un administrateur)
-- ---------------------------------------------------------------------------

-- Création par une session : comptes SIMULÉS seulement. Une clé réelle ne s'enregistre que par le serveur (§5),
-- qui seul peut constater le compte auquel elle appartient.
create or replace function public.admin_create_provider_connection(
  p_id uuid, p_mode text, p_label text, p_organization_id uuid default null,
  p_credential_source text default 'none', p_ciphertext text default null, p_key_version integer default 1, p_hint text default null,
  p_account_key text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_id is null then raise exception 'invalid_connection'; end if;
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  if p_mode <> 'mock' or p_credential_source <> 'none' or p_ciphertext is not null then
    raise exception 'server_only' using hint = 'Une clé réelle s''enregistre par le serveur, qui vérifie le compte auquel elle appartient.';
  end if;
  if p_account_key is null then raise exception 'invalid_connection'; end if;
  if p_organization_id is not null and not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;
  insert into public.provider_connections (id, mode, label, organization_id, credential_source, account_key, created_by)
  values (p_id, 'mock', trim(p_label), p_organization_id, 'none', p_account_key, (select auth.uid()));
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_id, 'created', (select auth.uid()), 'Compte simulé');
  return p_id;
end;
$$;

-- Le remplacement d'une clé par une session est fermé : identité non démontrable depuis un navigateur.
create or replace function public.admin_set_provider_credential(
  p_connection_id uuid, p_ciphertext text, p_key_version integer default 1, p_hint text default null, p_external_account_id text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  raise exception 'server_only' using hint = 'Le remplacement d''une clé passe par le serveur, qui vérifie qu''elle appartient au même compte.';
end;
$$;

-- Demande de révocation : plus aucun NOUVEL effet ne peut être réservé sur ce compte ; sa clé est conservée pour
-- annuler et rapprocher ce qui est déjà engagé. Sans effet en attente, la révocation est immédiate.
create or replace function public.admin_request_provider_revocation(p_connection_id uuid)
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
  if v_total = 0 then
    update public.provider_connections set status = 'revoked', revoked_at = now(), revoked_by = (select auth.uid()), is_default = false
    where id = p_connection_id;
    delete from private.provider_credentials where connection_id = p_connection_id;
    insert into public.provider_connection_events (connection_id, type, actor_id, detail)
    values (p_connection_id, 'revoked', (select auth.uid()), 'Aucun effet externe en attente');
    return jsonb_build_object('revoked', true, 'unresolved', v_open);
  end if;
  if v_conn.status <> 'revoking' then
    update public.provider_connections set status = 'revoking', revoke_requested_at = now(), revoke_requested_by = (select auth.uid())
    where id = p_connection_id;
    insert into public.provider_connection_events (connection_id, type, actor_id, detail)
    values (p_connection_id, 'revoke_requested', (select auth.uid()), 'Nouveaux effets bloqués ; en attente : ' || v_open::text);
  end if;
  return jsonb_build_object('revoked', false, 'revoking', true, 'unresolved', v_open);
end;
$$;

create or replace function public.admin_cancel_provider_revocation(p_connection_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  perform private.require_admin();
  select status into v_status from public.provider_connections where id = p_connection_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_status <> 'revoking' then raise exception 'invalid_connection'; end if;
  update public.provider_connections set status = 'active', revoke_requested_at = null, revoke_requested_by = null where id = p_connection_id;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_connection_id, 'revoke_cancelled', (select auth.uid()), 'Demande de révocation annulée');
end;
$$;

-- Révocation définitive (même signature que 0012). Le verrou exclusif pris ici est celui que toute réservation
-- demande en partage : après le constat « aucun effet », aucune réservation ne peut plus aboutir sur ce compte.
-- p_force : décision explicite et tracée ; la clé est effacée, Cadence ne pourra plus rien annuler chez le
-- fournisseur pour ce compte, et aucune publication n'est déclarée « annulée » de ce fait.
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
    return jsonb_build_object('revoked', false, 'revoking', v_conn.status = 'revoking', 'unresolved', v_open);
  end if;
  update public.provider_connections set status = 'revoked', revoked_at = now(), revoked_by = (select auth.uid()), is_default = false
  where id = p_connection_id;
  -- Retrait d'un accès : le secret disparaît réellement (seule suppression, comme en 0012).
  delete from private.provider_credentials where connection_id = p_connection_id;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_connection_id, 'revoked', (select auth.uid()),
          case when v_total > 0 then 'Révocation FORCÉE avec effets non rapprochés (à traiter à la main chez le fournisseur) : ' || v_open::text
               else 'Aucun effet externe en attente' end);
  return jsonb_build_object('revoked', true, 'forced', v_total > 0, 'unresolved', v_open);
end;
$$;

-- Vue d'ensemble (administrateur uniquement, aucune valeur secrète) : + compte constaté, version de clé, espacement.
drop function if exists public.admin_provider_connections();
create or replace function public.admin_provider_connections()
returns table (
  id uuid, provider text, mode text, organization_id uuid, label text, status text, credential_source text, hint text,
  account_key text, external_account_label text, is_default boolean, last_verified_at timestamptz, last_sync_at timestamptz,
  last_sync_ok boolean, last_error text, paused_until timestamptz, pause_reason text, created_at timestamptz, revoked_at timestamptz,
  channels integer, unresolved jsonb, external_account_id text, key_version integer, read_backoff_until timestamptz, rate_limit jsonb,
  revoke_requested_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
  select pc.id, pc.provider, pc.mode, pc.organization_id, pc.label, pc.status, pc.credential_source, cr.hint,
         pc.account_key, pc.external_account_label, pc.is_default, pc.last_verified_at, pc.last_sync_at,
         pc.last_sync_ok, pc.last_error, pc.paused_until, pc.pause_reason, pc.created_at, pc.revoked_at,
         (select count(*)::int from public.channels c where c.provider_connection_id = pc.id),
         private.connection_unresolved(pc.id), pc.external_account_id, cr.key_version, pc.read_backoff_until, pc.rate_limit,
         pc.revoke_requested_at
  from public.provider_connections pc
  left join private.provider_credentials cr on cr.connection_id = pc.id
  order by case pc.status when 'active' then 0 when 'revoking' then 1 else 2 end, pc.created_at;
end;
$$;

-- Détail d'une connexion : ses canaux, ses programmations en attente, ses envois non résolus (au plus 50 de chaque).
create or replace function public.admin_provider_connection_detail(p_connection_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if not exists (select 1 from public.provider_connections where id = p_connection_id) then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'service', c.service, 'name', coalesce(c.display_name, c.name),
                                          'organizationId', c.organization_id, 'isDisconnected', c.is_disconnected) order by c.service, c.name)
      from public.channels c where c.provider_connection_id = p_connection_id), '[]'::jsonb),
    'scheduled', coalesce((
      select jsonb_agg(row_to_json(s)) from (
        select p.id, p.buffer_post_id as "bufferPostId", c.service, coalesce(c.display_name, c.name) as channel, p.due_at as "dueAt",
               p.schedule_state as "scheduleState", p.buffer_status as "bufferStatus", p.schedule_error as error, left(p.text, 120) as excerpt
        from public.posts p join public.channels c on c.id = p.channel_id
        where c.provider_connection_id = p_connection_id and p.removed_at is null and p.buffer_status not in ('sent', 'error')
          and (p.schedule_state in ('claimed', 'scheduled', 'unschedule_pending') or p.buffer_status = 'scheduled')
        order by p.due_at nulls last limit 50) s), '[]'::jsonb),
    'uncertain', coalesce((
      select jsonb_agg(row_to_json(u)) from (
        select v.id as "variantId", v.draft_id as "draftId", c.service, coalesce(c.display_name, c.name) as channel, v.push_state as "pushState",
               v.push_attempt_id as "attemptId", v.push_claimed_at as "claimedAt", v.push_error as error,
               jsonb_array_length(coalesce(v.push_orphans, '[]'::jsonb)) as orphans
        from public.studio_variants v join public.channels c on c.id = v.channel_id
        where c.provider_connection_id = p_connection_id
          and (v.push_state in ('pushing', 'unknown') or jsonb_array_length(coalesce(v.push_orphans, '[]'::jsonb)) > 0)
        order by v.push_claimed_at nulls last limit 50) u), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. P1-02 — clés réelles et identité : par le SERVEUR uniquement (secret d'automatisation + acteur administrateur)
-- ---------------------------------------------------------------------------

-- Enregistre une connexion réelle. p_external_account_id : compte constaté par le serveur chez le fournisseur ;
-- nul = clé NON VÉRIFIÉE (serveur en simulation) : la connexion existe mais reste inutilisable tant qu'elle ne l'est pas.
create or replace function public.server_create_provider_connection(
  p_secret text, p_actor uuid, p_id uuid, p_label text, p_organization_id uuid, p_ciphertext text, p_key_version integer,
  p_hint text, p_fingerprint text, p_external_account_id text default null, p_external_account_label text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  perform private.require_admin_actor(p_actor);
  if p_id is null then raise exception 'invalid_connection'; end if;
  if p_ciphertext is null or p_ciphertext not like 'v1.%' or p_fingerprint is null then raise exception 'credential_required'; end if;
  if p_organization_id is not null and not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;
  if p_external_account_id is not null and exists (
    select 1 from public.provider_connections where mode = 'real' and status <> 'revoked' and external_account_id = p_external_account_id
  ) then
    raise exception 'provider_account_already_connected' using hint = 'Ce compte Buffer est déjà relié par une autre connexion.';
  end if;
  if exists (select 1 from private.provider_credentials where fingerprint = p_fingerprint) then
    raise exception 'provider_credential_reused' using hint = 'Cette clé est déjà enregistrée pour une autre connexion.';
  end if;
  insert into public.provider_connections (id, mode, label, organization_id, credential_source, created_by,
                                           external_account_id, external_account_label, last_verified_at)
  values (p_id, 'real', trim(p_label), p_organization_id, 'stored', p_actor,
          p_external_account_id, left(p_external_account_label, 120), case when p_external_account_id is not null then now() end);
  insert into private.provider_credentials (connection_id, ciphertext, key_version, hint, fingerprint, updated_by)
  values (p_id, p_ciphertext, coalesce(p_key_version, 1), left(p_hint, 4), p_fingerprint, p_actor);
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_id, 'created', p_actor, case when p_external_account_id is not null then 'Clé vérifiée auprès du fournisseur, enregistrée chiffrée'
                                         else 'Clé enregistrée chiffrée, NON vérifiée (inutilisable avant vérification)' end);
  return p_id;
end;
$$;

-- Remplace la clé. Réponses : 'replaced' ; 'account_mismatch' (la clé appartient à un autre compte : RIEN n'est
-- changé, l'ancienne clé reste en place) ; 'account_already_connected' ; 'credential_reused'.
-- Connexion déjà vérifiée : l'identité de la nouvelle clé est OBLIGATOIRE (une clé à l'identité inconnue ne remplace
-- jamais une clé vérifiée).
create or replace function public.server_set_provider_credential(
  p_secret text, p_actor uuid, p_connection_id uuid, p_ciphertext text, p_key_version integer, p_hint text, p_fingerprint text,
  p_external_account_id text default null, p_external_account_label text default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  perform private.check_secret(p_secret);
  perform private.require_admin_actor(p_actor);
  select * into v_conn from public.provider_connections where id = p_connection_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_conn.status <> 'active' then raise exception 'provider_connection_revoked'; end if;
  if v_conn.mode <> 'real' then raise exception 'invalid_connection'; end if;
  if p_ciphertext is null or p_ciphertext not like 'v1.%' or p_fingerprint is null then raise exception 'credential_required'; end if;
  if v_conn.external_account_id is not null and p_external_account_id is null then raise exception 'verification_required'; end if;
  if v_conn.external_account_id is not null and p_external_account_id <> v_conn.external_account_id then
    insert into public.provider_connection_events (connection_id, type, actor_id, detail)
    values (p_connection_id, 'verification_failed', p_actor, 'Clé refusée : elle appartient à un autre compte fournisseur');
    return 'account_mismatch';
  end if;
  if p_external_account_id is not null and exists (
    select 1 from public.provider_connections
    where mode = 'real' and status <> 'revoked' and external_account_id = p_external_account_id and id <> p_connection_id
  ) then
    return 'account_already_connected';
  end if;
  if exists (select 1 from private.provider_credentials where fingerprint = p_fingerprint and connection_id <> p_connection_id) then
    return 'credential_reused';
  end if;
  insert into private.provider_credentials (connection_id, ciphertext, key_version, hint, fingerprint, updated_by)
  values (p_connection_id, p_ciphertext, coalesce(p_key_version, 1), left(p_hint, 4), p_fingerprint, p_actor)
  on conflict (connection_id) do update set ciphertext = excluded.ciphertext, key_version = excluded.key_version,
    hint = excluded.hint, fingerprint = excluded.fingerprint, updated_at = now(), updated_by = excluded.updated_by;
  update public.provider_connections set credential_source = 'stored',
    last_verified_at = case when p_external_account_id is not null then now() end,
    external_account_id = coalesce(external_account_id, p_external_account_id),
    external_account_label = coalesce(left(p_external_account_label, 120), external_account_label),
    last_error = null
  where id = p_connection_id;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_connection_id, 'credential_replaced', p_actor,
          case when p_external_account_id is not null then 'Clé remplacée (vérifiée, même compte, chiffrée)' else 'Clé remplacée (chiffrée, NON vérifiée)' end);
  return 'replaced';
end;
$$;

-- Résultat d'une vérification en ligne (lecture seule chez le fournisseur) de la clé d'une connexion.
-- Réponses : 'verified', 'failed', 'account_mismatch', 'account_already_connected'. Un échec ne prouve rien :
-- il n'efface ni l'identité déjà constatée ni la clé.
create or replace function public.server_record_provider_verification(
  p_secret text, p_actor uuid, p_connection_id uuid, p_ok boolean, p_external_account_id text default null,
  p_external_account_label text default null, p_detail text default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.provider_connections%rowtype;
  v_outcome text;
begin
  perform private.check_secret(p_secret);
  perform private.require_admin_actor(p_actor);
  select * into v_conn from public.provider_connections where id = p_connection_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_conn.status = 'revoked' then raise exception 'provider_connection_revoked'; end if;
  if v_conn.mode <> 'real' then raise exception 'invalid_connection'; end if;

  if not coalesce(p_ok, false) or p_external_account_id is null then
    v_outcome := 'failed';
  elsif v_conn.external_account_id is not null and v_conn.external_account_id <> p_external_account_id then
    v_outcome := 'account_mismatch';
  elsif exists (select 1 from public.provider_connections
                where mode = 'real' and status <> 'revoked' and external_account_id = p_external_account_id and id <> p_connection_id) then
    v_outcome := 'account_already_connected';
  else
    v_outcome := 'verified';
  end if;

  if v_outcome = 'verified' then
    update public.provider_connections set last_verified_at = now(), external_account_id = p_external_account_id,
      external_account_label = coalesce(left(p_external_account_label, 120), external_account_label), last_error = null
    where id = p_connection_id;
  else
    update public.provider_connections set
      last_verified_at = case when v_outcome = 'failed' then last_verified_at end,
      last_error = left(case v_outcome when 'account_mismatch' then 'La clé enregistrée appartient à un autre compte que celui de cette connexion.'
                                       when 'account_already_connected' then 'Ce compte est déjà relié par une autre connexion.'
                                       else coalesce(p_detail, 'Vérification non aboutie.') end, 500)
    where id = p_connection_id;
  end if;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_connection_id, case when v_outcome = 'verified' then 'verified' else 'verification_failed' end, p_actor,
          left(case v_outcome when 'verified' then 'Compte constaté chez le fournisseur'
                              when 'account_mismatch' then 'La clé appartient à un autre compte que celui de la connexion'
                              when 'account_already_connected' then 'Compte déjà relié par une autre connexion'
                              else coalesce(p_detail, 'Vérification non aboutie') end, 300));
  return v_outcome;
end;
$$;

-- Rotation de la clé maître : même secret, re-chiffré par le serveur avec la clé courante. Conditionnel à la version
-- attendue (deux rotations simultanées ne s'écrasent pas). Vérification et compte constaté conservés.
create or replace function public.server_reencrypt_provider_credential(
  p_secret text, p_actor uuid, p_connection_id uuid, p_ciphertext text, p_key_version integer, p_from_key_version integer, p_fingerprint text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_done integer;
begin
  perform private.check_secret(p_secret);
  perform private.require_admin_actor(p_actor);
  if p_ciphertext is null or p_ciphertext not like 'v1.%' or p_key_version is null or p_key_version < 1 or p_fingerprint is null then
    raise exception 'credential_required';
  end if;
  update private.provider_credentials set ciphertext = p_ciphertext, key_version = p_key_version,
    fingerprint = p_fingerprint, updated_at = now(), updated_by = p_actor
  where connection_id = p_connection_id and key_version = p_from_key_version
    and exists (select 1 from public.provider_connections pc where pc.id = p_connection_id and pc.status <> 'revoked');
  get diagnostics v_done = row_count;
  if v_done = 0 then return false; end if;
  insert into public.provider_connection_events (connection_id, type, actor_id, detail)
  values (p_connection_id, 'credential_reencrypted', p_actor, format('Clé re-chiffrée : clé maître n° %s → n° %s', p_from_key_version, p_key_version));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Serveur à serveur : chargement, état durable, espacement
-- ---------------------------------------------------------------------------

-- Connexions NON RÉVOQUÉES d'un mode. « revoking » : chargée pour annuler et rapprocher, jamais pour un nouvel effet.
-- « verified » : compte réel dont l'identité a été constatée (une clé non vérifiée n'est pas utilisable).
create or replace function public.provider_connections_for_run(p_secret text, p_mode text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pc.id, 'label', pc.label, 'organizationId', pc.organization_id, 'credentialSource', pc.credential_source,
      'ciphertext', cr.ciphertext, 'keyVersion', cr.key_version, 'accountKey', pc.account_key, 'isDefault', pc.is_default,
      'pausedUntil', case when pc.paused_until > now() then pc.paused_until end, 'pauseReason', pc.pause_reason,
      'readBackoffUntil', case when pc.read_backoff_until > now() then pc.read_backoff_until end,
      'status', pc.status, 'verified', pc.mode = 'mock' or pc.external_account_id is not null,
      'externalAccountId', pc.external_account_id
    ) order by pc.created_at)
    from public.provider_connections pc
    left join private.provider_credentials cr on cr.connection_id = pc.id
    where pc.mode = p_mode and pc.status <> 'revoked'), '[]'::jsonb);
end;
$$;

-- État DURABLE des connexions d'un mode (révoquées comprises), relu par chaque worker avant chaque opération : une
-- révocation ou une pause décidée ailleurs vaut immédiatement pour un routeur déjà chargé. Aucun secret.
create or replace function public.provider_connection_states(p_secret text, p_mode text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if p_mode is null or p_mode not in ('real', 'mock') then raise exception 'invalid_mode'; end if;
  return coalesce((
    select jsonb_object_agg(pc.id, jsonb_build_object(
      'status', pc.status, 'pausedUntil', case when pc.paused_until > now() then pc.paused_until end,
      'credentialAt', cr.updated_at))
    from public.provider_connections pc
    left join private.provider_credentials cr on cr.connection_id = pc.id
    where pc.mode = p_mode), '{}'::jsonb);
end;
$$;

-- Espace les lectures planifiées d'UN compte (quota presque épuisé). Ne se raccourcit jamais ; plafonné à 31 jours.
create or replace function public.record_provider_connection_backoff(p_secret text, p_connection_id uuid, p_seconds integer, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  if coalesce(p_seconds, 0) <= 0 then return; end if;
  update public.provider_connections set
    read_backoff_until = greatest(coalesce(read_backoff_until, now()), now() + make_interval(secs => least(p_seconds, 31 * 86400))),
    read_backoff_reason = left(p_reason, 300)
  where id = p_connection_id and status <> 'revoked';
end;
$$;

-- État après lecture ou refus de quota (0012), étendu aux connexions en cours de révocation. Renvoie true si la
-- ligne a bien été écrite : un worker sait ainsi si la pause est réellement enregistrée.
drop function if exists public.record_provider_connection_state(text, uuid, boolean, text, jsonb, integer, text, boolean);
create or replace function public.record_provider_connection_state(
  p_secret text, p_connection_id uuid, p_ok boolean, p_error text default null, p_rate_limit jsonb default null,
  p_pause_seconds integer default 0, p_pause_reason text default null, p_synced boolean default false
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_done integer;
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
  where id = p_connection_id and status <> 'revoked';
  get diagnostics v_done = row_count;
  return v_done > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. P1-03 et P1-05 — lecture du fournisseur (corps de 0012 ; différences : collision de publication refusée,
--    ancien appelant borné au compte historique, collisions consignées)
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
  -- 0013 : connexion historique du mode (ancien appelant), connexion d'origine d'une publication déjà connue.
  v_default uuid;
  v_post_conn uuid;
begin
  perform private.check_secret(p_secret);
  select id into v_default from public.provider_connections where mode = v_mode and is_default and status = 'active';
  -- Ancien appelant (relevé sans périmètre) : il ne connaît QUE le compte historique. Son relevé ne vaut que pour lui.
  if not v_scoped then v_scope := case when v_default is null then '{}'::uuid[] else array[v_default] end; end if;

  for v_c in select * from jsonb_array_elements(coalesce(p_payload -> 'channels', '[]'::jsonb)) loop
    -- Sans connexion annoncée (ancien appelant) : c'est le compte historique du mode, jamais un autre.
    v_conn := coalesce(nullif(v_c ->> 'connectionId', '')::uuid, v_default);
    select provider_connection_id into v_known_conn from public.channels where buffer_channel_id = v_c ->> 'id';
    if found and v_known_conn is not null and v_known_conn is distinct from v_conn then
      -- Même identifiant de canal annoncé par un AUTRE compte : jamais fusionné, jamais réattribué, jamais modifié.
      v_conflicts := v_conflicts + 1;
      perform private.log_connection_collision(v_known_conn, 'canal', v_c ->> 'id');
      continue;
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
    v_conn := coalesce(nullif(v_p ->> 'connectionId', '')::uuid, v_default);
    if v_known_conn is not null and v_known_conn is distinct from v_conn then
      v_conflicts := v_conflicts + 1;
      perform private.log_connection_collision(v_known_conn, 'publication', v_p ->> 'id');
      continue;
    end if;

    v_status := v_p ->> 'status';
    v_tag := coalesce((v_p ->> 'hasReviewTag')::boolean, false);
    v_due := (v_p ->> 'dueAt')::timestamptz;
    v_hash := private.post_hash(v_p ->> 'text', v_due, v_p ->> 'channelId', v_p -> 'assets');

    select * into v_row from public.posts where buffer_post_id = v_p ->> 'id' for update;

    -- 0013 : une publication déjà connue garde SON compte d'origine. Le même identifiant annoncé sur un canal d'un
    -- autre compte est une collision : rien n'est modifié (ni canal, ni texte, ni version, ni événement), et la
    -- publication d'origine n'est pas considérée comme absente (elle reste dans v_seen).
    if found and v_row.channel_id <> v_channel_id then
      select provider_connection_id into v_post_conn from public.channels where id = v_row.channel_id;
      if v_post_conn is distinct from v_known_conn then
        v_conflicts := v_conflicts + 1;
        perform private.log_connection_collision(coalesce(v_post_conn, v_known_conn), 'publication', v_p ->> 'id');
        continue;
      end if;
    end if;

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
      -- Seules les publications des comptes lus en entier peuvent être retirées. Ancien appelant : le compte
      -- historique (et les canaux d'avant 0012 restés sans connexion), jamais les comptes des autres clients.
      and (buffer_post_id = any (v_confirmed_gone) or exists (
            select 1 from public.channels sc where sc.id = public.posts.channel_id
              and (sc.provider_connection_id = any (v_scope) or (not v_scoped and sc.provider_connection_id is null))))
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
        and exists (
              select 1 from public.channels sc where sc.id = p.channel_id
                and (sc.provider_connection_id = any (v_scope) or (not v_scoped and sc.provider_connection_id is null)))
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
-- 8. État du schéma
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
            and to_regprocedure('public.provider_routes(text, text, text[], text[])') is not null,
    '0013', to_regprocedure('public.provider_connection_states(text, text)') is not null
            and to_regprocedure('private.guard_schedule_claim()') is not null
  );
  return jsonb_build_object('checks', v_checks, 'ready', not exists (select 1 from jsonb_each(v_checks) c where c.value = 'false'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Droits
-- ---------------------------------------------------------------------------

revoke execute on function
  private.require_admin_actor(uuid),
  private.log_connection_collision(uuid, text, text),
  private.connection_unresolved(uuid),
  private.connection_emittable(uuid),
  private.guard_schedule_claim(),
  private.guard_push_claim(),
  private.guard_provider_connection()
from public, anon, authenticated;

revoke execute on function
  public.admin_create_provider_connection(uuid, text, text, uuid, text, text, integer, text, text),
  public.admin_set_provider_credential(uuid, text, integer, text, text),
  public.admin_request_provider_revocation(uuid),
  public.admin_cancel_provider_revocation(uuid),
  public.admin_revoke_provider_connection(uuid, boolean),
  public.admin_provider_connections(),
  public.admin_provider_connection_detail(uuid),
  public.server_create_provider_connection(text, uuid, uuid, text, uuid, text, integer, text, text, text, text),
  public.server_set_provider_credential(text, uuid, uuid, text, integer, text, text, text, text),
  public.server_record_provider_verification(text, uuid, uuid, boolean, text, text, text),
  public.server_reencrypt_provider_credential(text, uuid, uuid, text, integer, integer, text),
  public.provider_connections_for_run(text, text),
  public.provider_connection_states(text, text),
  public.record_provider_connection_backoff(text, uuid, integer, text),
  public.record_provider_connection_state(text, uuid, boolean, text, jsonb, integer, text, boolean)
from public, anon;
grant execute on function
  public.admin_create_provider_connection(uuid, text, text, uuid, text, text, integer, text, text),
  public.admin_set_provider_credential(uuid, text, integer, text, text),
  public.admin_request_provider_revocation(uuid),
  public.admin_cancel_provider_revocation(uuid),
  public.admin_revoke_provider_connection(uuid, boolean),
  public.admin_provider_connections(),
  public.admin_provider_connection_detail(uuid)
to authenticated;
-- Fonctions du serveur : exposées comme les autres fonctions d'automatisation, et protégées par le secret.
grant execute on function
  public.server_create_provider_connection(text, uuid, uuid, text, uuid, text, integer, text, text, text, text),
  public.server_set_provider_credential(text, uuid, uuid, text, integer, text, text, text, text),
  public.server_record_provider_verification(text, uuid, uuid, boolean, text, text, text),
  public.server_reencrypt_provider_credential(text, uuid, uuid, text, integer, integer, text),
  public.provider_connections_for_run(text, text),
  public.provider_connection_states(text, text),
  public.record_provider_connection_backoff(text, uuid, integer, text),
  public.record_provider_connection_state(text, uuid, boolean, text, jsonb, integer, text, boolean)
to anon, authenticated;

notify pgrst, 'reload schema';

commit;
