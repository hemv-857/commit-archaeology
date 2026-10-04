import { describe, expect, it } from "vitest";
import { isRepoUrlValid, isSafeRepoSlug, parseRepoUrl, RepoUrlError } from "@/lib/repo-url";

describe("parseRepoUrl (SSRF-safe)", () => {
  const valid = [
    "https://github.com/vercel/next.js",
    "https://github.com/vercel/next.js/",
    "vercel/next.js",
    "https://www.github.com/vercel/next.js/",
    "https://github.com/vercel/next.js.git",
    "git+https://github.com/vercel/next.js",
    "https://github.com/vercel/next.js?tab=readme",
    "https://github.com/vercel/next.js/tree/canary",
  ];

  it.each(valid)("accepts %s", (input) => {
    const parsed = parseRepoUrl(input);
    expect(parsed.owner).toBe("vercel");
    expect(parsed.name).toBe("next.js");
    expect(parsed.url).toBe("https://github.com/vercel/next.js");
  });

  const invalid: Array<[string, string]> = [
    ["https://evil.com/vercel/next.js", "host"],
    ["https://github.com.evil.com/vercel/next.js", "subdomain"],
    ["https://user:pass@github.com/vercel/next.js", "userinfo"],
    ["https://github.com:8443/vercel/next.js", "port"],
    ["ftp://github.com/vercel/next.js", "scheme"],
    ["https://github.com/vercel", "missing repo"],
    ["https://github.com/vercel/next.js/../../admin", "traversal escapes repo"],
    ["https://github.com/vercel/next.js/issues", "subpage"],
  ];

  it.each(invalid)("rejects %s (%s)", (input) => {
    expect(() => parseRepoUrl(input)).toThrow(RepoUrlError);
  });

  it("isRepoUrlValid agrees with parseRepoUrl", () => {
    expect(isRepoUrlValid("vercel/next.js")).toBe(true);
    expect(isRepoUrlValid("https://evil.com/a/b")).toBe(false);
  });

  it("rejects absurd input lengths", () => {
    expect(isRepoUrlValid(`https://github.com/${"a".repeat(400)}/b`)).toBe(false);
  });
});

describe("isSafeRepoSlug (raw route params)", () => {
  it.each(["vercel/next.js", "acme/widget", "sindresorhus/is", "a-b/c_d.e"])(
    "accepts %s",
    (slug) => {
      const [owner, name] = slug.split("/")!;
      expect(isSafeRepoSlug(owner!, name!)).toBe(true);
    }
  );

  // These reach the store as raw path params and become filesystem segments.
  it.each([
    ["..", "widget"],
    ["../../etc", "passwd"],
    ["vercel", ".."],
    ["vercel", "../../secrets"],
    ["vercel", ".hidden"],
    ["vercel/..", "x"],
  ])("rejects traversal owner=%s name=%s", (owner, name) => {
    expect(isSafeRepoSlug(owner!, name!)).toBe(false);
  });
});
