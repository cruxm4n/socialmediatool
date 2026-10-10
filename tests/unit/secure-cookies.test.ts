import { describe, expect, it } from "vitest";

import { isHttps, withSecure } from "@/lib/secure-cookies";

describe("cookies de session derrière HTTPS", () => {
  it("l'en-tête X-Forwarded-Proto du proxy décide en premier", () => {
    expect(isHttps("https", undefined)).toBe(true);
    expect(isHttps("https,http", undefined)).toBe(true);
    expect(isHttps("http", "https://cadence.example")).toBe(false);
  });

  it("sans en-tête : APP_URL en https ; HTTP local : jamais Secure (le navigateur refuserait le cookie)", () => {
    expect(isHttps(null, "https://cadence.example")).toBe(true);
    expect(isHttps(null, "http://127.0.0.1:3000")).toBe(false);
    expect(isHttps(undefined, undefined)).toBe(false);
  });

  it("withSecure ajoute Secure sans perdre les autres attributs, et ne change rien en HTTP", () => {
    expect(withSecure({ path: "/", sameSite: "lax" }, true)).toEqual({ path: "/", sameSite: "lax", secure: true });
    expect(withSecure({ path: "/" }, false)).toEqual({ path: "/" });
    expect(withSecure(undefined, true)).toEqual({ secure: true });
  });
});
