import "server-only";

/** Lecture centralisée de la configuration serveur. Rien ici n'est envoyé au navigateur. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example).`);
  return value;
}

export type BufferMode = "real" | "mock";

let warnedAboutDevelopment = false;

/** BUFFER_MODE=real demandé par un serveur de développement sans autorisation explicite. */
export function realBufferBlockedInDevelopment(): boolean {
  const blocked = process.env.BUFFER_MODE === "real" && process.env.NODE_ENV === "development" && process.env.CADENCE_ALLOW_REAL_BUFFER_IN_DEV !== "1";
  if (blocked && !warnedAboutDevelopment) {
    warnedAboutDevelopment = true;
    console.warn("[cadence] BUFFER_MODE=real ignoré en développement : le Buffer simulé est utilisé. (CADENCE_ALLOW_REAL_BUFFER_IN_DEV=1 pour l'autoriser explicitement.)");
  }
  return blocked;
}

/** Le Buffer simulé est-il autorisé sur ce serveur ? Toujours hors production ; en production, sur autorisation explicite. */
export function simulatedBufferAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.CADENCE_ALLOW_SIMULATED_BUFFER === "1";
}

/**
 * Configuration de production invalide pour le fournisseur, ou null. Dans ce cas AUCUNE opération n'a lieu (ni
 * lecture ni écriture) : un mode absent, mal écrit ou une simulation non autorisée ne deviennent jamais un simulateur.
 */
export function bufferModeProblem(): string | null {
  if (process.env.NODE_ENV !== "production") return null;
  const requested = process.env.BUFFER_MODE;
  if (requested === "real") return null;
  if (requested === "mock") {
    return simulatedBufferAllowed() ? null : "BUFFER_MODE=mock est refusé en production sans CADENCE_ALLOW_SIMULATED_BUFFER=1 : aucun fournisseur simulé n'est utilisé.";
  }
  return "BUFFER_MODE doit valoir « real » en production : aucune opération vers Buffer n'a lieu tant qu'il n'est pas défini.";
}

/** Phrase affichée quand une écriture est refusée par la barrière d'activation. */
export const BUFFER_WRITES_DISABLED = "Les écritures vers Buffer ne sont pas activées sur ce serveur (CADENCE_BUFFER_WRITES) : rien n'a été envoyé.";

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
  /**
   * Mode du fournisseur.
   *  - `real` : le vrai Buffer, par les connexions enregistrées (aucune connexion → aucun appel).
   *  - `mock` : le Buffer simulé. Hors production (tests, `next dev`) c'est le défaut. EN PRODUCTION il n'est jamais
   *    choisi en silence : il exige BUFFER_MODE=mock ET CADENCE_ALLOW_SIMULATED_BUFFER=1 (piles de test, démonstration).
   *    Toute autre configuration de production est le mode réel ; si elle est invalide (`bufferModeProblem()`), le
   *    fournisseur est bloqué en entier plutôt que remplacé par un simulateur.
   *  - En développement (`next dev`), BUFFER_MODE=real est IGNORÉ sauf CADENCE_ALLOW_REAL_BUFFER_IN_DEV=1.
   */
  get bufferMode(): BufferMode {
    if (process.env.BUFFER_MODE === "real") return realBufferBlockedInDevelopment() ? "mock" : "real";
    return simulatedBufferAllowed() && (process.env.NODE_ENV !== "production" || process.env.BUFFER_MODE === "mock") ? "mock" : "real";
  },
  /**
   * Barrière d'activation des ÉCRITURES vers le vrai Buffer (créer, modifier, programmer, déprogrammer). Fermée par
   * défaut : connecter un compte et le lire ne suffit pas à autoriser la moindre publication. Elle ne s'ouvre que par
   * CADENCE_BUFFER_WRITES=enabled, décision explicite de l'exploitant. Sans objet pour le Buffer simulé.
   */
  get bufferWritesEnabled(): boolean {
    return this.bufferMode === "mock" || process.env.CADENCE_BUFFER_WRITES === "enabled";
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
