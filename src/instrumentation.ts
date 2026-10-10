/*
 * Démarrage du serveur : lance la boucle du traitement urgent (annulations à confirmer, réservations abandonnées).
 * Elle redémarre avec le serveur et rattrape donc, dès le démarrage, ce qu'un arrêt brutal avait laissé en cours.
 * URGENT_LOOP=off la désactive (suites de tests qui pilotent le traitement elles-mêmes).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.URGENT_LOOP === "off") return;
  // Sans configuration (image construite sans variables, aperçu) : rien à surveiller.
  if (!process.env.AUTOMATION_SECRET || !process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  const { startUrgentLoop } = await import("@/server/urgent-loop");
  const { runUrgent } = await import("@/server/urgent");
  startUrgentLoop(() => runUrgent(), {
    onError: (error) => console.error(`[urgent] passage en erreur : ${error instanceof Error ? error.message : "erreur inconnue"}`),
  });
}
