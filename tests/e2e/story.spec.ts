import { expect, test } from "@playwright/test";
import path from "node:path";
import { rm } from "node:fs/promises";

/**
 * The golden E2E path: land → paste repo URL → watch the scan progress →
 * read the story → open a deep-dive drawer. Runs entirely in MOCK_GITHUB
 * mode against deterministic local fixtures (no network, no tokens).
 */

// This spec asserts the cold-start progress panel, so it must control its own
// precondition. Relying on "runs before audit.spec.ts" made it order-dependent
// and it failed the moment another spec scanned the same fixture first.
test.beforeAll(async () => {
  await rm(path.join(process.cwd(), ".data", "e2e", "stories", "acme__widget"), {
    recursive: true,
    force: true,
  });
});
test("landing → scan fixture repo → story renders → drawer opens", async ({ page }) => {
  // 1. Landing page
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Every repository");
  await expect(page.getByLabel("GitHub repository URL")).toBeVisible();

  // 2. Paste a repo URL and start the scan
  await page.getByLabel("GitHub repository URL").fill("github.com/acme/widget");
  await page.getByRole("button", { name: /Excavate/ }).click();

  // 3. We land on the shareable story URL; the scan progress panel shows first.
  await page.waitForURL("**/github.com/acme/widget");
  await expect(page.getByText(/Excavating acme\/widget/)).toBeVisible();

  // 4. The scan completes over SSE and the story view replaces the progress UI.
  await expect(page.getByRole("heading", { name: "Feature Eras" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", { name: "Who Broke What" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Why This Ugly Code Exists" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Dig Team" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Churn Leaderboard" })).toBeVisible();

  // Repo header shows fixture data (stars render through formatNumber → 4.2k)
  await expect(page.getByText("4.2k").first()).toBeVisible();
  await expect(page.locator("body")).toContainText("hotfix frequency");

  // 5. Deep-dive: open the churn leader (src/core.js) → drawer with blame links
  // Scoped to the leaderboard: the path also appears in the timeline chips and
  // hotspot cards, which are earlier in the DOM.
  const churnList = page.locator('section[aria-label="File churn leaderboard"] li');
  await churnList.first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("churn")).toBeVisible();
  await expect(drawer.getByRole("link", { name: /Blame/ })).toBeVisible();

  // 6. Close drawer, click an incident commit
  // Exact name: the drawer also has a backdrop button labelled "Close details"
  await drawer.getByRole("button", { name: "Close ✕" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // The fixture's revert incident: culprit "Add experimental feature flag (#23)"
  const incident = page.getByText("Add experimental feature flag (#23)").first();
  await expect(incident).toBeVisible();
  await incident.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("author")).toBeVisible();
});

test("story URL is shareable — direct visit shows the cached story", async ({ page }) => {
  // First spec already scanned the fixture; this visit must hit the cache.
  await page.goto("/github.com/acme/widget");
  await expect(page.getByRole("heading", { name: "Feature Eras" })).toBeVisible({
    timeout: 30_000,
  });
});
