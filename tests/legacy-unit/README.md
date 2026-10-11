# Contre-test indépendant du moteur Studio (archivé)

`audit-independent-studio.test.ts` vérifiait l'envoi d'un contenu du Studio vers Buffer. Le moteur Studio
(`src/server/studio.ts`, `src/server/studio-actions.ts`) a été supprimé lors de la finalisation de la V1 : Cadence ne
fait plus que lire Buffer. Le fichier est conservé tel quel (empreinte inchangée dans `tests/audit-independent.sha256`),
hors des suites actives : il ne peut plus s'exécuter et ne compte pas comme un test réussi du périmètre actuel.
Pour l'exécuter, utiliser un checkout de `68e1e85`.
