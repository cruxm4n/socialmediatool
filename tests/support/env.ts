import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Charge .env.test.local (base de test locale, voir docs/BASE_DE_TEST.md) puis .env.local dans
 * process.env, sans écraser ce qui est déjà défini. Le premier fichier ne contient que des variables
 * TEST_* : il ne peut donc jamais remplacer la configuration de l'application.
 */
export function loadLocalEnv(): void {
  // Mission V3 : un contexte de test propre (sans .env.local) n'ouvre jamais ces fichiers.
  if (process.env.CADENCE_NO_LOCAL_ENV === "1") return;
  for (const file of [".env.test.local", ".env.local"]) {
    let content: string;
    try {
      content = readFileSync(resolve(process.cwd(), file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable manquante pour les tests : ${name} (voir .env.example).`);
  return value;
}

/** Les suites qui écrivent exigent des identifiants de test distincts de ceux de l'application. */
export function configureIsolatedTests(): void {
  const testUrl = requireEnv("TEST_SUPABASE_URL");
  const target = new URL(testUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (!["https:", "http:"].includes(target.protocol) || (!local && target.protocol !== "https:")) {
    throw new Error("La base de test doit utiliser HTTPS, ou HTTP sur la boucle locale.");
  }
  const appUrl = process.env.TEST_ORIGINAL_APP_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!local && appUrl && new URL(appUrl).origin === target.origin) {
    throw new Error("Tests refusés : la base de test distante est celle de l'application. Utilisez un projet Supabase isolé.");
  }
  const names = [
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "AUTOMATION_SECRET",
    ...["ADMIN", "INES", "HUGO", "SOFIA"].flatMap((user) => [`DEMO_${user}_EMAIL`, `DEMO_${user}_PASSWORD`]),
  ];
  // Vérifier toute la configuration avant de modifier process.env.
  const values = names.map((name) => [name, requireEnv(name === "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" ? "TEST_SUPABASE_PUBLISHABLE_KEY" : `TEST_${name}`)]);
  process.env.TEST_ORIGINAL_APP_SUPABASE_URL = appUrl ?? "";
  for (const [name, value] of values) process.env[name] = value;
  process.env.NEXT_PUBLIC_SUPABASE_URL = testUrl;
  process.env.BUFFER_MODE = "mock";
  // Aucun test ne doit disposer d'une clé Buffer réelle.
  // Une valeur vide empêche également Next.js de recharger cette clé depuis .env.local.
  process.env.BUFFER_API_KEY = "";
}
