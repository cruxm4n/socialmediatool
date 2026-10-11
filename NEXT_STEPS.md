# Prochaines étapes — après la V1

Référence : `/home/ubuntu/cadence`, branche `release/cadence-v1-finalisation`. L'état vérifié est dans [PROJECT_STATUS.md](PROJECT_STATUS.md), la mise en production dans [DEPLOYMENT.md](DEPLOYMENT.md).

## À faire juste après la mise en production

1. Connecter le compte Buffer de chaque client, attribuer ses canaux, créer ses utilisateurs depuis sa fiche.
2. **Vérifier le parcours complet avec un vrai brouillon** : un brouillon daté et tagué dans Buffer, approuvé par un compte client. Il doit passer en « programmé » dans Buffer à sa date. C'est la première exécution réelle de la programmation après accord.
3. Installer la synchronisation planifiée (une fois par heure).
4. Configurer la copie des sauvegardes hors du serveur (`offsite.env`) : la supervision la signale en avertissement.
5. Conserver `CADENCE_CREDENTIALS_KEY` hors du serveur : elle chiffre les clés Buffer et les mots de passe des comptes clients.

## Ensuite, par ordre d'utilité

| Sujet | Pourquoi | Effort indicatif |
| --- | --- | --- |
| Envoi réel des e-mails | Aujourd'hui aucun e-mail ne part : les clients ne sont prévenus que s'ils ouvrent Cadence. Il faut un service d'envoi (`NOTIFICATIONS_MODE=webhook`) et quitter le profil « pilot ». | 0,5 à 1 jour |
| Changement de mot de passe par le client | Aujourd'hui seul l'administrateur génère et renouvelle les mots de passe. | 0,5 à 1 jour |
| Retrait du tag après accord | Le tag « À valider » reste sur la publication programmée. Le retirer serait une seconde écriture vers Buffer. | 0,5 jour |
| Publication modifiée après programmation | Signalée, jamais repassée en brouillon. La repasser automatiquement en brouillon serait une autre écriture. | 0,5 à 1 jour |
| Formats non vérifiés en réel | Vidéos, documents, publications sans texte, stabilité des adresses de médias. | 0,5 jour avec un compte de test |
| Retrait des écritures inutilisées du contrat | `createDraft`, `updateDraft`, `rescheduleDraft`, `unschedulePost` n'ont plus d'appelant et sont refusées par le client Buffer. | 0,5 à 1 jour |
| Nettoyage SQL différé | Tables et fonctions du Studio et de la programmation automatique : conservées, inutilisées. À retirer par une migration dédiée, après sauvegarde restaurée. | 0,5 à 1 jour |
| Documents historiques | `TESTING.md`, `CLEANUP_REPORT.md`, `NIGHT_REPORT.md`, `ROADMAP.md`, `docs/STUDIO.md`, `docs/N8N.md`, `docs/PILOTE.md` décrivent des états antérieurs : à archiver. | 0,5 jour |

## Consigne de reprise pour Claude Code / Codex

Commencer par `cd /home/ubuntu/cadence`, lire `PROJECT_STATUS.md`, vérifier `git status --short --branch`. Utiliser une pile de test neuve pour chaque suite qui écrit. Ne rien publier ni déployer sans accord explicite.
