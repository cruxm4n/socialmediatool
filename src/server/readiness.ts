import "server-only";

import { MissingFunctionError, rpc } from "@/server/automation-rpc";
import { credentialKeyAvailable } from "@/server/credentials";
import { bufferModeProblem } from "@/server/env";

/*
 * Contrôle de PRÉPARATION (≠ liveness) : l'application est-elle en état de servir ? Il vérifie la configuration, la
 * joignabilité de la base avec le secret d'automatisation, et la présence des migrations requises.
 * Il n'appelle JAMAIS Buffer (pas de consommation de quota à chaque contrôle) et ne renvoie que des noms de
 * contrôles et des booléens : aucune valeur de configuration, aucune clé, aucun détail de schéma.
 */

export interface ReadinessCheck {
  name: string;
  ok: boolean;
}

export interface Readiness {
  ready: boolean;
  version: string;
  checks: ReadinessCheck[];
}

const present = (name: string) => (process.env[name] ?? "").trim().length > 0;

export function configurationChecks(): ReadinessCheck[] {
  const real = process.env.BUFFER_MODE === "real";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = parsed.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    validUrl = false;
  }
  const pilot = process.env.CADENCE_PROFILE === "pilot";
  return [
    { name: "configuration : adresse Supabase valide (HTTPS, ou boucle locale)", ok: validUrl },
    { name: "configuration : clé publique Supabase", ok: present("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") },
    { name: "configuration : secret d'automatisation", ok: present("AUTOMATION_SECRET") && (process.env.AUTOMATION_SECRET ?? "").length >= 24 },
    { name: "configuration : mode Buffer explicite (mock ou real)", ok: ["mock", "real"].includes(process.env.BUFFER_MODE ?? "") },
    // En production, le Buffer simulé n'est jamais choisi en silence : il exige une autorisation explicite.
    { name: "configuration : aucun Buffer simulé en production sans autorisation explicite (CADENCE_ALLOW_SIMULATED_BUFFER)", ok: bufferModeProblem() === null },
    // Les clés Buffer sont propres à chaque connexion et chiffrées : en mode réel, la clé de chiffrement est requise.
    { name: "configuration : clé de chiffrement des connexions présente en mode réel (CADENCE_CREDENTIALS_KEY)", ok: !real || credentialKeyAvailable() },
    // Profil pilote : notifications simulées et contenu minimal imposés par env.ts ; un réglage contraire est une
    // erreur de configuration à corriger (il ne produirait de toute façon aucun envoi).
    { name: "profil pilote : aucun réglage d'envoi réel ni de contenu détaillé", ok: !pilot || (process.env.NOTIFICATIONS_MODE !== "webhook" && process.env.NOTIFICATIONS_CONTENT !== "full") },
    { name: "adresse publique de l'application (APP_URL) définie en HTTPS ou boucle locale", ok: !present("APP_URL") || /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)/.test(process.env.APP_URL ?? "") },
  ];
}

export async function readiness(): Promise<Readiness> {
  const checks = configurationChecks();
  const configured = checks.every((check) => check.ok);
  if (!configured) {
    checks.push({ name: "base de données : non vérifiée (configuration incomplète)", ok: false });
  } else {
    try {
      const status = await rpc<{ ready?: boolean; checks?: Record<string, boolean> } | null>("schema_status", {});
      checks.push({ name: "base de données joignable, secret d'automatisation accepté", ok: !!status });
      for (const [level, ok] of Object.entries(status?.checks ?? {})) checks.push({ name: `migration ${level} en place`, ok: ok === true });
      if (!status?.checks) checks.push({ name: "migrations requises vérifiables", ok: false });
      // Cette version route chaque opération par une connexion fournisseur : sans 0012, rien ne peut être envoyé.
      else if (!("0012" in status.checks)) checks.push({ name: "migration 0012 en place", ok: false });
      // Révocation sûre, identité des comptes et collisions refusées : sans 0013, cette version ne doit pas servir.
      else if (!("0013" in status.checks)) checks.push({ name: "migration 0013 en place", ok: false });
      // Accord sans date et tag retiré après accord : sans 0014, le parcours de validation manuelle se bloque.
      else if (!("0014" in status.checks)) checks.push({ name: "migration 0014 en place", ok: false });
    } catch (error) {
      checks.push({ name: error instanceof MissingFunctionError ? "migration 0011 absente (schema_status)" : "base de données joignable", ok: false });
    }
  }
  return { ready: checks.every((check) => check.ok), version: process.env.CADENCE_VERSION ?? "inconnu", checks };
}
