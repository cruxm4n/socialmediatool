"use client";

import { useEffect } from "react";
import { CloudOff } from "lucide-react";

import { EmptyState } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";

/**
 * Erreur d'une page, affichée à l'intérieur de l'espace (menu et en-tête restent utilisables).
 * Le détail technique part dans la console ; l'utilisateur lit ce qu'il peut faire.
 */
export function SectionError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      icon={CloudOff}
      title="Cette page n'a pas pu être chargée"
      description={`Le chargement n'a pas abouti. Réessayez dans un instant. Si le problème persiste, signalez-le.${error.digest ? ` Référence : ${error.digest}.` : ""}`}
      action={
        <Button size="lg" onClick={reset}>
          Réessayer
        </Button>
      }
    />
  );
}
