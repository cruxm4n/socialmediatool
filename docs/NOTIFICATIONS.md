# Notifications

**État : développées et testées localement, en mode simulation. Aucun e-mail n'a été envoyé, et aucun ne partira tant que les trois réglages de la fin de cette page ne sont pas faits.**

## Qui est prévenu de quoi

| Événement | Destinataire | Par défaut |
| --- | --- | --- |
| Une publication est soumise à validation, ou doit être revalidée après un changement | Les utilisateurs du client concerné | Activé |
| Le client demande des modifications | L'administrateur (avec le commentaire du client) | Activé |
| Le client approuve une publication | L'administrateur | **Désactivé** (facultatif) |
| Buffer refuse une programmation, ou signale un échec de publication | L'administrateur (avec le motif) | Activé |

Chacun règle ses notifications dans l'application : **Notifications** dans le menu de l'administrateur, ou dans le menu du profil côté client.

## Comment ça marche

```
historique d'une publication ──déclencheur SQL──► file d'attente (table notifications)
                                                        │  réservée par le serveur
                                                        ▼
                             regroupement : un message par destinataire et par type
                                                        │
                        ┌───────────────────────────────┴───────────────────────────┐
                 mode simulation (défaut)                                     mode webhook
        marquée « simulée », rien ne sort                    POST vers n8n, qui expédie l'e-mail
```

- **Anti-doublon.** Une clé unique (type, publication, version, destinataire) empêche de notifier deux fois le même fait : resynchroniser ne renvoie rien, cinq tentatives de programmation en échec donnent une seule alerte.
- **Regroupement.** Dix publications soumises d'un coup donnent un seul e-mail.
- **Pas de message périmé.** Une demande de validation est annulée, et non envoyée, si la publication a entre-temps été validée, retirée ou supprimée.
- **Mêmes règles que la visibilité.** Un client archivé, ou le nouveau client d'un canal transféré, n'est jamais prévenu d'une publication qu'il ne peut pas voir.
- **Quand ?** À la fin de chaque synchronisation, et juste après une décision du client.
- **Échec d'envoi.** Marqué « Échec » avec son motif, retenté au bout de quinze minutes, cinq fois au plus.
- **Historique.** Écran Notifications : date, type, destinataire, publication, état (en attente, simulée, envoyée, échec, annulée).
- **Données simulées.** Les publications fictives du Buffer simulé ne déclenchent jamais d'envoi réel, quel que soit le réglage.

## Pourquoi un webhook et pas un service d'e-mail

Aucun service payant n'est nécessaire et aucune bibliothèque n'est ajoutée : Cadence remet le message à n8n, déjà présent sur votre serveur, qui l'envoie avec votre propre messagerie (SMTP). Changer de moyen d'envoi plus tard ne demande aucun changement dans Cadence.

Le message envoyé au webhook :

```json
{ "to": "ines@client.fr", "name": "Inès Martin", "kind": "review_requested",
  "subject": "2 publications à valider", "text": "Bonjour Inès, …", "deliveryId": "…",
  "url": "https://…/client/maison-colibri/a-valider", "items": [{ "postId": "…", "title": "", "network": "", "dueAt": null, "organization": null, "detail": null, "url": "…" }] }
```

En-tête `Idempotency-Key` et champ `deliveryId` : empreinte stable du lot (identifiants de notifications). Si la confirmation locale d'un envoi est perdue, le lot est repris et porte **la même clé** : le récepteur (n8n) peut dédoublonner. La déduplication en base n'empêche pas un prestataire de remettre deux fois ce qu'on lui envoie deux fois ; cette clé le permet, elle ne le garantit pas.

## Passer à l'envoi réel — à faire par vous, dans cet ordre

1. Appliquer la migration `0007_notifications.sql`. À partir de là, les notifications s'enregistrent en « simulée » : vérifier dans l'écran Notifications qu'elles correspondent à ce que vous attendez.
2. Dans n8n : importer `docs/n8n/cadence-notifications.json`, créer l'identifiant « Header Auth » `x-cadence-secret` et l'identifiant SMTP, corriger l'adresse d'expédition, activer.
3. Dans la configuration de l'application, puis redémarrer :

```bash
NOTIFICATIONS_MODE=webhook
NOTIFICATIONS_WEBHOOK_URL=https://<votre-n8n>/webhook/cadence-notifications
NOTIFICATIONS_WEBHOOK_SECRET=<la même valeur que dans n8n>
APP_URL=https://<adresse-publique-de-cadence>     # pour les liens des e-mails
```

### Contenu des messages et remise (deuxième stabilisation)

- `NOTIFICATIONS_CONTENT=minimal` (défaut) : aucun texte de publication, titre ni commentaire ne sort du serveur. Le message annonce « une publication LinkedIn à valider » et un lien vers une page qui exige une session autorisée. Une personne dont l'accès a été retiré entre l'envoi et la lecture ne voit rien.
- `NOTIFICATIONS_CONTENT=full` : le contenu est inclus. **Déconseillé** : un message déjà remis à un prestataire d'e-mail ne se rappelle pas.
- **Revalidation juste avant la remise** (mission V3, C04) : après la réservation et la composition du message, la base revalide chaque notification du lot (`complete_notifications` avec le statut `verify` : membre du client, rôle, client actif, version, préférences) et **annule** celles qui ne sont plus légitimes ; le lot n'est remis que s'il reste intégralement légitime, sinon il est rendu et recomposé. Une vérification impossible (base injoignable) ne vaut pas autorisation : rien n'est remis. Seul un appel **déjà parti** avant la révocation est irréversible (un message remis à un prestataire ne se rappelle pas).
- Au **profil pilote** (`CADENCE_PROFILE=pilot`), la simulation et le contenu minimal sont imposés par le code : `NOTIFICATIONS_MODE=webhook` ou `NOTIFICATIONS_CONTENT=full` n'y changent rien et font échouer `/api/ready`. Activer l'envoi réel, surtout détaillé, reste une décision externe : non validée par les tests (faux webhook).
- Le message générique ne porte ni objet de publication, ni nom de client, ni date, ni extrait, ni commentaire : sujet « N publications à valider », éléments sans titre ni réseau, liens authentifiés seulement.
- Le serveur remet **un message à la fois** : il réserve le lot, remet le premier, rend les autres à la file, puis réserve de nouveau. La base revalide chaque message (membre du client, client actif, version, préférences, rôle) à chaque réservation. Une révocation pendant l'appel au webhook n'empêche pas ce message déjà parti, mais aucun des suivants.
- L'atomicité parfaite entre PostgreSQL et le service d'e-mail n'est pas prétendue : si la confirmation d'un envoi est perdue, le message est repris après 10 minutes (au plus 5 tentatives).

Revenir en arrière : remettre `NOTIFICATIONS_MODE=simulate` (ou supprimer la ligne) et redémarrer.

## Limites connues

- Pas de rappel si le client ne répond pas : une seule notification par version soumise.
- Un seul canal : l'e-mail. Le webhook permettrait d'en ajouter d'autres dans n8n (Slack, SMS) sans toucher à Cadence.
- L'adresse utilisée est celle du compte de connexion (Supabase → Authentication).
- L'envoi réel n'a jamais été essayé : il demande n8n et une messagerie, donc votre accord.
