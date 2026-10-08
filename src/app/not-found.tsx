import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-display text-6xl font-medium">404</p>
      <p className="text-muted-foreground">Cette page n&apos;existe pas.</p>
      <Button asChild size="lg">
        <Link href="/">Retour à l&apos;accueil</Link>
      </Button>
    </main>
  );
}
