/**
 * Commit search.
 *
 * Kept pure and dependency-free so the server route and the client can share it:
 * the server filters the full set for `?q=`, and the client can reuse it to
 * narrow a page it has already loaded.
 */

import type { CommitEntry } from "@/lib/types";

export type CommitQueryField = "all" | "subject" | "author" | "path" | "sha";

/**
 * Parses `field:value` syntax. A bare term searches everything; recognised
 * prefixes narrow it. Returns null for an empty query (match everything).
 */
export function parseCommitQuery(input: string): {
  term: string;
  field: CommitQueryField;
} | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const prefixed = /^(subject|author|path|sha)\s*:\s*(.*)$/i.exec(raw);
  if (prefixed) {
    const field = prefixed[1]!.toLowerCase() as CommitQueryField;
    const term = prefixed[2]!.trim().toLowerCase();
    if (!term) return null;
    return { term, field };
  }

  // A field prefix only counts when it carries a term. A bare word — even one
  // that names a field, like "author" — is just a search term.
  return { term: raw.toLowerCase(), field: "all" };
}

/** True when a commit satisfies the parsed query. */
export function commitMatches(c: CommitEntry, query: ReturnType<typeof parseCommitQuery>): boolean {
  if (!query) return true;
  const { term, field } = query;

  if (field === "sha") return c.sha.startsWith(term);
  if (field === "subject") return c.subject.toLowerCase().includes(term);
  if (field === "author") {
    return (
      c.authorName.toLowerCase().includes(term) ||
      c.authorEmail.toLowerCase().includes(term)
    );
  }
  if (field === "path") {
    return c.files.some((f) => f.toLowerCase().includes(term));
  }

  // field === "all"
  return (
    c.sha.startsWith(term) ||
    c.subject.toLowerCase().includes(term) ||
    c.authorName.toLowerCase().includes(term) ||
    c.authorEmail.toLowerCase().includes(term) ||
    c.files.some((f) => f.toLowerCase().includes(term))
  );
}

/** Convenience: filter a list with a raw query string. */
export function filterCommits(commits: CommitEntry[], input: string): CommitEntry[] {
  const query = parseCommitQuery(input);
  if (!query) return commits;
  return commits.filter((c) => commitMatches(c, query));
}