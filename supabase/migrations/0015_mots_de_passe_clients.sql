-- Cadence — mots de passe des comptes clients créés par l'administrateur (migration 0015)
-- L'administrateur crée les comptes de ses clients depuis l'interface. Le mot de passe est généré par le serveur,
-- affiché à l'administrateur, et conservé pour qu'il puisse le relire ou le renouveler.
--
--   private.user_passwords     le mot de passe d'un compte client, CHIFFRÉ par le serveur avant l'écriture
--                              (AES-256-GCM, même clé maître que les clés Buffer : CADENCE_CREDENTIALS_KEY, hors base).
--                              Schéma privé : invisible de l'API, d'un client et du navigateur. Jamais en clair ici.
--   server_set_user_password   enregistre le mot de passe chiffré d'un compte CLIENT.
--   server_get_user_password   le rend au serveur, qui le déchiffre pour l'administrateur.
--
-- Les deux fonctions exigent le secret d'automatisation ET un acteur administrateur : une session de navigateur, même
-- administrateur, ne peut ni lire ni écrire cette table. Le mot de passe d'un administrateur n'y est jamais stocké.
-- Aucune autre table n'est modifiée ; aucune donnée n'est supprimée.
--
-- Politique de rejeu : rejouable (if not exists / create or replace). Retour arrière : voir
-- supabase/outils/0015_retour_arriere.sql.

begin;

do $$
begin
  if to_regprocedure('private.validation_rules_version()') is null then
    raise exception 'La migration 0014 doit être appliquée avant 0015.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table if not exists private.user_passwords (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ciphertext text not null check (ciphertext like 'v1.%' and length(ciphertext) <= 4000),
  key_version integer not null default 1 check (key_version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

-- Aucune politique : RLS activée, aucun rôle de l'API n'y accède. Seules les fonctions ci-dessous la touchent.
alter table private.user_passwords enable row level security;
revoke all on table private.user_passwords from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Fonctions réservées au serveur (secret d'automatisation + acteur administrateur)
-- ---------------------------------------------------------------------------

create or replace function public.server_set_user_password(
  p_secret text, p_actor uuid, p_user_id uuid, p_ciphertext text, p_key_version integer default 1
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_secret(p_secret);
  perform private.require_admin_actor(p_actor);
  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'user_not_found';
  end if;
  -- Le mot de passe d'un administrateur n'est jamais conservé.
  if exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
    raise exception 'not_a_client';
  end if;
  if p_ciphertext is null or length(p_ciphertext) < 20 then
    raise exception 'credential_required';
  end if;
  insert into private.user_passwords (user_id, ciphertext, key_version, updated_at, updated_by)
  values (p_user_id, p_ciphertext, coalesce(p_key_version, 1), now(), p_actor)
  on conflict (user_id) do update set
    ciphertext = excluded.ciphertext, key_version = excluded.key_version, updated_at = now(), updated_by = excluded.updated_by;
end;
$$;

create or replace function public.server_get_user_password(p_secret text, p_actor uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_row private.user_passwords%rowtype;
begin
  perform private.check_secret(p_secret);
  perform private.require_admin_actor(p_actor);
  if exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
    raise exception 'not_a_client';
  end if;
  select * into v_row from private.user_passwords where user_id = p_user_id;
  if not found then return null; end if;
  return jsonb_build_object('ciphertext', v_row.ciphertext, 'keyVersion', v_row.key_version, 'updatedAt', v_row.updated_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. État du schéma
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
            and to_regprocedure('private.guard_schedule_claim()') is not null,
    '0014', to_regprocedure('private.validation_rules_version()') is not null,
    '0015', to_regclass('private.user_passwords') is not null
            and to_regprocedure('public.server_get_user_password(text, uuid, uuid)') is not null
  );
  return jsonb_build_object('checks', v_checks, 'ready', not exists (select 1 from jsonb_each(v_checks) c where c.value = 'false'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Droits
-- ---------------------------------------------------------------------------

revoke execute on function
  public.server_set_user_password(text, uuid, uuid, text, integer),
  public.server_get_user_password(text, uuid, uuid)
from public;
-- Exposées comme les autres fonctions du serveur, et protégées par le secret d'automatisation.
grant execute on function
  public.server_set_user_password(text, uuid, uuid, text, integer),
  public.server_get_user_password(text, uuid, uuid)
to anon, authenticated;

notify pgrst, 'reload schema';

commit;
