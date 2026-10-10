-- Cadence — Content Studio (9 octobre 2026)
-- Vérifiée sur une base PostgreSQL locale en mémoire (npm run test), NON appliquée à Supabase.
-- À appliquer après 0007. Ajoute quatre tables, un espace de stockage privé et des fonctions
-- réservées à l'administrateur. Aucune donnée existante n'est modifiée.
--
-- Principe : le Studio prépare les contenus (brouillon, un texte par canal, médias). Rien de ce
-- qu'il contient n'est visible d'un client. « Envoyer en validation » crée les brouillons dans
-- Buffer ; ils rejoignent alors le circuit existant (table posts, empreinte, validation,
-- programmation après accord), qui n'est pas modifié par cette migration.

begin;

-- ---------------------------------------------------------------------------
-- 1. Stockage des médias : espace privé, lecture et dépôt réservés à l'administrateur
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'])
on conflict (id) do nothing;

-- Ni modification ni suppression : aucune règle ne les autorise, un fichier déposé ne peut pas être écrasé.
drop policy if exists cadence_media_select on storage.objects;
create policy cadence_media_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and (select private.is_admin()));
drop policy if exists cadence_media_insert on storage.objects;
create policy cadence_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (select private.is_admin()));

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- Bibliothèque de médias, par client.
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  kind text not null check (kind in ('image', 'video')),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  width integer,
  height integer,
  duration_ms integer,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists media_assets_organization_idx on public.media_assets (organization_id, created_at desc);
create index if not exists media_assets_created_by_idx on public.media_assets (created_by);

-- Un contenu : un client, une date, des hashtags, des médias ordonnés (plusieurs = carrousel).
create table if not exists public.studio_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null default '',
  due_at timestamptz,
  hashtags text[] not null default '{}',
  media_ids uuid[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'submitted', 'archived')),
  -- Augmente à chaque enregistrement : deux onglets ouverts ne s'écrasent pas en silence.
  revision integer not null default 1,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index if not exists studio_drafts_organization_idx on public.studio_drafts (organization_id, updated_at desc);
create index if not exists studio_drafts_created_by_idx on public.studio_drafts (created_by);

-- Le texte du contenu pour un canal, et son lien avec le brouillon Buffer une fois envoyé.
create table if not exists public.studio_variants (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.studio_drafts (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  text text not null default '',
  buffer_post_id text unique,
  push_state text not null default 'idle' check (push_state in ('idle', 'pushing', 'pushed', 'failed')),
  push_claimed_at timestamptz,
  push_error text,
  -- Révision du contenu présente dans Buffer. Différente de la révision courante : à renvoyer.
  pushed_revision integer,
  pushed_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (draft_id, channel_id)
);
create index if not exists studio_variants_channel_idx on public.studio_variants (channel_id);

-- Historique des versions d'une publication : ce que le client a eu sous les yeux à chaque version.
create table if not exists public.post_versions (
  post_id uuid not null references public.posts (id) on delete cascade,
  version integer not null,
  text text not null,
  due_at timestamptz,
  assets jsonb not null default '[]'::jsonb,
  content_hash text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, version)
);

alter table public.media_assets enable row level security;
alter table public.studio_drafts enable row level security;
alter table public.studio_variants enable row level security;
alter table public.post_versions enable row level security;
revoke all on public.media_assets, public.studio_drafts, public.studio_variants, public.post_versions from anon, authenticated;
grant select on public.media_assets, public.studio_drafts, public.studio_variants, public.post_versions to authenticated;

drop policy if exists media_assets_select on public.media_assets;
create policy media_assets_select on public.media_assets for select to authenticated using ((select private.is_admin()));
drop policy if exists studio_drafts_select on public.studio_drafts;
create policy studio_drafts_select on public.studio_drafts for select to authenticated using ((select private.is_admin()));
drop policy if exists studio_variants_select on public.studio_variants;
create policy studio_variants_select on public.studio_variants for select to authenticated using ((select private.is_admin()));
-- Les versions héritent de la visibilité de la publication (la sous-requête applique sa règle).
drop policy if exists post_versions_select on public.post_versions;
create policy post_versions_select on public.post_versions for select to authenticated using (post_id in (select p.id from public.posts p));

-- ---------------------------------------------------------------------------
-- 3. Historique des versions : alimenté par la base à chaque changement de contenu
-- ---------------------------------------------------------------------------

create or replace function private.record_post_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.post_versions (post_id, version, text, due_at, assets, content_hash)
  values (new.id, new.version, new.text, new.due_at, new.assets, new.content_hash)
  on conflict (post_id, version) do update set
    text = excluded.text, due_at = excluded.due_at, assets = excluded.assets, content_hash = excluded.content_hash
  where public.post_versions.content_hash <> excluded.content_hash;
  return new;
exception when others then
  raise warning 'version non enregistrée : %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists posts_record_version on public.posts;
create trigger posts_record_version after insert or update of version, content_hash on public.posts
  for each row execute function private.record_post_version();

-- Point de départ : la version actuelle de chaque publication existante.
insert into public.post_versions (post_id, version, text, due_at, assets, content_hash)
select id, version, text, due_at, assets, content_hash from public.posts
on conflict (post_id, version) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Médias
-- ---------------------------------------------------------------------------

create or replace function public.studio_register_media(
  p_organization_id uuid, p_path text, p_file_name text, p_mime_type text, p_size_bytes bigint,
  p_width integer default null, p_height integer default null, p_duration_ms integer default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_admin();
  if not exists (select 1 from public.organizations where id = p_organization_id and archived_at is null) then
    raise exception 'organization_unavailable';
  end if;
  if p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime') then
    raise exception 'invalid_media_type';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 52428800 then raise exception 'invalid_media_size'; end if;
  -- Le fichier doit être rangé dans le dossier du client, et réellement déposé.
  if p_path is null or p_path not like p_organization_id::text || '/%' or p_path like '%..%' then raise exception 'invalid_media_path'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'media' and name = p_path) then raise exception 'media_not_uploaded'; end if;

  insert into public.media_assets (organization_id, storage_path, file_name, kind, mime_type, size_bytes, width, height, duration_ms, created_by)
  values (
    p_organization_id, p_path, left(coalesce(nullif(trim(p_file_name), ''), 'média'), 200),
    case when p_mime_type like 'video/%' then 'video' else 'image' end, p_mime_type, p_size_bytes,
    p_width, p_height, p_duration_ms, (select auth.uid())
  )
  on conflict (storage_path) do update set file_name = excluded.file_name
  returning id into v_id;
  return v_id;
end;
$$;

-- Un média archivé disparaît de la bibliothèque ; les contenus qui l'utilisent déjà le gardent.
create or replace function public.studio_set_media_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.media_assets set archived_at = case when p_archived then coalesce(archived_at, now()) end where id = p_id;
  if not found then raise exception 'not_found'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Contenus
-- ---------------------------------------------------------------------------

-- Crée (p_id null) ou enregistre un contenu. p_payload :
-- { organizationId, title, dueAt, hashtags: [..], mediaIds: [..], variants: [{ channelId, text }] }
create or replace function public.studio_save_draft(p_id uuid, p_expected_revision integer, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.studio_drafts%rowtype;
  v_org uuid;
  v_title text := left(trim(coalesce(p_payload ->> 'title', '')), 120);
  v_due timestamptz := nullif(p_payload ->> 'dueAt', '')::timestamptz;
  v_hashtags text[] := coalesce((select array_agg(value) from jsonb_array_elements_text(coalesce(p_payload -> 'hashtags', '[]'::jsonb))), '{}');
  v_media uuid[] := coalesce((select array_agg(value::uuid) from jsonb_array_elements_text(coalesce(p_payload -> 'mediaIds', '[]'::jsonb))), '{}');
  v_channels uuid[] := coalesce((select array_agg((value ->> 'channelId')::uuid) from jsonb_array_elements(coalesce(p_payload -> 'variants', '[]'::jsonb))), '{}');
  v_variant jsonb;
begin
  perform private.require_admin();

  if p_id is null then
    v_org := (p_payload ->> 'organizationId')::uuid;
    if not exists (select 1 from public.organizations where id = v_org and archived_at is null) then
      raise exception 'organization_unavailable';
    end if;
  else
    select * into v_draft from public.studio_drafts where id = p_id for update;
    if not found then raise exception 'not_found'; end if;
    if v_draft.status = 'archived' then raise exception 'draft_archived'; end if;
    if v_draft.revision <> p_expected_revision then raise exception 'stale_revision'; end if;
    v_org := v_draft.organization_id;
  end if;

  if cardinality(v_hashtags) > 30 or exists (select 1 from unnest(v_hashtags) h where length(h) > 80) then raise exception 'invalid_hashtags'; end if;
  if cardinality(v_media) > 20 then raise exception 'too_many_media'; end if;
  if (select count(distinct m) from unnest(v_media) m) <> cardinality(v_media)
     or exists (select 1 from unnest(v_media) m where not exists (
       select 1 from public.media_assets a where a.id = m and a.organization_id = v_org)) then
    raise exception 'invalid_media';
  end if;
  -- Un canal ne reçoit qu'un texte par contenu, et doit appartenir au client du contenu.
  if (select count(distinct c) from unnest(v_channels) c) <> cardinality(v_channels)
     or exists (select 1 from unnest(v_channels) c where not exists (
       select 1 from public.channels ch where ch.id = c and ch.organization_id = v_org)) then
    raise exception 'invalid_channel';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_payload -> 'variants', '[]'::jsonb)) v where length(coalesce(v ->> 'text', '')) > 10000) then
    raise exception 'text_too_long';
  end if;

  if p_id is null then
    insert into public.studio_drafts (organization_id, title, due_at, hashtags, media_ids, created_by)
    values (v_org, v_title, v_due, v_hashtags, v_media, (select auth.uid()))
    returning * into v_draft;
  else
    -- Un canal dont le brouillon existe déjà dans Buffer ne se retire pas d'ici : il y resterait orphelin.
    if exists (select 1 from public.studio_variants where draft_id = p_id and removed_at is null
               and buffer_post_id is not null and not (channel_id = any (v_channels))) then
      raise exception 'variant_in_buffer';
    end if;
    update public.studio_drafts set
      title = v_title, due_at = v_due, hashtags = v_hashtags, media_ids = v_media,
      revision = revision + 1, updated_at = now()
    where id = p_id returning * into v_draft;
  end if;

  for v_variant in select * from jsonb_array_elements(coalesce(p_payload -> 'variants', '[]'::jsonb)) loop
    insert into public.studio_variants (draft_id, channel_id, text)
    values (v_draft.id, (v_variant ->> 'channelId')::uuid, coalesce(v_variant ->> 'text', ''))
    on conflict (draft_id, channel_id) do update set text = excluded.text, removed_at = null, updated_at = now();
  end loop;
  update public.studio_variants set removed_at = now(), updated_at = now()
  where draft_id = v_draft.id and removed_at is null and not (channel_id = any (v_channels));

  return jsonb_build_object('id', v_draft.id, 'revision', v_draft.revision);
end;
$$;

-- Change seulement la date (glisser-déposer dans le calendrier).
create or replace function public.studio_reschedule_draft(p_id uuid, p_expected_revision integer, p_due_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_revision integer;
begin
  perform private.require_admin();
  if p_due_at is null then raise exception 'date_invalid'; end if;
  update public.studio_drafts set due_at = p_due_at, revision = revision + 1, updated_at = now()
  where id = p_id and status <> 'archived' and (p_expected_revision is null or revision = p_expected_revision)
  returning revision into v_revision;
  if not found then
    if exists (select 1 from public.studio_drafts where id = p_id and status <> 'archived') then raise exception 'stale_revision'; end if;
    raise exception 'not_found';
  end if;
  return jsonb_build_object('id', p_id, 'revision', v_revision);
end;
$$;

create or replace function public.studio_set_draft_archived(p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.studio_drafts set
    status = case when p_archived then 'archived' when submitted_at is not null then 'submitted' else 'draft' end,
    updated_at = now()
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Envoi vers Buffer : réservation atomique, pour qu'un contenu ne soit jamais créé deux fois
-- ---------------------------------------------------------------------------

-- Réserve les textes à créer ou à mettre à jour dans Buffer.
-- Un envoi interrompu (état « en cours » resté bloqué) n'est jamais repris d'office : on ignore si
-- Buffer a créé le brouillon. Il faut p_force, après vérification dans Buffer.
create or replace function public.studio_claim_push(p_draft_id uuid, p_force boolean default false)
returns table (variant_id uuid, channel_id uuid, buffer_channel_id text, service text, text text, buffer_post_id text, revision integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.studio_drafts%rowtype;
begin
  perform private.require_admin();
  select * into v_draft from public.studio_drafts d where d.id = p_draft_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_draft.status = 'archived' then raise exception 'draft_archived'; end if;
  if v_draft.due_at is null or v_draft.due_at <= now() + interval '5 minutes' then raise exception 'date_invalid'; end if;
  if not exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null) then raise exception 'no_variant'; end if;
  if exists (select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null
             and v.push_state = 'pushing' and v.push_claimed_at > now() - interval '5 minutes') then
    raise exception 'push_in_progress';
  end if;
  if not coalesce(p_force, false) and exists (
    select 1 from public.studio_variants v where v.draft_id = p_draft_id and v.removed_at is null and v.push_state = 'pushing') then
    raise exception 'push_uncertain';
  end if;
  -- Canal détaché ou transféré depuis la préparation : rien ne part vers le canal d'un autre client.
  if exists (select 1 from public.studio_variants v join public.channels c on c.id = v.channel_id
             where v.draft_id = p_draft_id and v.removed_at is null and c.organization_id is distinct from v_draft.organization_id) then
    raise exception 'invalid_channel';
  end if;

  return query
  update public.studio_variants v set push_state = 'pushing', push_claimed_at = now(), push_error = null, updated_at = now()
  from public.channels c
  where c.id = v.channel_id and v.draft_id = p_draft_id and v.removed_at is null
    and (v.push_state in ('idle', 'failed', 'pushing') or v.pushed_revision is distinct from v_draft.revision)
  returning v.id, v.channel_id, c.buffer_channel_id, c.service, v.text, v.buffer_post_id, v_draft.revision;
end;
$$;

create or replace function public.studio_complete_push(
  p_variant_id uuid, p_ok boolean, p_buffer_post_id text default null, p_error text default null, p_revision integer default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_draft uuid;
begin
  perform private.require_admin();
  update public.studio_variants set
    push_state = case when p_ok then 'pushed' else 'failed' end,
    -- L'identifiant Buffer est gardé même en cas d'échec ultérieur : le brouillon existe, il ne faut pas le recréer.
    buffer_post_id = coalesce(p_buffer_post_id, buffer_post_id),
    push_error = case when p_ok then null else left(coalesce(p_error, 'Erreur inconnue'), 500) end,
    pushed_revision = case when p_ok then p_revision else pushed_revision end,
    pushed_at = case when p_ok then now() else pushed_at end,
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

-- ---------------------------------------------------------------------------
-- 7. Droits
-- ---------------------------------------------------------------------------

revoke execute on function private.record_post_version() from public, anon, authenticated;
revoke execute on function
  public.studio_register_media(uuid, text, text, text, bigint, integer, integer, integer),
  public.studio_set_media_archived(uuid, boolean),
  public.studio_save_draft(uuid, integer, jsonb),
  public.studio_reschedule_draft(uuid, integer, timestamptz),
  public.studio_set_draft_archived(uuid, boolean),
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer)
from public, anon;
grant execute on function
  public.studio_register_media(uuid, text, text, text, bigint, integer, integer, integer),
  public.studio_set_media_archived(uuid, boolean),
  public.studio_save_draft(uuid, integer, jsonb),
  public.studio_reschedule_draft(uuid, integer, timestamptz),
  public.studio_set_draft_archived(uuid, boolean),
  public.studio_claim_push(uuid, boolean),
  public.studio_complete_push(uuid, boolean, text, text, integer)
to authenticated;

commit;
