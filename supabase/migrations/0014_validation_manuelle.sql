-- Cadence — validation manuelle : accord sans date, tag retiré après accord (migration 0014)
-- Cadence ne fait plus que LIRE Buffer : l'agence programme à la main dans Buffer après l'accord du client. Deux
-- règles héritées de la programmation automatique empêchaient ce parcours :
--   1. un brouillon sans date ne pouvait pas être approuvé, et fixer sa date ensuite annulait l'accord ;
--   2. retirer le tag de validation d'un brouillon déjà approuvé retirait l'accord.
-- Cette migration ne redéfinit que trois fonctions (decide_post, sync_buffer_posts, schema_status) et ajoute un
-- marqueur de niveau. Aucune table, colonne, politique ni donnée n'est modifiée ; aucune donnée n'est supprimée.
--
--   decide_post        l'approbation n'exige plus de date ; une date DÉPASSÉE reste refusée (date_invalid) ; la marge
--                      de dix minutes (date_too_close), propre à la programmation automatique, disparaît.
--   sync_buffer_posts  corps de 0013, trois différences :
--                      - accord donné sans date, puis date fixée dans Buffer sans autre changement : l'accord reste et
--                        porte sur la version datée (événement « date_set », réservé à l'administrateur) ;
--                      - tag retiré d'un brouillon approuvé : l'accord reste (il ne tombe que si le contenu change) ;
--                      - tag retiré d'un brouillon en attente ou à modifier : retiré du circuit, comme avant.
--   schema_status      annonce le niveau 0014.
--
-- Politique de rejeu : rejouable (create or replace). Retour arrière : voir supabase/outils/0014_retour_arriere.sql.

begin;

do $$
begin
  if to_regprocedure('public.provider_connection_states(text, text)') is null or to_regprocedure('private.guard_schedule_claim()') is null then
    raise exception 'La migration 0013 doit être appliquée avant 0014.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Marqueur de niveau (les trois fonctions redéfinies gardent leur signature : rien d'autre ne distingue 0014)
-- ---------------------------------------------------------------------------

create or replace function private.validation_rules_version()
returns integer language sql immutable set search_path = '' as $$ select 2 $$;
revoke execute on function private.validation_rules_version() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Décision du client
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
  -- 0014 : un brouillon SANS date peut être approuvé (l'agence fixera la date en programmant dans Buffer). Une date
  -- déjà dépassée reste refusée : elle devra être corrigée, ce qui produira une nouvelle version à valider.
  if p_decision = 'approved' and v_post.due_at is not null and v_post.due_at <= now() then
    raise exception 'date_invalid';
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

-- ---------------------------------------------------------------------------
-- 3. Lecture du fournisseur
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
  -- 0014 : date fixée dans Buffer après un accord donné sur un contenu sans date.
  v_date_added boolean;
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
    v_date_added := false;
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
        if v_approval = 'approved' and v_row.due_at is null and v_due is not null
           and private.post_hash(v_p ->> 'text', null::timestamptz, v_p ->> 'channelId', v_p -> 'assets') = v_row.approved_hash then
          -- 0014 : l'accord portait sur un contenu SANS date ; l'agence vient de fixer la date dans Buffer, texte, canal
          -- et médias inchangés. L'accord reste valable et porte désormais sur la version datée : toute modification
          -- ultérieure (date comprise) redemande un accord.
          v_date_added := true;
          perform private.add_event(v_row.id, 'date_set', null, 'Date fixée dans Buffer après l''accord du client', v_version);
        elsif v_approval = 'approved' then
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
      end if;
      -- 0014 : retirer le tag d'un brouillon DÉJÀ approuvé ne retire plus l'accord. L'accord est attaché au contenu
      -- (empreinte) : il ne tombe que si ce contenu change.
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
      approved_hash = case when v_approval = 'approved' then (case when v_date_added then v_hash else approved_hash end) end,
      approved_version = case when v_approval = 'approved' then (case when v_date_added then v_version else approved_version end) end,
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
-- 4. État du schéma
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
    '0014', to_regprocedure('private.validation_rules_version()') is not null
  );
  return jsonb_build_object('checks', v_checks, 'ready', not exists (select 1 from jsonb_each(v_checks) c where c.value = 'false'::jsonb));
end;
$$;

notify pgrst, 'reload schema';

commit;
