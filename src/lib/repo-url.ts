/**
 * Strict, SSRF-safe GitHub repository URL validation.
 *
 * Rules:
 * - Accepts `https://github.com/{owner}/{repo}` (optionally with .git,
 *   trailing slash, `git+` scheme prefix, or query/fragment junk).
 * - Also accepts bare `owner/repo` shorthand and `github.com/owner/repo`.
 * - The URL is re-parsed and the host is *re-checked* after parsing, so no
 *   user-info / port / protocol tricks survive.
 * - Only the https (or bare host) forms are accepted; we never follow user
 *   supplied URLs elsewhere, so there is nothing to SSRF into.
 */

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// GitHub repo names may include dots but not ".." and must not end in ".git"
// after normalization. Also disallow leading dots.
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface ParsedRepo {
  owner: string;
  name: string;
  /** https://github.com/owner/name */
  url: string;
  /** owner/name */
  slug: string;
}

export class RepoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoUrlError";
  }
}

export function parseRepoUrl(input: string): ParsedRepo {
  const raw = (input ?? "").trim();
  if (!raw || raw.length > 300) {
    throw new RepoUrlError(
      "Enter a GitHub repository URL, e.g. https://github.com/vercel/next.js"
    );
  }

  let candidate = raw
    .replace(/^git\+/, "")
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
    // strip query/fragment
    .replace(/[?#].*$/, "");

  // Bare "owner/repo" or "github.com/owner/repo" shorthand.
  const shorthand = candidate.match(
    /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/
  );
  if (shorthand) {
    candidate = `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new RepoUrlError("That is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new RepoUrlError("Only https://github.com URLs are supported.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new RepoUrlError(
      "Only github.com repositories can be analyzed (SSRF protection)."
    );
  }
  if (url.username || url.password || url.port) {
    throw new RepoUrlError("Invalid GitHub URL.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new RepoUrlError(
      "URL must point at a repository: https://github.com/{owner}/{repo}"
    );
  }
  const owner = segments[0]!;
  let name = segments[1]!;
  if (name.toLowerCase().endsWith(".git")) name = name.slice(0, -4);

  if (!OWNER_RE.test(owner)) {
    throw new RepoUrlError(`"${owner}" is not a valid GitHub owner name.`);
  }
  if (!REPO_RE.test(name) || name.includes("..") || name.startsWith(".")) {
    throw new RepoUrlError(`"${name}" is not a valid GitHub repository name.`);
  }

  // Reserved path segments that would make this a non-repo URL.
  if (segments.length > 2) {
    const third = segments[2] ?? "";
    if (!["tree", "blob", "commits", "commit"].includes(third.toLowerCase())) {
      throw new RepoUrlError(
        "URL must point at a repository root, not a sub-page."
      );
    }
  }

  return {
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
    slug: `${owner}/${name}`,
  };
}

export function isRepoUrlValid(input: string): boolean {
  try {
    parseRepoUrl(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when an owner/repo pair is safe to use as a filesystem path segment or
 * cache key. Used by the route handlers, which receive raw path params rather
 * than a user-typed URL, so they cannot rely on parseRepoUrl. Rejects `..` and
 * leading dots to keep the segments inside the store directory.
 */
export function isSafeRepoSlug(owner: string, name: string): boolean {
  return (
    OWNER_RE.test(owner) &&
    REPO_RE.test(name) &&
    !name.includes("..") &&
    !name.startsWith(".")
  );
}
