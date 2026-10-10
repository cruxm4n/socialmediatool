"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { OrgAvatar } from "@/components/shared/org-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { leaveIfExpired } from "@/lib/action-result";
import { CLIENT_COLORS, CLIENT_TIMEZONES, initialsFor, slugify } from "@/lib/domain/clients";
import type { Organization } from "@/lib/types";
import { cn } from "@/lib/utils";
import { saveOrganization } from "@/server/actions";

/** Création (sans `organization`) ou modification d'un client. */
export function ClientFormDialog({ organization, open, onOpenChange }: { organization?: Organization; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(organization?.name ?? "");
  const [sector, setSector] = useState(organization?.sector ?? "");
  const [timezone, setTimezone] = useState(organization?.timezone ?? CLIENT_TIMEZONES[0]);
  const [color, setColor] = useState(organization?.color ?? CLIENT_COLORS[0]);
  const [error, setError] = useState<string | null>(null);

  const timezones = (CLIENT_TIMEZONES as readonly string[]).includes(timezone) ? CLIENT_TIMEZONES : [timezone, ...CLIENT_TIMEZONES];
  const colors = (CLIENT_COLORS as readonly string[]).includes(color) ? CLIENT_COLORS : [color, ...CLIENT_COLORS];

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveOrganization({ id: organization?.id, name, sector, timezone, color });
        if (leaveIfExpired(result)) return;
        if (!result.ok) return setError(result.message);
        toast.success(result.message);
        onOpenChange(false);
        if (!organization && result.id) router.push(`/admin/clients/${result.id}`);
      } catch {
        setError("La connexion a été interrompue. Vérifiez la liste des clients avant de réessayer.");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{organization ? "Modifier le client" : "Nouveau client"}</DialogTitle>
            <DialogDescription>
              {organization ? "L'adresse de son espace ne change pas." : "Vous lui attribuerez ensuite ses canaux et ses utilisateurs."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-3">
            <OrgAvatar organization={{ name, color, initials: initialsFor(name) || "?" }} size="lg" />
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Label htmlFor="client-name">Nom</Label>
              <Input id="client-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus />
            </div>
          </div>
          {!organization && name.trim() && (
            <p className="-mt-2 text-xs text-muted-foreground">
              Espace client : <span className="font-mono">/client/{slugify(name) || "…"}</span>
            </p>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="client-sector">Secteur d&apos;activité</Label>
            <Input id="client-sector" value={sector} onChange={(event) => setSector(event.target.value)} maxLength={80} placeholder="Facultatif" />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="client-timezone">Fuseau horaire d&apos;affichage</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="client-timezone" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timezones.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Couleur</legend>
            <div className="flex flex-wrap gap-2">
              {colors.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-label={`Couleur ${item}`}
                  aria-pressed={color === item}
                  onClick={() => setColor(item)}
                  style={{ backgroundColor: item }}
                  className={cn("size-8 rounded-full outline-none ring-offset-2 ring-offset-popover focus-visible:ring-3 focus-visible:ring-ring/50", color === item && "ring-2 ring-foreground")}
                />
              ))}
            </div>
          </fieldset>

          {error && (
            <p role="alert" className="rounded-lg bg-tone-red-soft px-3 py-2 text-sm text-tone-red">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Annuler
            </Button>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {pending ? "Enregistrement…" : organization ? "Enregistrer" : "Créer le client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
