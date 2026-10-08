-- Modèle pour initialiser une base : à exécuter dans l'éditeur SQL de Supabase
-- après supabase/migrations/0001_schema.sql. Remplacer les valeurs entre chevrons.

-- 1. Empreinte du secret d'automatisation (la même valeur que AUTOMATION_SECRET dans .env.local).
insert into private.app_secrets (name, secret_hash)
values ('automation', encode(extensions.digest('<AUTOMATION_SECRET>', 'sha256'), 'hex'))
on conflict (name) do update set secret_hash = excluded.secret_hash;

-- 2. Un client.
insert into public.organizations (slug, name, sector, timezone, initials, color)
values ('<slug-du-client>', '<Nom du client>', '<Activité · Ville>', 'Europe/Paris', '<XX>', '#1f4f8f');

-- 3. Un utilisateur. Le créer d'abord dans Supabase > Authentication > Users (e-mail + mot de passe),
--    puis lui donner un profil. role : 'admin' ou 'client'.
insert into public.profiles (id, full_name, job_title, role)
select id, '<Prénom Nom>', '<Fonction>', 'client' from auth.users where email = '<email>';

-- 4. Pour un client : le rattacher à son organisation.
insert into public.organization_members (organization_id, user_id)
select o.id, u.id from public.organizations o, auth.users u
where o.slug = '<slug-du-client>' and u.email = '<email>';

-- 5. Les canaux apparaissent après la première synchronisation. Les rattacher à un client
--    se fait ensuite dans l'application : Clients > Canaux Buffer.
