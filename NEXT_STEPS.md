# Prochaines étapes — après la V1

Référence : `/home/ubuntu/cadence`, branche `release/cadence-v1-finalisation`. L'état vérifié est dans [PROJECT_STATUS.md](PROJECT_STATUS.md), la mise en production dans [DEPLOYMENT.md](DEPLOYMENT.md).

## Avant la bascule (décisions du propriétaire)

1. **Autoriser la mise en production** : publication de la branche sur GitHub, migration `0014`, passage en `BUFFER_MODE=real`, création de `CADENCE_CREDENTIALS_KEY`, déploiement. La procédure est prête et répétée sur une copie restaurée.
2. **Conserver la clé de chiffrement hors du serveur** (gestionnaire de mots de passe).
3. **Décider du sort du tag dans Buffer** : aujourd'hui le tag « À valider » reste sur le brouillon après l'accord du client, parce que Cadence n'écrit jamais dans Buffer. L'agence peut le retirer à la main sans perdre l'accord. Le faire retirer par Cadence demanderait d'autoriser une écriture ciblée (retrait d'un tag) : c'est possible avec l'API, mais contraire à la règle « lecture seule ».

## Juste après la bascule

1. Connecter le compte Buffer de chaque client, attribuer ses canaux, créer ses utilisateurs.
2. **Vérifier le parcours complet avec un vrai brouillon** : un brouillon tagué dans Buffer, validé par un compte client, puis programmé dans Buffer. Ce cycle a été vérifié de bout en bout avec le Buffer simulé et, côté lecture, avec un vrai compte Buffer ; il n'a pas pu l'être avec un vrai brouillon, faute d'autorisation d'écrire dans un compte Buffer réel.
3. Installer la synchronisation planifiée (une fois par heure).
4. Configurer la copie des sauvegardes hors du serveur (`offsite.env`) : la supervision la signale en avertissement.

## Ensuite, par ordre d'utilité

| Sujet | Pourquoi | Effort indicatif |
| --- | --- | --- |
| Envoi réel des e-mails | Aujourd'hui aucun e-mail ne part : les clients ne sont prévenus que s'ils ouvrent Cadence. Il faut un service d'envoi (`NOTIFICATIONS_MODE=webhook`) et quitter le profil « pilot ». | 0,5 à 1 jour |
| Création des comptes clients depuis l'interface | Aujourd'hui un script serveur (`bin/create-client-user.sh`), puis l'association depuis la fiche du client. Invitation et récupération de mot de passe par e-mail en dépendent. | 1 à 2 jours |
| Formats non vérifiés en réel | Vidéos, documents, publications sans texte, stabilité des adresses de médias. | 0,5 jour avec un compte de test |
| Retrait du contrat d'écriture du fournisseur | `schedulePost`, `createDraft`, etc. n'ont plus d'appelant et sont refusées par le client Buffer ; elles ne servent plus qu'au simulateur et à des contre-tests de refus. | 0,5 à 1 jour |
| Nettoyage SQL différé | Tables et fonctions du Studio et de la programmation automatique : conservées, inutilisées. À retirer par une migration dédiée, après sauvegarde restaurée. | 0,5 à 1 jour |
| Documents historiques | `TESTING.md`, `CLEANUP_REPORT.md`, `NIGHT_REPORT.md`, `ROADMAP.md`, `docs/STUDIO.md`, `docs/N8N.md`, `docs/PILOTE.md` décrivent des états antérieurs : à archiver. | 0,5 jour |

## Consigne de reprise pour Claude Code / Codex

Commencer par `cd /home/ubuntu/cadence`, lire `PROJECT_STATUS.md`, vérifier `git status --short --branch`. Utiliser une pile de test neuve pour chaque suite qui écrit. Ne rien publier ni déployer sans accord explicite.
