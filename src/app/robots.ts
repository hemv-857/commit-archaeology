import type { MetadataRoute } from "next";
import { config } from "@/server/config";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = config().publicBaseUrl.replace(/\/+$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Scanning endpoints and per-job SSE streams have no value in an index.
        disallow: ["/api/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}