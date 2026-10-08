# Décisions structurantes

Chaque entrée : la décision, sa raison, et ce qu'elle coûte.

## D1 — Calendrier sur mesure plutôt que FullCalendar

**Décision.** Le calendrier est un composant maison, en lecture seule.

**Pourquoi.** Les besoins sont simples (un mois, une semaine, des miniatures, des filtres) et un composant maison s'accorde avec le reste de l'interface. Le glisser-déposer du prototype a été retiré lors du recentrage (D10) : les dates se modifient dans Buffer.

## D2 — (abandonnée) Date fictive figée

Le prototype utilisait une date simulée. Depuis le passage aux données réelles, l'application utilise l'heure réelle. Les publications du Buffer simulé sont datées par rapport au jour courant.

## D3 — Règles métier dans des fonctions pures

**Décision.** Transitions de statut, règles de déplacement et contraintes par réseau vivent dans `src/lib/domain/`, sans dépendance à l'interface ni à la base.

**Pourquoi.** Elles sont testables isolément. Les règles qui engagent la sécurité ou la cohérence (qui peut décider, quoi programmer) sont, elles, dans des fonctions SQL : voir D11.

## D4 — La date fait partie de ce que le client valide

**Décision.** L'empreinte validée couvre le texte, les médias, le canal et la date (à la minute). Changer l'un d'eux dans Buffer annule la validation.

**Pourquoi.** Une approbation ne doit jamais couvrir un contenu modifié après coup. C'est le choix le plus sûr.

**Coût.** Décaler une publication d'une heure redemande une validation.

## D5 — Le client ne voit pas les brouillons

**Décision.** Un brouillon Buffer n'est transmis au client que s'il porte le tag « À valider ». La règle est appliquée par la base (RLS), pas par l'interface.

**Pourquoi.** Un brouillon est un document de travail de l'agence. Le tag vous laisse décider du moment, sans quitter Buffer.

## D6 — Pictogrammes de réseaux dessinés pour le projet

**Décision.** Les icônes des quatre réseaux sont des dessins simplifiés maison.

**Pourquoi.** Lucide ne fournit plus d'icônes de marques, et le cahier des charges demande de ne pas reprendre de ressources propriétaires.

## D7 — Serveur de développement limité à la machine locale

**Décision.** `npm run dev` et `npm run start` écoutent sur `127.0.0.1` uniquement.

**Pourquoi.** Par défaut Next.js écoute sur toutes les interfaces réseau. Sur une machine joignable depuis Internet, le prototype serait alors exposé.

## D8 — npm comme gestionnaire de paquets

**Décision.** npm, déjà installé. Pas de pnpm ni de yarn.

**Pourquoi.** Un outil de moins à installer et à comprendre.

## D9 — Typographies Instrument Sans et Fraunces

**Décision.** Instrument Sans pour l'interface, Fraunces (serif) pour les titres.

**Pourquoi.** Le duo donne un caractère éditorial et évite l'allure de gabarit d'administration. Les polices sont téléchargées à la compilation puis servies par l'application, sans appel à Google pour les visiteurs.

## D10 — Buffer crée et publie, Cadence valide

**Décision.** Cadence ne crée, ne modifie et ne date aucune publication. L'éditeur, l'envoi de médias, le glisser-déposer, les idées et la médiathèque du prototype ont été supprimés.

**Pourquoi.** Buffer fait déjà tout cela, mieux, et gère les connexions aux réseaux. Refaire ces fonctions aurait coûté des semaines pour un résultat inférieur.

**Coût.** Deux outils pour vous (Buffer pour produire, Cadence pour suivre les validations). Les limites de Buffer deviennent celles du produit : voir docs/BUFFER.md.

## D11 — Les règles sensibles vivent dans des fonctions SQL

**Décision.** Synchronisation, décision du client, réservation avant programmation : chacune est une fonction SQL exécutée en une transaction.

**Pourquoi.** Trois raisons. Elles sont atomiques, donc deux validations ou deux programmations simultanées ne peuvent pas se marcher dessus. Elles s'appliquent quel que soit l'appelant, application aujourd'hui, n8n demain. Et l'isolation entre clients ne dépend d'aucun code d'interface.

**Coût.** Du SQL à maintenir, moins familier que du TypeScript. Il est couvert par 22 tests d'intégration.

## D12 — Un secret partagé plutôt que la clé « service role » de Supabase

**Décision.** Les fonctions d'automatisation sont appelables avec la clé publique, mais exigent un secret dont seule l'empreinte est en base.

**Pourquoi.** La clé « service role » contourne toutes les règles de sécurité : une fuite donnerait accès à tout. Le secret ne donne accès qu'à cinq fonctions précises. Il servira tel quel à n8n.

**Coût.** Le conseiller de sécurité Supabase signale ces fonctions comme « appelables sans connexion ». C'est attendu. Si le secret fuit, quelqu'un pourrait injecter de faux posts ou marquer des posts comme programmés : le changer alors dans `.env.local` et dans `private.app_secrets`.

## D13 — Aucune suppression de données

**Décision.** Aucune fonction ne supprime de ligne. Un post disparu de Buffer est marqué `removed_at`. Les données du Buffer simulé (préfixe `mock-`) sont écartées par un filtre selon le mode, pas effacées.

**Pourquoi.** L'historique des validations doit rester consultable. Et l'outil utilisé pour appliquer les migrations exige votre confirmation pour toute requête destructive : une première version qui effaçait les données de test a été refusée, d'où ce choix.

**Coût.** Les données de test s'accumulent dans la base de développement. Pour nettoyer : `delete from public.channels where buffer_channel_id like 'mock-%';` dans l'éditeur SQL de Supabase.

## D14 — Prérendu de Next.js désactivé

**Décision.** L'option `cacheComponents`, activée par défaut à la création du projet, est désactivée.

**Pourquoi.** Chaque page dépend de l'utilisateur connecté : il n'y a rien à prérendre, et l'option imposait des contournements sur toutes les pages.

## D15 — La validation porte sur une publication, pas sur une campagne

**Décision.** Le client valide chaque publication Buffer séparément (une par canal).

**Pourquoi.** C'est l'unité de Buffer, et une validation par publication résiste aux modifications : changer le texte LinkedIn n'annule pas la validation Instagram.

**Coût.** Une campagne sur quatre réseaux demande quatre validations. Un bouton « tout approuver » est envisageable.
