import type { MetadataRoute } from "next";
import { getStore } from "@/server/store";
import { config } from "@/server/config";

export const dynamic = "force-dynamic";

/**
 * Story URLs are the only thing worth indexing — each is a unique, useful page.
 * The API and the scanner routes are not.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = config().publicBaseUrl.replace(/\/+$/, "");

  let repos: Array<{ owner: string; name: string; scannedAt: string }> = [];
  try {
    repos = await (await getStore()).listScannedRepos();
  } catch {
    // A store hiccup should yield a sitemap with just the homepage, not a 500.
  }

  const newestFirst = [...repos].sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));

  return [
    {
      url: `${base}/`,
      lastModified: newestFirst[0]?.scannedAt ?? new Date().toISOString(),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...newestFirst.map((r) => ({
      url: `${base}/github.com/${r.owner}/${r.name}`,
      lastModified: r.scannedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}