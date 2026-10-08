"use client";

import { createContext, useContext, useMemo, useState } from "react";

import type { Organization, Profile } from "@/lib/types";

export type OrgFilter = "all" | "unassigned" | string;

interface AdminContextValue {
  profile: Profile;
  organizations: Organization[];
  /** « real » : Buffer réel. « mock » : Buffer simulé. */
  mode: "real" | "mock";
  lastSyncAt: string | null;
  lastSyncFailed: boolean;
  /** Client sélectionné dans l'en-tête. */
  orgFilter: OrgFilter;
  setOrgFilter: (value: OrgFilter) => void;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({
  children,
  ...value
}: Omit<AdminContextValue, "orgFilter" | "setOrgFilter"> & { children: React.ReactNode }) {
  const [orgFilter, setOrgFilter] = useState<OrgFilter>("all");
  const { profile, organizations, mode, lastSyncAt, lastSyncFailed } = value;
  const context = useMemo(
    () => ({ profile, organizations, mode, lastSyncAt, lastSyncFailed, orgFilter, setOrgFilter }),
    [profile, organizations, mode, lastSyncAt, lastSyncFailed, orgFilter],
  );
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
