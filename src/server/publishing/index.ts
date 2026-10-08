import "server-only";

import { env } from "@/server/env";
import { BufferProvider } from "@/server/publishing/buffer-provider";
import { MockProvider } from "@/server/publishing/mock-provider";
import type { PublishingProvider } from "@/server/publishing/provider";

let realProvider: BufferProvider | null = null;

/** Fournisseur actif : Buffer réel uniquement si BUFFER_MODE=real. */
export function getProvider(): PublishingProvider {
  if (env.bufferMode === "real") {
    realProvider ??= new BufferProvider(env.bufferApiKey, env.reviewTag);
    return realProvider;
  }
  return new MockProvider(env.mockRunId);
}
