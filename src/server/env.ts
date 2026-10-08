import "server-only";

/** Lecture centralisée de la configuration serveur. Rien ici n'est envoyé au navigateur. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example).`);
  return value;
}

export type BufferMode = "real" | "mock";

export const env = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseKey() {
    return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  get automationSecret() {
    return required("AUTOMATION_SECRET");
  },
  /** Par prudence, tout ce qui n'est pas explicitement « real » utilise le Buffer simulé. */
  get bufferMode(): BufferMode {
    return process.env.BUFFER_MODE === "real" ? "real" : "mock";
  },
  get bufferApiKey() {
    return required("BUFFER_API_KEY");
  },
  get reviewTag() {
    return process.env.BUFFER_REVIEW_TAG || "À valider";
  },
  /** Suffixe des identifiants simulés : chaque série de tests repart de données neuves. */
  get mockRunId() {
    return process.env.MOCK_RUN_ID || "dev";
  },
};
