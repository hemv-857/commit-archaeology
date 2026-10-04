import { ImageResponse } from "next/og";
import { getStore } from "@/server/store";
import { formatNumber } from "@/lib/format";

/**
 * Per-repo share card (1200×630).
 *
 * Next wires this automatically to
 * /github.com/{owner}/{repo}/opengraph-image and injects the `og:image` meta
 * tag, so the story's own `generateMetadata` does not need to reference it.
 *
 * Runs on the nodejs runtime because it reads the story store (filesystem or
 * Postgres) rather than fetching over HTTP.
 *
 * Note: satori (which backs ImageResponse) reads layout from the `style` prop
 * only — a `display` attribute is ignored — and every element with more than one
 * child must declare `display: flex`. Tiles are laid out as explicit rows
 * rather than with flex-wrap, which satori miscalculates.
 */
export const runtime = "nodejs";
export const alt = "Commit Archaeology story";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CARD_BG = "#0c0a09";
const PANEL_BG = "rgba(22,19,17,0.9)";
const LINE = "#2c2724";
const AMBER = "#fbbf24";
const DUST = "#a8a29e";

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo: name } = await params;
  const title = `${owner}/${name}`;

  let tiles: Array<[string, string]> | null = null;

  try {
    const stored = await (await getStore()).getStory(owner, name);
    if (stored) {
      const { stats, repo, eras, busFactor } = stored.story;
      tiles = [
        ["commits", formatNumber(stats.totalCommits)],
        ["contributors", formatNumber(stats.contributors)],
        ["eras", String(eras.length)],
        ["history", `${formatNumber(stats.historyDays)}d`],
        ["bus factor", busFactor.score === null ? "—" : String(busFactor.score)],
        ["stars", formatNumber(repo.stars)],
      ];
    }
  } catch {
    /* fall through to the unscanned card */
  }

  // Long repo names must not run off the card.
  const titleSize = title.length > 34 ? 46 : title.length > 24 ? 56 : 68;

  return new ImageResponse(
    (
<div
          style={{
            display: "flex",
            flexDirection: "column",
            // Centre the fallback card vertically; keep the stats card top-aligned.
            justifyContent: tiles ? "flex-start" : "center",
            width: "100%",
            height: "100%",
            padding: 64,
            backgroundColor: CARD_BG,
            backgroundImage:
              "radial-gradient(900px 380px at 50% -12%, rgba(251,191,36,0.16), transparent 62%)",
            color: "#e7e5e4",
            fontFamily: "sans-serif",
          }}
        >
        <div
          style={{
            display: "flex",
            fontSize: 22,
            color: AMBER,
            letterSpacing: 3,
          }}
        >
          ⛏ COMMIT ARCHAEOLOGY
        </div>

        <div
          style={{
            display: "flex",
            fontSize: titleSize,
            fontWeight: 700,
            marginTop: 18,
            lineHeight: 1.1,
            color: "#fafaf9",
          }}
        >
          {title}
        </div>

        {tiles ? (
          <div style={{ display: "flex", flexDirection: "column", marginTop: 44 }}>
            {[0, 1].map((row) => (
              <div key={row} style={{ display: "flex", marginBottom: 18 }}>
                {tiles.slice(row * 3, row * 3 + 3).map(([label, value]) => (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      width: 336,
                      padding: 22,
                      marginRight: 16,
                      border: `1px solid ${LINE}`,
                      borderRadius: 14,
                      backgroundColor: PANEL_BG,
                    }}
                  >
                    <div
                      style={{ display: "flex", fontSize: 36, fontWeight: 700, color: "#fafaf9" }}
                    >
                      {value}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        fontSize: 18,
                        marginTop: 4,
                        color: DUST,
                        letterSpacing: 1,
                      }}
                    >
                      {label.toUpperCase()}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 30, marginTop: 28, color: DUST }}>
            Not excavated yet — every repository has a past.
          </div>
        )}
      </div>
    ),
    size
  );
}