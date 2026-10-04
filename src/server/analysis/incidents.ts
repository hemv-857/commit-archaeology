/**
 * "Who broke what" — finds commits that introduced a change which had to be
 * reverted or urgently patched shortly afterwards.
 *
 * Two signals:
 *  - reverts: subjects like `Revert "…"` or bodies with `This reverts commit <sha>`
 *  - quick-fixes: a fix/hotfix commit touching a file that a (non-fix) commit
 *    changed within the previous QUICKFIX_WINDOW_DAYS, ranked by churn
 */
import type { Incident } from "@/lib/types";
import type { RawCommit } from "@/server/git/log";
import { revertReference } from "@/server/git/log";

const QUICKFIX_WINDOW_DAYS = 14;
const MAX_INCIDENTS = 12;

/**
 * A commit counts as a repair only when the fix vocabulary is in the
 * conventional *position*.
 *
 * Matching the word anywhere in the subject produced nonsense like
 * "feat: add more glossary terms across options, vol, and fixed income"
 * being read as a hotfix of the previous commit. Two accepted shapes:
 *
 *   - conventional commits: `fix:`, `fix(scope):`, `hotfix:`, `bugfix:` …
 *   - sentence-initial imperative: "Fix the parser", "Fixes #123"
 */
const FIX_PREFIX = /^(fix|hotfix|bugfix|patch|revert)\b\s*(\([^)]*\))?\s*:/i;
const FIX_SENTENCE = /^(fix|fixes|fixed|hotfix|hotfixes|bugfix|patch|patches|patched)\b/i;

export function isFixLike(subject: string): boolean {
  return FIX_PREFIX.test(subject) || FIX_SENTENCE.test(subject);
}

export function findIncidents(commitsNewestFirst: RawCommit[]): Incident[] {
  const incidents: Incident[] = [];
  const bySha = new Map<string, RawCommit>();
  for (const c of commitsNewestFirst) bySha.set(c.sha, c);

  const usedAsCulprit = new Set<string>();
  const usedAsAftermath = new Set<string>();

  /* ---- reverts ---- */
  for (const c of commitsNewestFirst) {
    const ref = revertReference(c);
    let target: RawCommit | undefined;
    if (ref.targetSha) {
      target = bySha.get(ref.targetSha);
      if (!target) {
        for (const [sha, commit] of bySha) {
          if (sha.startsWith(ref.targetSha)) {
            target = commit;
            break;
          }
        }
      }
    } else if (ref.targetSubject) {
      target = commitsNewestFirst.find(
        (x) => x.subject === ref.targetSubject && x.sha !== c.sha
      );
    }
    if (!target || target.sha === c.sha) continue;
    if (usedAsCulprit.has(target.sha)) continue;
    usedAsCulprit.add(target.sha);
    usedAsAftermath.add(c.sha);
    incidents.push(makeIncident(target, c, "revert"));
  }

  /* ---- quick-fixes ---- */
  // A quickfix is *inferred* from timing, so it is only meaningful when the
  // window can discriminate. If the whole history fits inside the window —
  // typical of a repo younger than two weeks — then every pair of commits is
  // "within 14 days" by construction and the signal is pure noise. Reverts are
  // explicit references and are still reported above.
  const oldest = commitsNewestFirst[commitsNewestFirst.length - 1];
  const newest = commitsNewestFirst[0];
  if (!oldest || !newest) return finish(incidents);
  const historySpanDays =
    (new Date(newest.date).getTime() - new Date(oldest.date).getTime()) / 86_400_000;
  if (historySpanDays <= QUICKFIX_WINDOW_DAYS) return finish(incidents);

  // Index: file path → commits touching it, oldest first.
  const byFile = new Map<string, RawCommit[]>();
  for (const c of [...commitsNewestFirst].reverse()) {
    for (const f of c.files) {
      const list = byFile.get(f.path);
      if (list) list.push(c);
      else byFile.set(f.path, [c]);
    }
  }

  const seenPair = new Set<string>();
  for (const fixer of commitsNewestFirst) {
    if (!isFixLike(fixer.subject) || fixer.isMerge) continue;
    for (const touched of fixer.files) {
      const history = byFile.get(touched.path) ?? [];
      // Walk backwards from fixer to find the nearest non-fix change to this
      // file inside the window.
      let culprit: RawCommit | undefined;
      for (let i = history.length - 1; i >= 0; i--) {
        const candidate = history[i]!;
        if (candidate.date >= fixer.date) continue;
        if (candidate.sha === fixer.sha) continue;
        if (isFixLike(candidate.subject)) {
          // keep walking: this fix is itself an aftermath; the breakage is
          // older. Stop after 3 consecutive fix commits to stay sane.
          let skipCount = 0;
          let j = i;
          while (j >= 0 && isFixLike(history[j]!.subject) && skipCount < 3) {
            j--;
            skipCount++;
          }
          culprit = history[j];
          if (!culprit || culprit.date >= fixer.date) continue;
          break;
        }
        culprit = candidate;
        break;
      }
      if (!culprit || culprit.isMerge) continue;
      if (usedAsCulprit.has(culprit.sha)) continue;

      const hours =
        (new Date(fixer.date).getTime() - new Date(culprit.date).getTime()) / 3_600_000;
      if (hours > QUICKFIX_WINDOW_DAYS * 24 || hours < 0) continue;

      const key = `${culprit.sha}→${fixer.sha}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      usedAsCulprit.add(culprit.sha);
      usedAsAftermath.add(fixer.sha);
      incidents.push(makeIncident(culprit, fixer, "quickfix"));
      break; // one incident per fixer commit
    }
  }

  return finish(incidents);
}

function finish(incidents: Incident[]): Incident[] {
  return incidents
    .sort((a, b) => a.hoursToRepair - b.hoursToRepair || b.netChurn - a.netChurn)
    .slice(0, MAX_INCIDENTS);
}

function makeIncident(culprit: RawCommit, aftermath: RawCommit, kind: Incident["kind"]): Incident {
  const hours = Math.max(
    0,
    (new Date(aftermath.date).getTime() - new Date(culprit.date).getTime()) / 3_600_000
  );
  const churnFiles = [...new Set([...culprit.files, ...aftermath.files].map((f) => f.path))];
  return {
    kind,
    culpritSha: culprit.sha,
    culpritSubject: culprit.subject,
    culpritAuthor: culprit.authorName,
    culpritDate: culprit.date,
    aftermathSha: aftermath.sha,
    aftermathSubject: aftermath.subject,
    aftermathAuthor: aftermath.authorName,
    aftermathDate: aftermath.date,
    hoursToRepair: Math.round(hours * 10) / 10,
    files: churnFiles.slice(0, 8),
    netChurn:
      culprit.files.reduce((a, f) => a + f.additions + f.deletions, 0) +
      aftermath.files.reduce((a, f) => a + f.additions + f.deletions, 0),
  };
}
