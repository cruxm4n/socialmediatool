/*
 * Démarrage du serveur. Cadence ne fait que LIRE Buffer : il n'y a plus de programmation à annuler ni de réservation
 * à rattraper en urgence, donc aucune boucle de fond n'est lancée (elle interrogerait Buffer toutes les 30 secondes
 * pour rien et consommerait le quota du compte). Les publications programmées sans accord valable sont constatées à
 * chaque synchronisation, et à la demande par POST /api/automation/urgent.
 */
export async function register() {}
