/**
 * Cookies de session : l'attribut « Secure » est posé dès que l'application est servie en HTTPS (derrière un proxy :
 * en-tête X-Forwarded-Proto, ou APP_URL en https). En développement local (HTTP, boucle locale) il est omis, sans
 * quoi le navigateur refuserait le cookie. HttpOnly n'est pas posé : le client Supabase du navigateur doit lire la
 * session (dépôt de médias directement vers le stockage).
 */
export function isHttps(forwardedProto: string | null | undefined, appUrl: string | undefined = process.env.APP_URL): boolean {
  if (forwardedProto) return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  return !!appUrl && appUrl.toLowerCase().startsWith("https://");
}

export function withSecure<T extends Record<string, unknown> | undefined>(options: T, secure: boolean): T & { secure?: boolean } {
  return secure ? { ...(options ?? {}), secure: true } as T & { secure?: boolean } : (options as T & { secure?: boolean });
}
