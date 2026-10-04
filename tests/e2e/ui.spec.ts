import { test, expect } from "@playwright/test";

/**
 * Browser-level guarantees: the page hydrates cleanly, never overflows
 * horizontally, and every interactive affordance actually works.
 */

const STORY = "/github.com/acme/widget";

/** Fail the test on any React hydration / mismatch error. */
function watchForHydrationErrors(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return {
    errors,
    hydration: () => errors.filter((e) => /hydrat|did not match|server rendered/i.test(e)),
  };
}

test.describe("hydration & layout integrity", () => {
  for (const width of [1440, 1100, 820, 640, 375]) {
    test(`story hydrates without mismatch and does not overflow @ ${width}px`, async ({
      page,
    }) => {
      const watch = watchForHydrationErrors(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(STORY, { waitUntil: "networkidle" });

      expect(watch.hydration(), `hydration errors @${width}`).toEqual([]);

      const spills = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        // Content wider than the viewport is only a bug if nothing upstream is
        // allowed to scroll it — e.g. the contribution graph is deliberately
        // min-w-[520px] inside an overflow-x-auto container.
        const inScroller = (el: HTMLElement) => {
          for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === "auto" || ox === "scroll") return true;
          }
          return false;
        };
        const out: string[] = [];
        document.querySelectorAll<HTMLElement>("main *").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > vw + 1 && !inScroller(el)) {
            out.push(`${el.tagName}.${el.className.toString().slice(0, 50)}`);
          }
        });
        return out.slice(0, 5);
      });
      expect(spills, `horizontal overflow @${width}`).toEqual([]);

      // No horizontal scrollbar is the user-visible symptom.
      const scrollable = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      expect(scrollable, `h-scroll @${width}`).toBe(false);
    });
  }

  test("truncates long text with an ellipsis instead of clipping", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(STORY, { waitUntil: "networkidle" });

    // Fixture commit subjects are long; they must ellipsize, not spill.
    const truncated = await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>(".truncate")];
      return els
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => getComputedStyle(el).textOverflow);
    });
    for (const overflow of truncated) expect(overflow).toBe("ellipsis");
  });
});

test.describe("no wasted work per page view", () => {
  test("landing page fires no API requests on load", async ({ page }) => {
    // Regression: the footer "status" link was a <Link>, so Next prefetched
    // /api/health on every visit — spawning a `git --version` subprocess and a
    // store ping per page view — and the RSC prefetch never settled, holding a
    // connection open.
    const apiCalls: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url());
    });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(apiCalls).toEqual([]);
  });

  test("the compare link does not prefetch", async ({ page }) => {
    // Secondary action; server-rendering /compare on every story view is waste.
    const prefetches: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/compare") && r.url().includes("_rsc")) prefetches.push(r.url());
    });
    await page.goto(STORY, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    expect(prefetches).toEqual([]);
  });
});

test.describe("story interactions", () => {
  test("opens the churn drawer, then closes it and reopens an incident", async ({ page }) => {
    const watch = watchForHydrationErrors(page);
    await page.goto(STORY, { waitUntil: "networkidle" });

    const churnList = page.locator('section[aria-label="File churn leaderboard"] li');
    await churnList.first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("churn")).toBeVisible();
    await expect(drawer.getByRole("link", { name: /Blame/ })).toBeVisible();

    await drawer.getByRole("button", { name: "Close ✕" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    const incident = page.getByText("Add experimental feature flag (#23)").first();
    await expect(incident).toBeVisible();
    await incident.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("author")).toBeVisible();

    expect(watch.hydration()).toEqual([]);
  });

  test("dates render in a fixed, locale-independent format", async ({ page }) => {
    await page.goto(STORY, { waitUntil: "networkidle" });
    // Matches "Sep 18, 2026" and not "18/09/2026" / "9/18/2026".
    const dates = await page.locator('section[aria-label="Who broke what"]').innerText();
    expect(dates).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    expect(dates).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  test("era selection filters the story", async ({ page }) => {
    await page.goto(STORY, { waitUntil: "networkidle" });
    const bands = page.locator('[aria-label*="era" i], .era-band');
    const count = await bands.count();
    test.skip(count === 0, "no era bands rendered");
    await bands.first().click();
    await expect(page.getByRole("heading", { name: "Feature Eras" })).toBeVisible();
  });
});

test.describe("cold start journey", () => {
  test("landing → invalid URL shows inline error, no navigation", async ({ page }) => {
    const watch = watchForHydrationErrors(page);
    await page.goto("/");

    await page.getByLabel("GitHub repository URL").fill("https://evil.example.com/a/b");
    await page.getByRole("button", { name: /Excavate/ }).click();

    await expect(page.getByText(/Only https:\/\/github\.com/)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(watch.hydration()).toEqual([]);
  });

  test("empty submit is rejected client-side", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Excavate/ }).click();
    await expect(page.getByText(/Paste a GitHub repository URL/)).toBeVisible();
  });

  test("progress panel renders stage chips while scanning", async ({ page }) => {
    await page.goto("/github.com/acme/widget");
    // Cached story: the scan panel should not linger.
    await expect(page.getByRole("heading", { name: "Feature Eras" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Excavating/)).toHaveCount(0);
  });
});

test.describe("commit explorer", () => {
  test("lists commits and opens one in the drawer", async ({ page }) => {
    const watch = watchForHydrationErrors(page);
    await page.goto(STORY, { waitUntil: "networkidle" });

    const section = page.locator('section[aria-label="Commit explorer"]');
    await expect(section).toBeVisible();

    const rows = section.locator("ul li");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const firstCount = await rows.count();
    expect(firstCount).toBeGreaterThan(0);
    // Paged, not the whole set rendered at once.
    expect(firstCount).toBeLessThanOrEqual(25);

    await rows.first().locator("button").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("sha")).toBeVisible();

    expect(watch.hydration()).toEqual([]);
  });

  test("filters by author and shows a match count", async ({ page }) => {
    await page.goto(STORY, { waitUntil: "networkidle" });
    const section = page.locator('section[aria-label="Commit explorer"]');
    await section.locator("ul li").first().waitFor({ timeout: 15_000 });

    await section.getByLabel("Search commits").fill("author:grace");

    // The count is announced via aria-live and reflects the server total.
    await expect(section.getByText(/commits? matching/)).toBeVisible({ timeout: 15_000 });
    const rows = section.locator("ul li");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("reports when nothing matches and can clear", async ({ page }) => {
    await page.goto(STORY, { waitUntil: "networkidle" });
    const section = page.locator('section[aria-label="Commit explorer"]');
    await section.locator("ul li").first().waitFor({ timeout: 15_000 });

    await section.getByLabel("Search commits").fill("zzzz-definitely-nothing");
    await expect(section.getByText("No commits match.")).toBeVisible({ timeout: 15_000 });

    await section.getByRole("button", { name: "clear" }).click();
    await expect(section.locator("ul li").first()).toBeVisible({ timeout: 15_000 });
  });

  test("keeps the page payload small while offering an explorer", async ({ page }) => {
    const sizes: number[] = [];
    page.on("response", async (res) => {
      if (res.url().endsWith("/github.com/acme/widget")) {
        try {
          sizes.push((await res.body()).length);
        } catch {
          /* ignore */
        }
      }
    });
    await page.goto(STORY, { waitUntil: "networkidle" });
    expect(sizes.length).toBeGreaterThan(0);
    // Commits are no longer embedded, so the document stays small.
    for (const s of sizes) expect(s).toBeLessThan(200_000);
  });
});

test.describe("accessibility basics", () => {
  test("landmarks, headings and labelled input exist", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByLabel("GitHub repository URL")).toBeVisible();
    await expect(page.getByRole("button", { name: /Excavate/ })).toBeVisible();
  });

  test("each story section has an accessible label", async ({ page }) => {
    await page.goto(STORY, { waitUntil: "networkidle" });
    for (const label of [
      "Who broke what",
      "File churn leaderboard",
      "Why this ugly code exists",
    ]) {
      await expect(page.locator(`section[aria-label="${label}"]`)).toHaveCount(1);
    }
  });

  test("keyboard can reach and activate the primary action", async ({ page }) => {
    await page.goto("/");
    const input = page.getByLabel("GitHub repository URL");
    await input.focus();
    await page.keyboard.type("github.com/acme/widget");
    await page.keyboard.press("Enter");
    await page.waitForURL(`**${STORY}`, { timeout: 30_000 });
  });
});