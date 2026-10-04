/**
 * Optional AI layer: turns raw era metrics into 2–3 sentence narrative
 * "story beats".
 *
 * - One batched LLM call per scan (all eras at once), temperature low.
 * - Cache key is (repo, era sha range), so the same commit range is never
 *   re-billed, across scans and across HEAD moves that don't change an era.
 * - Fails soft: any error leaves `beat: null` and the UI shows raw metrics.
 */
import type { Era } from "@/lib/types";
import { config } from "@/server/config";
import { logger } from "@/server/logger";

export type AiStatus = "generated" | "skipped" | "failed";

export interface AiCacheBackend {
  aiCacheGet<T>(key: string): Promise<T | null>;
  aiCacheSet(key: string, value: unknown): Promise<void>;
}

function eraCacheKey(slug: string, era: Era): string {
  return `beats:${slug}:${era.startSha.slice(0, 10)}..${era.endSha.slice(0, 10)}`;
}

export async function generateEraBeats(
  slug: string,
  eras: Era[],
  subjectsByEra: Map<string, string[]>,
  cache: AiCacheBackend
): Promise<{ eras: Era[]; status: AiStatus }> {
  const cfg = config();
  if (cfg.aiProvider === "none" || !cfg.openaiApiKey || eras.length === 0) {
    return { eras, status: "skipped" };
  }

  const result = eras.map((e) => ({ ...e }));
  const missing: Array<{ index: number; era: Era }> = [];
  for (let i = 0; i < result.length; i++) {
    const era = result[i]!;
    const cached = await cache.aiCacheGet<string>(eraCacheKey(slug, era));
    if (typeof cached === "string" && cached.length > 0) {
      era.beat = cached;
    } else {
      missing.push({ index: i, era });
    }
  }

  if (missing.length === 0) return { eras: result, status: "generated" };

  try {
    const beats = await callLlm(
      missing.map(({ era }) => ({
        id: era.id,
        title: era.title,
        commits: era.commitCount,
        authors: era.authors,
        dominantPaths: era.dominantPaths,
        netAdditions: era.netAdditions,
        netDeletions: era.netDeletions,
        sampleSubjects: subjectsByEra.get(era.id) ?? [],
      }))
    );

    for (let m = 0; m < missing.length; m++) {
      const beat = beats[m];
      const { index, era } = missing[m]!;
      if (typeof beat === "string" && beat.trim().length > 0) {
        const clean = beat.trim();
        result[index]!.beat = clean;
        await cache.aiCacheSet(eraCacheKey(slug, era), clean);
      }
    }
    return { eras: result, status: "generated" };
  } catch (err) {
    logger().warn({ err, slug }, "AI era beats failed; falling back to raw metrics");
    return { eras: result, status: "failed" };
  }
}

async function callLlm(eraInputs: unknown[]): Promise<string[]> {
  const cfg = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.openaiModel,
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a witty software historian narrating the evolution of a codebase. " +
              "For each era of development you get commit stats and sample commit subjects. " +
              'Return STRICT JSON: {"beats": ["...", "..."]} with exactly one 2-3 sentence ' +
              "beat per era, in the same order. Be concrete, reference the actual features " +
              "and files, never invent facts. No markdown.",
          },
          {
            role: "user",
            content: JSON.stringify({ eras: eraInputs }),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM responded ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as { beats?: unknown };
    if (!Array.isArray(parsed.beats)) throw new Error("LLM returned no beats array");
    return parsed.beats.map((b) => (typeof b === "string" ? b : ""));
  } finally {
    clearTimeout(timer);
  }
}
