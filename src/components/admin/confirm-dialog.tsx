"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Confirmation d'une action qui engage. Avec `phrase`, le bouton ne s'active qu'une fois
 * cette phrase recopiée : c'est la « confirmation renforcée » des transferts de canal.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  destructive = false,
  phrase,
  pending = false,
  disabled = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  phrase?: string;
  pending?: boolean;
  /** Désactive la confirmation tant qu'une condition de l'appelant n'est pas remplie (ex. preuve saisie). */
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = !phrase || typed.trim().toLowerCase() === phrase.trim().toLowerCase();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="grid gap-2 text-sm text-muted-foreground">{children}</div>
          </DialogDescription>
        </DialogHeader>
        {phrase && (
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-phrase">
              Pour confirmer, saisissez <span className="font-semibold text-foreground">{phrase}</span>
            </Label>
            <Input id="confirm-phrase" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Annuler
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={!ready || pending || disabled}>
            {pending ? "En cours…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
