/**
 * Renders a story as a shareable Markdown report.
 *
 * Pure and dependency-free so it is unit-testable and reusable from anywhere.
 * The story is already a clean serializable document, so export adds no new
 * data path — only presentation.
 */

import type { RepoStory } from "@/lib/types";

/** Escape pipes so a subject containing `|` cannot break a table row. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function dateOnly(iso: string): string {
  // UTC-anchored to match the on-screen rendering (see lib/format).
  return new Date(iso).toISOString().slice(0, 10);
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderStoryMarkdown(story: RepoStory): string {
  const { repo, stats } = story;
  const L: string[] = [];

  L.push(`# ${repo.owner}/${repo.name}`);
  L.push("");
  if (repo.description) L.push(`> ${repo.description}`);
  L.push("");

  const meta: string[] = [
    `**Language** ${repo.primaryLanguage ?? "—"}`,
    `**Stars** ${num(repo.stars)}`,
    `**Forks** ${num(repo.forks)}`,
    `**Branch** \`${repo.defaultBranch}\``,
    `**HEAD** \`${repo.headSha.slice(0, 7)}\``,
  ];
  if (repo.isFork) meta.push("**Fork** yes");
  if (repo.archived) meta.push("**Archived** yes");
  L.push(meta.join("  ·  "));
  L.push("");
  L.push(`Source: ${repo.url}`);
  L.push("");

  /* ---- stats ---- */
  L.push("## At a glance");
  L.push("");
  L.push("| Metric | Value |");
  L.push("| --- | --- |");
  L.push(`| Commits | ${num(stats.totalCommits)} |`);
  L.push(`| Contributors | ${num(stats.contributors)} |`);
  L.push(`| Pull requests | ${num(stats.totalPRs)} |`);
  L.push(`| Feature eras | ${story.eras.length} |`);
  L.push(`| Incidents | ${story.incidents.length} |`);
  L.push(`| Reverts | ${num(stats.revertCount)} |`);
  L.push(`| Hotfix frequency | ${stats.hotfixesPerMonth}/mo |`);
  L.push(`| Bus factor | ${story.busFactor.score} (${story.busFactor.label}) |`);
  L.push(
    `| History | ${num(stats.historyDays)} days (${dateOnly(stats.firstCommitAt)} → ${dateOnly(
      stats.lastCommitAt
    )}) |`
  );
  L.push("");

  /* ---- eras ---- */
  L.push("## Feature eras");
  L.push("");
  if (story.eras.length === 0) {
    L.push("_No eras detected._");
  } else {
    for (const era of story.eras) {
      L.push(
        `### ${dateOnly(era.start)} → ${dateOnly(era.end)} — ${num(era.commitCount)} commits, ${
          era.authors
        } author${era.authors === 1 ? "" : "s"}`
      );
      L.push("");
      L.push(era.title);
      L.push("");
      if (era.beat) {
        L.push(`> ${era.beat}`);
        L.push("");
      } else if (era.summary) {
        L.push(`> ${era.summary}`);
        L.push("");
      }
      if (era.dominantPaths.length > 0) {
        L.push(`**Hot paths:** ${era.dominantPaths.map((p) => `\`${p}\``).join(", ")}`);
        L.push("");
      }
      L.push(
        `**Diff:** +${num(era.netAdditions)} / −${num(era.netDeletions)}`
      );
      L.push("");
    }
  }

  /* ---- incidents ---- */
  L.push("## Who broke what");
  L.push("");
  if (story.incidents.length === 0) {
    L.push("_No reverts or urgent fixes detected._");
  } else {
    L.push("| Kind | Culprit | Repaired by | Hours | Files |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const i of story.incidents) {
      L.push(
        `| ${i.kind} | ${cell(i.culpritSubject)} (\`${i.culpritSha.slice(0, 7)}\`, ${dateOnly(
          i.culpritDate
        )}) | ${cell(i.aftermathSubject)} (\`${i.aftermathSha.slice(0, 7)}\`, ${dateOnly(
          i.aftermathDate
        )}) | ${i.hoursToRepair.toFixed(1)} | ${i.files.length} |`
      );
    }
    L.push("");
  }

  /* ---- hotspots ---- */
  if (story.hotspots.length > 0) {
    L.push("## Why this ugly code exists");
    L.push("");
    L.push("| File | Churn | Edits | Authors | Linked PRs |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const h of story.hotspots) {
      const prs =
        h.linkedPRs.length > 0
          ? h.linkedPRs.map((p) => `[#${p.number}](${p.url})`).join(", ")
          : "—";
      L.push(
        `| \`${cell(h.path)}\` | ${num(h.churn)} | ${h.commits} | ${h.authors} | ${prs} |`
      );
    }
    L.push("");
  }

  /* ---- team ---- */
  L.push("## The dig team");
  L.push("");
  L.push(
    `Bus factor **${story.busFactor.score}** (${story.busFactor.label}) — ` +
      `${story.busFactor.topAuthorCommits} commits by the top author ` +
      `(${(story.busFactor.topAuthorsShare * 100).toFixed(0)}% of history).`
  );
  L.push("");
  L.push("| Author | Commits | + | − | First | Last |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const a of story.authors) {
    L.push(
      `| ${cell(a.name)} | ${num(a.commits)} | ${num(a.additions)} | ${num(a.deletions)} | ${dateOnly(
        a.firstCommitAt
      )} | ${dateOnly(a.lastCommitAt)} |`
    );
  }
  L.push("");

  /* ---- churn ---- */
  if (story.churn.length > 0) {
    L.push("## Churn leaderboard");
    L.push("");
    L.push("| File | Churn | + | − | Edits |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const c of story.churn.slice(0, 15)) {
      L.push(
        `| \`${cell(c.path)}\` | ${num(c.churn)} | ${num(c.additions)} | ${num(
          c.deletions
        )} | ${c.commits} |`
      );
    }
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push(
    `Generated by Commit Archaeology · analyzer v${story.meta.analyzerVersion} · ` +
      `${story.meta.analysisMs}ms · ${story.meta.githubApiCalls} GitHub API calls · ` +
      `AI beats: ${story.meta.aiBeats}`
  );
  L.push("");

  return L.join("\n");
}