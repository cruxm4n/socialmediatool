# Parcours Studio historiques

Ces deux parcours restent conservés avec leurs assertions, mais sont hors du `testDir` Playwright actif : ils exigent l'éditeur retiré du portail. Ils ne constituent pas des tests réussis du nouveau périmètre. Pour examiner le comportement ancien, utiliser un checkout isolé de `09cdeb1` et une base de test neuve ; ne jamais réactiver le Studio sur la production pour les exécuter.

Les tests unitaires, SQL et contre-tests du moteur historique restent dans les suites actives. Les fixtures et mocks sont conservés. Le parcours de remplacement est `tests/e2e/06-portal-readonly.spec.ts` ; les validations, commentaires, versions et permissions restent couverts par les autres parcours actifs.
