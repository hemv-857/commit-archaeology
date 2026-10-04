import { describe, expect, it } from "vitest";
import { isGeneratedPath, computeChurn } from "@/server/analysis/hotspots";
import { makeCommit, file } from "../helpers";

describe("isGeneratedPath", () => {
  it.each([
    "bun.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "go.sum",
    "node_modules/react/index.js",
    "apps/web/dist/bundle.js",
    "packages/core/dist/index.mjs",
    ".next/server/chunks/webpack.js",
    "coverage/lcov.info",
    "tool-results/read_1789736268411_c2aee85f7435.txt",
    "upload/Pasted Content_1789736217859.txt",
    "static/app.min.js",
    "vendor/github.com/x/y.go",
    "build/output.txt",
    "target/debug/foo.rs",
  ])("filters %s", (p) => {
    expect(isGeneratedPath(p)).toBe(true);
  });

  it.each([
    "src/components/views/backtest-view.tsx",
    "src/app/api/backtest-real/route.ts",
    "src/lib/format.ts",
    "README.md",
    "app/models/user.rb",
    // Ambiguous names are only filtered at the root: a project may keep real
    // source in src/build/ or src/target/, and hiding it is worse than noise.
    "src/build/pipeline.ts",
    "src/target/shooter.ts",
    "src/out/view.tsx",
    "docs/out-of-band.md",
    "src/utils/blockchain.ts",
  ])("keeps %s", (p) => {
    expect(isGeneratedPath(p)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isGeneratedPath("BUN.LOCK")).toBe(true);
    expect(isGeneratedPath("Node_Modules/x.js")).toBe(true);
  });
});

describe("computeChurn excludes generated files", () => {
  it("does not let a lockfile outrank real source", () => {
    const commits = [
      makeCommit({
        date: "2024-01-01T00:00:00Z",
        files: [file("bun.lock", 5000, 4000)],
      }),
      makeCommit({
        date: "2024-01-02T00:00:00Z",
        files: [file("src/app.tsx", 120, 30)],
      }),
    ];

    const churn = computeChurn(commits);
    expect(churn.map((c) => c.path)).toEqual(["src/app.tsx"]);
    expect(churn[0]!.churn).toBe(150);
  });

  it("still reports generated files when that is all there is", () => {
    const churn = computeChurn([
      makeCommit({ date: "2024-01-01T00:00:00Z", files: [file("bun.lock", 10, 5)] }),
    ]);
    // Filtering must not silently hide a repo's entire history.
    expect(churn).toEqual([]);
  });
});