import { Skeleton } from "@/components/ui/skeleton";

/** État de chargement générique d'une page (titre, puis grille de cartes). */
export function PageSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Chargement">
      <div className="grid gap-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-56 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Chargement">
      <div className="grid gap-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-96 max-w-full" />
        <Skeleton className="h-6 w-40 rounded-full" />
      </div>
      <Skeleton className="h-20 rounded-2xl" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton className="h-[32rem] rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    </div>
  );
}
