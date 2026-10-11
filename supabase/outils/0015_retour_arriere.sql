-- Retour arrière de 0015 — À NE PAS APPLIQUER SANS DÉCISION ÉCRITE.
--
-- Le retour normal après un déploiement raté est APPLICATIF : on remet l'image précédente, la base reste en 0015.
-- L'application 86fc3b9 (avant 0015) fonctionne sur une base 0015 : elle ignore la table et ses deux fonctions.
--
-- Ce script ferme les deux fonctions du serveur, sans supprimer la table : les mots de passe chiffrés restent en
-- base, illisibles sans la clé maître (CADENCE_CREDENTIALS_KEY), et redeviennent utilisables si 0015 est rejouée.
-- Les comptes eux-mêmes (auth.users) ne sont pas touchés : les clients continuent de se connecter.
-- Préalable : sauvegarde fraîche et restaurée (docs/SAUVEGARDE.md).
begin;
revoke execute on function
  public.server_set_user_password(text, uuid, uuid, text, integer),
  public.server_get_user_password(text, uuid, uuid)
from public, anon, authenticated;
commit;
