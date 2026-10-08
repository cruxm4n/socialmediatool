"use client";

import { LogOut } from "lucide-react";

import { PersonAvatar } from "@/components/shared/org-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Profile } from "@/lib/types";
import { signOut } from "@/server/actions";

export function UserMenu({ profile }: { profile: Profile }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Menu du profil"
        className="shrink-0 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <PersonAvatar profile={profile} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-sm font-semibold text-foreground">{profile.fullName}</span>
          <span className="block text-xs text-muted-foreground">
            {profile.jobTitle} · {profile.role === "admin" ? "Administrateur" : "Client"}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="size-4" />
          Se déconnecter
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
