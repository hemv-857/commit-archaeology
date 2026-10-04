/**
 * Builds deterministic test/demofixtures:
 *
 *   <out>/repos/acme__widget/   — bare git repo with a scripted history:
 *                                  3 eras (gap-separated), multiple authors,
 *                                  one revert pair, one hotfix pair, one merge
 *                                  commit, one churn-heavy file (src/core.js)
 *   <out>/github/acme__widget.json — GitHub REST/GraphQL fixture
 *
 * Used by unit/integration tests (tmp dir) and by Playwright E2E
 * (public/fixtures) with MOCK_GITHUB=1.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import path from "node:path";

export const FIXTURE_OWNER = "acme";
export const FIXTURE_NAME = "widget";

type Author = { name: string; email: string };

const ADA: Author = { name: "Ada Lovelace", email: "ada@example.com" };
const GRACE: Author = { name: "Grace Hopper", email: "grace@example.com" };
const LINUS: Author = { name: "Linus T.", email: "linus@example.com" };

function git(
  cwd: string,
  args: string[],
  opts: { author?: Author; date?: string; msg?: string } = {}
): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.author) {
    env.GIT_AUTHOR_NAME = opts.author.name;
    env.GIT_AUTHOR_EMAIL = opts.author.email;
    env.GIT_COMMITTER_NAME = opts.author.name;
    env.GIT_COMMITTER_EMAIL = opts.author.email;
  }
  if (opts.date) {
    env.GIT_AUTHOR_DATE = opts.date;
    env.GIT_COMMITTER_DATE = opts.date;
  }
  const res = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function write(cwd: string, rel: string, content: string): void {
  const abs = path.join(cwd, rel);
  fssync.mkdirSync(path.dirname(abs), { recursive: true });
  fssync.writeFileSync(abs, content);
}

function commit(
  cwd: string,
  msg: string,
  author: Author,
  date: string,
  extraArgs: string[] = []
): string {
  git(cwd, ["add", "-A"], {});
  git(cwd, ["commit", "--allow-empty", "-m", msg, ...extraArgs], { author, date });
  return git(cwd, ["rev-parse", "HEAD"], {});
}

export async function buildFixtures(outDir: string): Promise<string> {
  const reposDir = path.join(outDir, "repos");
  const githubDir = path.join(outDir, "github");
  const workDir = path.join(outDir, "work");
  await fs.mkdir(reposDir, { recursive: true });
  await fs.mkdir(githubDir, { recursive: true });
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const src = path.join(workDir, "widget");
  fssync.mkdirSync(src, { recursive: true });
  git(src, ["init", "-b", "main"], {});
  git(src, ["config", "user.name", "fixture"], {});
  git(src, ["config", "user.email", "fixture@example.com"], {});

  /* ---------------- Era 1: Jan 2024 — core engine ---------------- */
  write(src, "README.md", "# widget\n\nA fixture repository for Commit Archaeology.\n");
  write(src, "package.json", '{\n  "name": "widget",\n  "version": "0.1.0"\n}\n');
  commit(src, "chore: scaffold the widget repo", ADA, "2024-01-02T09:00:00+00:00");

  write(
    src,
    "src/core.js",
    Array.from({ length: 40 }, (_, i) => `export function core_${i}(x) { return x * ${i}; }`).join("\n") + "\n"
  );
  write(src, "src/util.js", "export const util = (x) => x + 1;\n");
  commit(src, "Add initial core engine (#1)", ADA, "2024-01-03T10:00:00+00:00");

  // quickfix pair: fix a few days later, touching the same file
  write(src, "src/core.js", Array.from({ length: 42 }, (_, i) => `export function core_${i}(x) { return x * ${i}; }`).join("\n") + "\n");
  commit(src, "Fix startup crash in core init (#2)", GRACE, "2024-01-05T11:00:00+00:00");

  for (let i = 0; i < 4; i++) {
    write(src, "src/util.js", `export const util = (x) => x + ${i + 2};\n`);
    commit(src, `refactor: tune util step ${i} (#${10 + i})`, ADA, `2024-01-1${i + 1}T12:00:00+00:00`);
  }

  // revert pair (body references the sha, like git revert does)
  write(src, "src/experimental.js", "export const flag = true;\n");
  const badSha = commit(src, "Add experimental feature flag (#23)", GRACE, "2024-01-18T14:00:00+00:00");
  write(src, "src/experimental.js", "");
  await fs.rm(path.join(src, "src/experimental.js"));
  commit(
    src,
    'Revert "Add experimental feature flag (#23)"',
    ADA,
    "2024-01-19T15:00:00+00:00",
    ["-m", `This reverts commit ${badSha}.`]
  );

  /* ---------------- Era 2: Mar 2024 — compiler ---------------- */
  write(src, "src/compiler/parser.js", "export const parse = (s) => s.split(';');\n");
  write(src, "src/compiler/emit.js", "export const emit = (ast) => ast.join(';');\n");
  commit(src, "Add compiler parser (#40)", GRACE, "2024-03-04T10:00:00+00:00");
  for (let i = 0; i < 5; i++) {
    write(
      src,
      "src/compiler/parser.js",
      `export const parse = (s) => s.split(';');\n// v${i}\nexport const parseV${i} = parse;\n`
    );
    commit(src, `perf: speed up parser pass ${i} (#4${i})`, GRACE, `2024-03-0${i + 5}T11:00:00+00:00`);
  }
  write(src, "src/core.js", Array.from({ length: 45 }, (_, i) => `export function core_${i}(x) { return x * ${i}; }`).join("\n") + "\n");
  commit(src, "core: wire compiler into core loop (#45)", ADA, "2024-03-14T12:00:00+00:00");

  // merge commit via --no-ff (subject references PR #101)
  git(src, ["checkout", "-b", "feature/turbo"], {});
  write(src, "src/compiler/turbo.js", "export const turbo = true;\n");
  commit(src, "feat: turbo mode groundwork", ADA, "2024-03-16T13:00:00+00:00");
  git(src, ["checkout", "main"], {});
  git(
    src,
    [
      "merge",
      "--no-ff",
      "-m",
      "Merge pull request #101 from acme/feature/turbo",
      "feature/turbo",
    ],
    { author: GRACE, date: "2024-03-18T14:00:00+00:00" }
  );

  /* ---------------- Era 3: May 2024 — CLI & docs ---------------- */
  write(src, "cli/main.js", "#!/usr/bin/env node\nconsole.log('widget cli');\n");
  write(src, "docs/guide.md", "# Guide\n\nRun the widget.\n");
  commit(src, "Add CLI entrypoint (#50)", LINUS, "2024-05-02T10:00:00+00:00");
  for (let i = 0; i < 6; i++) {
    write(src, "docs/guide.md", `# Guide\n\nRun the widget.\n\nSection ${i}.\n`);
    write(src, "cli/main.js", `#!/usr/bin/env node\nconsole.log('widget cli v${i}');\n`);
    commit(src, `docs: expand guide ch.${i} (#5${i})`, LINUS, `2024-05-0${i + 3}T11:00:00+00:00`);
  }
  // hotfix touching the oldest hot file again (cross-era quickfix → skip; window
  // is 14d so this is only counted as churn — fine)
  write(src, "src/core.js", Array.from({ length: 48 }, (_, i) => `export function core_${i}(x) { return x * ${i}; }`).join("\n") + "\n");
  commit(src, "hotfix: patch core race under load (#60)", GRACE, "2024-05-16T12:00:00+00:00");
  commit(src, "docs: final polish", LINUS, "2024-05-18T13:00:00+00:00");

  /* ---------------- bare clone + GitHub fixture ---------------- */
  const bare = path.join(reposDir, "acme__widget");
  await fs.rm(bare, { recursive: true, force: true });
  git(path.dirname(src), ["clone", "--bare", src, bare], {});
  git(bare, ["config", "core.quotepath", "false"], {});

  const headSha = git(src, ["rev-parse", "HEAD"], {});
  const fixture = {
    headSha,
    commitCount: 24,
    repo: {
      name: "widget",
      full_name: "acme/widget",
      description: "A fixture widget repository with a dramatic past.",
      stargazers_count: 4242,
      forks_count: 42,
      language: "JavaScript",
      default_branch: "main",
      private: false,
      fork: false,
      archived: false,
      html_url: "https://github.com/acme/widget",
      size: 12_000,
    },
    prTotalCount: 60,
    pullRequests: [
      {
        number: 1,
        title: "Add initial core engine",
        url: "https://github.com/acme/widget/pull/1",
        author: "ada",
        state: "MERGED",
        createdAt: "2024-01-03T09:30:00Z",
        mergedAt: "2024-01-03T10:00:00Z",
        additions: 40,
        deletions: 0,
        changedFiles: 2,
        body: "The original core engine. This PR is why src/core.js is 4000 lines and everyone is scared of it. We shipped it on a Friday.",
      },
      {
        number: 2,
        title: "Fix startup crash in core init",
        url: "https://github.com/acme/widget/pull/2",
        author: "grace",
        state: "MERGED",
        createdAt: "2024-01-05T10:30:00Z",
        mergedAt: "2024-01-05T11:00:00Z",
        additions: 3,
        deletions: 1,
        changedFiles: 1,
        body: "Emergency fix: the core engine crashed on startup when the config file was missing. Regression test included.",
      },
      {
        number: 23,
        title: "Add experimental feature flag",
        url: "https://github.com/acme/widget/pull/23",
        author: "grace",
        state: "MERGED",
        createdAt: "2024-01-18T13:30:00Z",
        mergedAt: "2024-01-18T14:00:00Z",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        body: "Adds a flagged experiment. (Reverted the next day — see #24.)",
      },
      {
        number: 101,
        title: "Turbo mode groundwork",
        url: "https://github.com/acme/widget/pull/101",
        author: "ada",
        state: "MERGED",
        createdAt: "2024-03-15T09:00:00Z",
        mergedAt: "2024-03-18T14:00:00Z",
        additions: 10,
        deletions: 2,
        changedFiles: 2,
        body: "Groundwork for turbo mode: the compiler learns to go brrr. Blocks #102.",
      },
      {
        number: 60,
        title: "hotfix: patch core race under load",
        url: "https://github.com/acme/widget/pull/60",
        author: "grace",
        state: "MERGED",
        createdAt: "2024-05-16T11:00:00Z",
        mergedAt: "2024-05-16T12:00:00Z",
        additions: 5,
        deletions: 2,
        changedFiles: 1,
        body: "Production was losing widgets under load. This patches the race in the core loop. Full postmortem in the wiki.",
      },
      // Deliberately unreachable: no commit subject cites these. They exist so
      // tests can prove `prIndex` is trimmed to the reachable set rather than
      // stored verbatim — on a real repo the fetched list is mostly like this.
      {
        number: 900,
        title: "Bump transitive dep nobody references",
        url: "https://github.com/acme/widget/pull/900",
        author: "ada",
        state: "MERGED",
        createdAt: "2024-04-01T09:00:00Z",
        mergedAt: "2024-04-01T10:00:00Z",
        additions: 3,
        deletions: 3,
        changedFiles: 1,
        body: "Routine dependency bump with a long body that would otherwise be persisted into every page load.",
      },
      {
        number: 901,
        title: "Update docs for the flags endpoint",
        url: "https://github.com/acme/widget/pull/901",
        author: "grace",
        state: "MERGED",
        createdAt: "2024-04-02T09:00:00Z",
        mergedAt: "2024-04-02T10:00:00Z",
        additions: 40,
        deletions: 12,
        changedFiles: 2,
        body: "Another unreferenced pull request body that inflates the payload if not trimmed.",
      },
      {
        number: 902,
        title: "CI: cache the fixture build",
        url: "https://github.com/acme/widget/pull/902",
        author: "linus",
        state: "MERGED",
        createdAt: "2024-04-03T09:00:00Z",
        mergedAt: "2024-04-03T10:00:00Z",
        additions: 18,
        deletions: 4,
        changedFiles: 1,
        body: "Third unreachable PR, present purely so the trim is measurable in tests.",
      },
    ],
  };
  await fs.writeFile(
    path.join(githubDir, "acme__widget.json"),
    JSON.stringify(fixture, null, 2)
  );

  // cleanup working clone, keep only the bare repo + fixture json
  await fs.rm(workDir, { recursive: true, force: true });
  return bare;
}

/** CLI entrypoint: npm run fixture:repos */
if (process.argv[1] && process.argv[1].endsWith("make-fixture-repos.ts")) {
  const out = process.env.FIXTURE_OUT ?? path.join(process.cwd(), "public", "fixtures");
  buildFixtures(out)
    .then((p) => console.log(`fixtures written to ${p}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
