import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: { key: string; instance: SupabaseClient } | null = null;

/**
 * Client Supabase du navigateur, lié à la session de l'utilisateur connecté.
 * Sert uniquement au dépôt de médias : un fichier volumineux va directement du navigateur à
 * l'espace de stockage, sans transiter par le serveur de l'application. Les droits sont ceux de la
 * base (règles sur storage.objects) ; l'adresse et la clé « publishable » sont publiques par nature.
 *
 * Elles sont transmises par le serveur À L'EXÉCUTION (voir AdminProvider), et non lues dans
 * process.env.NEXT_PUBLIC_*, qui serait figé à la compilation : l'image Docker est construite sans
 * configuration.
 */
export function getBrowserClient(config: { url: string; key: string }): SupabaseClient {
  const id = `${config.url}|${config.key}`;
  if (client?.key !== id) client = { key: id, instance: createBrowserClient(config.url, config.key, { cookieOptions: { secure: typeof window !== "undefined" && window.location.protocol === "https:" } }) };
  return client.instance;
}
