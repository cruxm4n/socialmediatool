"use client";

import { Check, ChevronsUpDown, Layers } from "lucide-react";

import { OrgAvatar } from "@/components/shared/org-avatar";
import { useAdmin } from "@/components/shell/admin-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function OrgSwitcher() {
  const { organizations, orgFilter, setOrgFilter } = useAdmin();
  const current = organizations.find((item) => item.id === orgFilter);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Sélectionner un client"
        className="flex h-9 min-w-0 items-center gap-2 rounded-lg border bg-card px-2 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:pr-2.5"
      >
        {current ? (
          <OrgAvatar organization={current} size="sm" />
        ) : (
          <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Layers className="size-3.5" />
          </span>
        )}
        <span className="hidden max-w-40 truncate sm:block">{current?.name ?? "Tous les clients"}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Afficher les données de</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setOrgFilter("all")}>
          <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Layers className="size-3.5" />
          </span>
          <span className="flex-1">Tous les clients</span>
          {orgFilter === "all" && <Check className="size-4" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {organizations.map((organization) => (
          <DropdownMenuItem key={organization.id} onSelect={() => setOrgFilter(organization.id)}>
            <OrgAvatar organization={organization} size="sm" />
            <span className="flex-1 truncate">{organization.name}</span>
            {orgFilter === organization.id && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
