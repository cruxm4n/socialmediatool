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
  /** Intervalle du planificateur, en minutes : sert à dire si les données sont « en retard ». */
  get syncIntervalMinutes() {
    const value = Number(process.env.SYNC_INTERVAL_MINUTES);
    return Number.isFinite(value) && value >= 1 ? Math.round(value) : 5;
  },
  /**
   * Profil du déploiement. « pilot » (premier client) impose la simulation des notifications et leur contenu minimal,
   * quelles que soient les autres variables : un réglage oublié ou copié ne peut pas ouvrir un envoi réel.
   */
  get profile(): "pilot" | "standard" {
    return process.env.CADENCE_PROFILE === "pilot" ? "pilot" : "standard";
  },
  /** « simulate » (défaut) : aucune notification ne sort du serveur. « webhook » : envoi réel (jamais au profil pilote). */
  get notificationMode(): "simulate" | "webhook" {
    if (process.env.CADENCE_PROFILE === "pilot") return "simulate";
    return process.env.NOTIFICATIONS_MODE === "webhook" ? "webhook" : "simulate";
  },
  /**
   * « minimal » (défaut) : les notifications ne contiennent aucun texte de publication ni commentaire, seulement un
   * lien vers une page qui exige une session autorisée. « full » : contenu inclus, déconseillé tant qu'un accès
   * retiré peut précéder la lecture d'un message déjà remis à un prestataire d'e-mail.
   */
  get notificationContent(): "minimal" | "full" {
    if (process.env.CADENCE_PROFILE === "pilot") return "minimal";
    return process.env.NOTIFICATIONS_CONTENT === "full" ? "full" : "minimal";
  },
  get notificationWebhookUrl() {
    return process.env.NOTIFICATIONS_WEBHOOK_URL || null;
  },
  get notificationWebhookSecret() {
    return process.env.NOTIFICATIONS_WEBHOOK_SECRET || null;
  },
  /** Adresse publique de l'application, pour les liens des notifications. null : messages sans lien. */
  get appUrl() {
    return process.env.APP_URL || null;
  },
  /** Suffixe des identifiants simulés : chaque série de tests repart de données neuves. */
  get mockRunId() {
    return process.env.MOCK_RUN_ID || "dev";
  },
};
