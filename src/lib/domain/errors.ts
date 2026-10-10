/**
 * Retrouve le code d'erreur renvoyé par une fonction SQL (« not_found », « user_not_found »…) dans
 * le message de la base. La recherche se fait mot entier : « not_found » ne doit pas être reconnu
 * dans « user_not_found », ni « invalid_media » dans « invalid_media_type ».
 */
export function errorCodeIn(message: string | undefined, codes: Iterable<string>): string | undefined {
  if (!message) return undefined;
  let best: string | undefined;
  for (const code of codes) {
    if (new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`).test(message) && (!best || code.length > best.length)) best = code;
  }
  return best;
}
