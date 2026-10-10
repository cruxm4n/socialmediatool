import "server-only";

/*
 * Boucle de réveil du traitement urgent (voir urgent.ts). Pure : l'horloge et le travail sont injectés, ce qui permet
 * de l'éprouver avec une horloge contrôlée. Un seul passage à la fois ; une erreur n'arrête jamais la boucle.
 */

/** Période entre deux passages (le premier suit le démarrage de `INITIAL_DELAY_MS`). */
export const URGENT_PERIOD_MS = 30_000;
export const URGENT_INITIAL_DELAY_MS = 5_000;

export interface UrgentLoopHandle {
  stop(): void;
  /** Nombre de passages terminés (sert aux tests et à la supervision). */
  readonly runs: () => number;
}

export function startUrgentLoop(
  work: () => Promise<unknown>,
  options: { periodMs?: number; initialDelayMs?: number; onError?: (error: unknown) => void } = {},
): UrgentLoopHandle {
  const periodMs = options.periodMs ?? URGENT_PERIOD_MS;
  const initialDelayMs = options.initialDelayMs ?? URGENT_INITIAL_DELAY_MS;
  let running = false;
  let stopped = false;
  let runs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    if (!running) {
      running = true;
      try {
        await work();
      } catch (error) {
        options.onError?.(error);
      } finally {
        running = false;
        runs += 1;
      }
    }
    if (!stopped) {
      timer = setTimeout(tick, periodMs);
      timer.unref?.();
    }
  };

  timer = setTimeout(tick, initialDelayMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runs: () => runs,
  };
}
