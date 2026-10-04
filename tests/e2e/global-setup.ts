import path from "node:path";
import { promises as fs } from "node:fs";
import { buildFixtures } from "../fixtures/make-fixture-repos";

const DATA_DIR = path.join(process.cwd(), ".data", "e2e");

/**
 * Playwright global setup: build the deterministic git + GitHub fixtures
 * into public/fixtures (the app reads them with MOCK_GITHUB=1) and reset the
 * story cache.
 *
 * The cache reset is required, not cosmetic: the second spec depends on the
 * first one having populated it, so a leftover story from a previous run makes
 * the first spec render the finished story instead of the progress panel.
 */
export default async function globalSetup(): Promise<void> {
  const out = path.join(process.cwd(), "public", "fixtures");
  await buildFixtures(out);
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  console.log("e2e fixtures built:", out, "| cache reset:", DATA_DIR);
}