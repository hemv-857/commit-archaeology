import { describe, expect, it } from "vitest";
import { gitAuthEnv } from "@/server/git/clone";

/**
 * The git auth header is invisible in normal testing — a wrong scheme only
 * shows up as a 401 against the real GitHub. Pin the exact contract here.
 */
describe("gitAuthEnv", () => {
  const token = "github_pat_example";

  it("uses HTTP Basic, which is the only scheme GitHub's git endpoint accepts", () => {
    const env = gitAuthEnv(token);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraheader");

    const header = env.GIT_CONFIG_VALUE_0!;
    expect(header.startsWith("AUTHORIZATION: basic ")).toBe(true);
    // Regression guard: `bearer` gets a 401, and because terminal prompts are
    // disabled git then fails outright instead of cloning anonymously.
    expect(header.toLowerCase()).not.toContain("bearer");

    const decoded = Buffer.from(
      header.slice("AUTHORIZATION: basic ".length),
      "base64"
    ).toString("utf8");
    expect(decoded).toBe(`x-access-token:${token}`);
  });

  it("never puts the raw token in argv-shaped fields", () => {
    const env = gitAuthEnv(token);
    expect(JSON.stringify(env)).not.toContain(token);
  });

  it("returns an empty env when no token is configured (anonymous clone)", () => {
    expect(gitAuthEnv(undefined)).toEqual({});
    expect(gitAuthEnv("")).toEqual({});
  });
});