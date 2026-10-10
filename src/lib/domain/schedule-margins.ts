/*
 * Marges temporelles de la chaîne « envoi → approbation → programmation → compensation ».
 *
 * Elles sont étagées volontairement : un contenu envoyé en validation doit encore pouvoir être approuvé, et un
 * contenu approuvé doit encore pouvoir être programmé, avec de quoi compenser une programmation devenue illégitime
 * avant l'échéance. Les mêmes valeurs figurent en SQL (voir tests/unit/schedule-margins.test.ts, qui les compare).
 *
 *   envoi du Studio (studio_claim_push) ........ 15 min   >
 *   approbation par le client (decide_post) .... 10 min   >
 *   réservation de programmation (claim) ....... 5 min
 *
 * Compensation : une confirmation périmée déclenche une déprogrammation IMMÉDIATE (sync.ts). Si elle échoue, l'état
 * « annulation à confirmer » reste en base et la reprise passe en premier à chaque cycle. La marge de réservation
 * (5 min) est la fenêtre minimale laissée à cette compensation avant l'échéance : elle ne la garantit pas si Buffer
 * reste injoignable, c'est pourquoi l'échec est visible (anomalie de synchronisation) et jamais présenté comme annulé.
 */
const MINUTE = 60_000;

/**
 * Profil pilote (CADENCE_PROFILE=pilot) : toute programmation ou reprogrammation exige une échéance à plus de 24 h.
 * Vérifiée À CHAQUE programmation (réservation), reprogrammation et envoi du Studio — pas seulement à la rédaction :
 * un accord ancien repris tardivement ne peut pas contourner la règle. Précaution de pilote, pas une garantie de
 * compensation (voir D33).
 */
export const PILOT_MIN_LEAD_MS = 24 * 60 * MINUTE;

/** true si l'échéance respecte la marge du profil pilote (à `now`). */
export function pilotLeadSatisfied(dueAt: string | null, now: number = Date.now()): boolean {
  return dueAt !== null && Date.parse(dueAt) - now >= PILOT_MIN_LEAD_MS;
}

/** Un contenu du Studio doit être daté plus de 15 minutes après l'envoi. */
export const STUDIO_MIN_LEAD_MS = 15 * MINUTE;
/** Une approbation exige une échéance à plus de 10 minutes. */
export const APPROVAL_MIN_LEAD_MS = 10 * MINUTE;
/** Une réservation de programmation exige une échéance à plus de 5 minutes. */
export const SCHEDULING_MIN_LEAD_MS = 5 * MINUTE;
