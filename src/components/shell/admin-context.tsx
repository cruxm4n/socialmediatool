"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { SyncStatus } from "@/lib/domain/sync-health";
import type { Organization, Profile } from "@/lib/types";

export type OrgFilter = "all" | "unassigned" | string;

interface AdminContextValue {
  profile: Profile;
  organizations: Organization[];
  /** « real » : Buffer réel. « mock » : Buffer simulé. */
  mode: "real" | "mock";
  /** État de Buffer sur ce serveur : comptes utilisables, envoi activé ou non, configuration invalide. */
  buffer: { accounts: number; writesEnabled: boolean; problem: string | null };
  /** Adresse et clé publiques de Supabase, pour le dépôt de médias depuis le navigateur. */
  supabase: { url: string; key: string };
  /** État de la synchronisation avec Buffer, lu au rendu de la page. */
  sync: SyncStatus;
  syncIntervalMinutes: number;
  /** Instant du rendu côté serveur : serveur et navigateur affichent la même ancienneté. */
  renderedAt: string;
  /** Dernière tentative de synchronisation, réussie ou non. null : jamais. */
  lastSyncAt: string | null;
  /** Client sélectionné dans l'en-tête. */
  orgFilter: OrgFilter;
  setOrgFilter: (value: OrgFilter) => void;
}

const ORG_FILTER_KEY = "cadence:client";

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({
  children,
  ...value
}: Omit<AdminContextValue, "orgFilter" | "setOrgFilter" | "lastSyncAt"> & { children: React.ReactNode }) {
  const [orgFilter, setFilter] = useState<OrgFilter>("all");
  // Le client choisi est retrouvé après un rechargement ; lu après l'affichage pour que serveur et navigateur rendent la même page.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ORG_FILTER_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- lecture unique d'un réglage du navigateur
      if (saved && (saved === "unassigned" || value.organizations.some((organization) => organization.id === saved))) setFilter(saved);
    } catch {
      // Stockage indisponible (navigation privée) : le filtre repart simplement de « Tous les clients ».
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- au montage uniquement
  }, []);
  const setOrgFilter = useCallback((next: OrgFilter) => {
    setFilter(next);
    try {
      window.localStorage.setItem(ORG_FILTER_KEY, next);
    } catch {
      // Sans stockage, le choix vaut pour la visite en cours.
    }
  }, []);
  const { profile, organizations, mode, sync, syncIntervalMinutes, renderedAt, supabase } = value;
  const { accounts, writesEnabled, problem } = value.buffer;
  const context = useMemo(() => {
    const attempts = [sync.lastSuccessAt, sync.lastFailureAt].filter((item): item is string => item !== null).sort();
    return {
      profile, organizations, mode, buffer: { accounts, writesEnabled, problem }, sync, syncIntervalMinutes, renderedAt, supabase,
      lastSyncAt: attempts.at(-1) ?? null, orgFilter, setOrgFilter,
    };
  }, [profile, organizations, mode, accounts, writesEnabled, problem, sync, syncIntervalMinutes, renderedAt, supabase, orgFilter, setOrgFilter]);
  return <AdminContext.Provider value={context}>{children}</AdminContext.Provider>;
}

export function useAdmin(): AdminContextValue {
  const context = useContext(AdminContext);
  if (!context) throw new Error("useAdmin doit être utilisé dans <AdminProvider>.");
  return context;
}

/** Applique le filtre de client de l'en-tête à une liste de posts. */
export function matchesOrgFilter(filter: OrgFilter, organizationId: string | null | undefined): boolean {
  if (filter === "all") return true;
  if (filter === "unassigned") return !organizationId;
  return organizationId === filter;
}
