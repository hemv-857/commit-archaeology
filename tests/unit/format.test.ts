import { describe, expect, it } from "vitest";
import { formatDate, formatMonth } from "@/lib/format";

/**
 * SSR renders these on the server, then React hydrates them in the browser.
 * Node and the browser do not share locale defaults, so an unpinned
 * toLocale*() produces different text and React throws a hydration mismatch.
 * These assertions pin the exact output so a regression is caught in CI rather
 * than in someone's browser console.
 */
const ISO = "2026-09-18T14:03:22.000Z";

describe("formatDate is locale-independent", () => {
  it("renders the same regardless of the host locale", () => {
    expect(formatDate(ISO)).toBe("Sep 18, 2026");
  });

  it("does not shift the day across timezones (UTC-anchored)", () => {
    // 22:00 UTC would be the next day in UTC+2; commit timestamps must not move.
    expect(formatDate("2026-09-18T22:30:00.000Z")).toBe("Sep 18, 2026");
    // 01:00 UTC would be the previous day in UTC-5.
    expect(formatDate("2026-09-18T01:00:00.000Z")).toBe("Sep 18, 2026");
  });

  it("degrades safely on bad input", () => {
    expect(formatDate(undefined)).toBe("unknown");
    expect(formatDate(null)).toBe("unknown");
    expect(formatDate("not-a-date")).toBe("unknown");
  });
});

describe("formatMonth is locale-independent", () => {
  it("renders the same regardless of the host locale", () => {
    expect(formatMonth("2026-09")).toBe("Sep 26");
  });

  it("passes through malformed input", () => {
    expect(formatMonth("")).toBe("");
    expect(formatMonth("garbage")).toBe("garbage");
  });
});

describe("number separators are pinned", () => {
  it("uses en-US grouping so server and client agree", () => {
    // de-DE renders 2.370 and fr-FR renders 2 370 — both would mismatch.
    expect((2370).toLocaleString("en-US")).toBe("2,370");
  });
});