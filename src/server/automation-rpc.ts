import "server-only";

import { env } from "@/server/env";
import { getAutomationClient } from "@/server/supabase/clients";

/** La fonction SQL demandée n'existe pas : la base n'a pas reçu toutes les migrations. */
export class MissingFunctionError extends Error {}

/** Appelle une fonction SQL d'automatisation, protégée par le secret partagé. */
export async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await getAutomationClient().rpc(name, { p_secret: env.automationSecret, ...params });
  if (error?.code === "PGRST202") {
    throw new MissingFunctionError(`La base de données n'est pas à jour (fonction ${name} absente) : appliquez les migrations de supabase/migrations.`);
  }
  if (error) throw new Error(`Fonction ${name} : ${error.message}`);
  return data as T;
}
