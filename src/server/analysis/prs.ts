/**
 * Pull request ingestion via GitHub GraphQL (paginated).
 *
 * We fetch newest-first up to MAX_PR_PAGES*50 PRs (default 1000) with
 * additions/deletions/changedFiles directly on the PR node, which is enough
 * for "avg PR size" stats and hotspot excerpts, without touching the PR
 * files connection per PR.
 */
import type { PRSummary } from "@/lib/types";
import type { GithubClient } from "@/server/github/client";
import { logger } from "@/server/logger";

const QUERY = /* GraphQL */ `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 50
        after: $cursor
        orderBy: { field: CREATED_AT, direction: DESC }
        states: [MERGED, CLOSED, OPEN]
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          url
          state
          createdAt
          mergedAt
          additions
          deletions
          changedFiles
          body
          author {
            __typename
            ... on User { login }
            ... on Organization { login }
            ... on Bot { login }
          }
        }
      }
    }
  }
`;

interface PRNode {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string | null;
  author: { login: string } | null;
}

interface PRPage {
  repository: {
    pullRequests: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: PRNode[] | null;
    };
  } | null;
}

export interface FetchPRsResult {
  prs: PRSummary[];
  totalCount: number;
}

export async function fetchPullRequests(
  client: GithubClient,
  owner: string,
  name: string,
  maxPages: number
): Promise<FetchPRsResult> {
  const prs: PRSummary[] = [];
  let cursor: string | null = null;
  let totalCount = 0;

  for (let page = 0; page < maxPages; page++) {
    const data: PRPage = await client.graphql<PRPage>(QUERY, { owner, name, cursor });
    const conn: PRPage["repository"] | null = data.repository;
    const pullRequests = conn?.pullRequests;
    if (!pullRequests) break;
    totalCount = pullRequests.totalCount;
    for (const node of pullRequests.nodes ?? []) {
      prs.push({
        number: node.number,
        title: node.title,
        url: node.url,
        author: node.author?.login ?? null,
        state: node.state,
        createdAt: node.createdAt,
        mergedAt: node.mergedAt,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFiles,
        excerpt: node.body ? truncateForExcerpt(node.body) : null,
      });
    }
    if (!pullRequests.pageInfo.hasNextPage) break;
    cursor = pullRequests.pageInfo.endCursor;
  }

  logger().debug({ owner, name, fetched: prs.length, totalCount }, "PRs fetched");
  return { prs, totalCount };
}

function truncateForExcerpt(body: string): string {
  const flat = body.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat;
}
