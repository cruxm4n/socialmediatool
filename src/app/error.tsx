"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/** Affiché quand une page échoue (base injoignable, par exemple) : jamais d'écran d'erreur brut. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-display text-3xl font-medium">Une erreur est survenue</p>
      <p className="max-w-md text-muted-foreground">
        La page n&apos;a pas pu être chargée. Vos données ne sont pas touchées : réessayez dans un instant.
      </p>
      {error.digest && <p className="font-mono text-xs text-muted-foreground">Référence : {error.digest}</p>}
      <Button size="lg" onClick={reset}>
        Réessayer
      </Button>
    </main>
  );
}
