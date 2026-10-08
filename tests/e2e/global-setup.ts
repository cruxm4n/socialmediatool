import { chromium, request, type FullConfig } from "@playwright/test";

import { authFile, login, syncViaApi, type DemoUser } from "./helpers";

/** Avant les tests : une première synchronisation, puis une session enregistrée par utilisateur. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;

  const api = await request.newContext({ baseURL });
  await syncViaApi(api);
  await api.dispose();

  const browser = await chromium.launch();
  for (const user of ["ADMIN", "INES", "HUGO", "SOFIA"] as DemoUser[]) {
    const context = await browser.newContext({ baseURL });
    await login(await context.newPage(), user);
    await context.storageState({ path: authFile(user) });
    await context.close();
  }
  await browser.close();
}
