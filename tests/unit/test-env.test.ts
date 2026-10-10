import { afterEach, describe, expect, it, vi } from "vitest";

import { configureIsolatedTests } from "../support/env";

const names = ["AUTOMATION_SECRET", ...["ADMIN", "INES", "HUGO", "SOFIA"].flatMap((user) => [`DEMO_${user}_EMAIL`, `DEMO_${user}_PASSWORD`])];
function setup(url = "https://test.supabase.co") {
  vi.stubEnv("TEST_ORIGINAL_APP_SUPABASE_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://app.supabase.co");
  vi.stubEnv("TEST_SUPABASE_URL", url);
  vi.stubEnv("TEST_SUPABASE_PUBLISHABLE_KEY", "test-key");
  vi.stubEnv("BUFFER_API_KEY", "real-key");
  vi.stubEnv("BUFFER_MODE", "real");
  for (const name of names) vi.stubEnv(`TEST_${name}`, "test-value");
}
afterEach(() => vi.unstubAllEnvs());

describe("configuration isolée des tests avec écritures", () => {
  it("refuse une base distante identique malgré une URL écrite autrement", () => {
    setup("https://app.supabase.co/");
    expect(configureIsolatedTests).toThrow("Tests refusés");
    expect(process.env.BUFFER_MODE).toBe("real");
  });
  it("exige une base et tous les identifiants de test", () => {
    setup();
    vi.stubEnv("TEST_AUTOMATION_SECRET", "");
    expect(configureIsolatedTests).toThrow("TEST_AUTOMATION_SECRET");
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://app.supabase.co");
    vi.stubEnv("TEST_SUPABASE_URL", "");
    expect(configureIsolatedTests).toThrow("TEST_SUPABASE_URL");
  });
  it("reste sûre quand Playwright recharge la configuration dans un worker", () => {
    setup();
    for (const name of [...names, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) vi.stubEnv(name, "app-value");
    configureIsolatedTests();
    expect(configureIsolatedTests).not.toThrow();
    expect(process.env.TEST_ORIGINAL_APP_SUPABASE_URL).toBe("https://app.supabase.co");
  });
  it("refuse HTTP sur une base distante", () => {
    setup("http://test.supabase.co");
    expect(configureIsolatedTests).toThrow("HTTPS");
  });
  it.each(["https://test.supabase.co", "http://127.0.0.1:54321", "http://[::1]:54321"])("utilise seulement les identifiants de test pour %s", (url) => {
    setup(url);
    // Restaurer également les valeurs que la fonction modifie.
    for (const name of [...names, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) vi.stubEnv(name, "app-value");
    configureIsolatedTests();
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe(url);
    expect(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("test-key");
    expect(process.env.AUTOMATION_SECRET).toBe("test-value");
    expect(process.env.BUFFER_MODE).toBe("mock");
    expect(process.env.BUFFER_API_KEY).toBe("");
  });
});
