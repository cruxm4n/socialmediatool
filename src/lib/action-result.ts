/** Résultat renvoyé par une action serveur à l'interface. */
export interface ActionResult {
  ok: boolean;
  message: string;
  /** La session n'existe plus : l'interface renvoie vers la connexion. */
  expired?: boolean;
}

/**
 * À appeler dans le navigateur après chaque action : si la session a expiré,
 * on quitte la page plutôt que de laisser l'utilisateur agir dans le vide.
 */
export function leaveIfExpired(result: { expired?: boolean }): boolean {
  if (!result.expired) return false;
  // Rechargement complet voulu : il efface tout ce que le navigateur gardait de l'ancienne session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/connexion");
  return true;
}
