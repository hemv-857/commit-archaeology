import type { Metadata } from "next";
import Link from "next/link";
import { parseRepoUrl, RepoUrlError } from "@/lib/repo-url";
import { getStore } from "@/server/store";
import { buildComparison, comparisonVerdict } from "@/lib/compare";
import { formatMonth } from "@/lib/format";
import type { RepoStory } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Compare repositories",
  description: "Put two analysed repositories side by side.",
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

export default async function ComparePage({ searchParams }: Props) {
  const sp = await searchParams;
  const aRaw = one(sp.a);
  const bRaw = one(sp.b);

  let aParsed = null as ReturnType<typeof parseRepoUrl> | null;
  let bParsed = null as ReturnType<typeof parseRepoUrl> | null;
  let invalid: string | null = null;

  try {
    aParsed = aRaw ? parseRepoUrl(aRaw) : null;
  } catch (err) {
    if (err instanceof RepoUrlError) invalid = `a: ${err.message}`;
  }
  try {
    bParsed = bRaw ? parseRepoUrl(bRaw) : null;
  } catch (err) {
    if (err instanceof RepoUrlError) invalid = invalid ?? `b: ${err.message}`;
  }

  const store = await getStore();
  const a = aParsed ? await store.getStory(aParsed.owner, aParsed.name) : null;
  const b = bParsed ? await store.getStory(bParsed.owner, bParsed.name) : null;

  const missing = [
    aParsed && !a ? `${aParsed.owner}/${aParsed.name}` : null,
    bParsed && !b ? `${bParsed.owner}/${bParsed.name}` : null,
  ].filter(Boolean) as string[];

  const slugA = aParsed ? `${aParsed.owner}/${aParsed.name}` : "";
  const slugB = bParsed ? `${bParsed.owner}/${bParsed.name}` : "";

  return (
    <main className="mx-auto max-w-5xl px-4 pb-24 pt-8 sm:px-6">
      <Link href="/" className="text-xs text-stone-500 transition hover:text-amber-300">
        ⛏ Commit Archaeology
      </Link>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">Compare repositories</h1>
      <p className="mt-1 text-sm text-stone-500">
        Two repos, side by side. Both must have been excavated.
      </p>

      <form className="panel mt-6 flex flex-col gap-3 p-4 sm:flex-row" action="/compare">
        <input
          name="a"
          defaultValue={aRaw ?? ""}
          placeholder="github.com/owner/repo"
          aria-label="First repository"
          spellCheck={false}
          className="flex-1 rounded-lg border border-stone-800 bg-stone-900/70 px-3 py-2 font-mono text-sm text-stone-100 outline-none placeholder:text-stone-600 focus:border-amber-500/70"
        />
        <span className="self-center text-stone-600">vs</span>
        <input
          name="b"
          defaultValue={bRaw ?? ""}
          placeholder="github.com/owner/repo"
          aria-label="Second repository"
          spellCheck={false}
          className="flex-1 rounded-lg border border-stone-800 bg-stone-900/70 px-3 py-2 font-mono text-sm text-stone-100 outline-none placeholder:text-stone-600 focus:border-amber-500/70"
        />
        <button
          type="submit"
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-400"
        >
          Compare
        </button>
      </form>

      {invalid && (
        <p role="alert" className="mt-4 text-sm text-red-400">
          {invalid}
        </p>
      )}

      {!aRaw && !bRaw && (
        <p className="mt-8 text-sm text-stone-500">
          Enter two repositories above, or open a story and use its{" "}
          <span className="text-stone-400">Compare</span> link.
        </p>
      )}

      {missing.length > 0 && (
        <div className="panel mt-6 p-4">
          <p className="text-sm text-stone-300">
            Not excavated yet: {missing.join(", ")}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {missing.map((slug) => (
              <li key={slug}>
                <Link
                  href={`/github.com/${slug}`}
                  className="text-amber-400/90 underline hover:text-amber-300"
                >
                  Start the scan for {slug}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {a?.story && b?.story && <Result a={a.story} b={b.story} slugA={slugA} slugB={slugB} />}

      {!a?.story && !b?.story && missing.length === 0 && !invalid && aRaw && bRaw && (
        <p className="mt-8 text-sm text-stone-500">Nothing to compare yet.</p>
      )}

      {a?.story && !b?.story && missing.length === 0 && (
        <p className="mt-8 text-sm text-stone-500">
          <Link href={`/github.com/${slugA}`} className="text-amber-400/90 underline">
            {slugA}
          </Link>{" "}
          is ready — add a second repository above.
        </p>
      )}

      {a?.story && b?.story && <EraColumns a={a.story} b={b.story} slugA={slugA} slugB={slugB} />}
    </main>
  );
}

function Result({
  a,
  b,
  slugA,
  slugB,
}: {
  a: RepoStory;
  b: RepoStory;
  slugA: string;
  slugB: string;
}) {
  const { rows } = buildComparison(a, b);
  return (
    <section aria-label="Comparison table" className="mt-8">
      <p className="text-sm text-stone-400">{comparisonVerdict(slugA, slugB, rows)}</p>
      <div className="panel mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-800 text-left">
              <th scope="col" className="px-4 py-3 font-medium text-stone-500">
                Metric
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-stone-200">
                {slugA}
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-stone-200">
                {slugB}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-900">
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row" className="px-4 py-2.5 text-left font-normal text-stone-500">
                  {r.label}
                  {r.hint && <span className="block text-[10px] text-stone-600">{r.hint}</span>}
                </th>
                <td
                  className={`px-4 py-2.5 font-mono ${
                    r.better === "a" ? "text-emerald-400" : "text-stone-300"
                  }`}
                >
                  {r.a}
                  {r.better === "a" && <span className="ml-1 text-emerald-600">▲</span>}
                </td>
                <td
                  className={`px-4 py-2.5 font-mono ${
                    r.better === "b" ? "text-emerald-400" : "text-stone-300"
                  }`}
                >
                  {r.b}
                  {r.better === "b" && <span className="ml-1 text-emerald-600">▲</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EraColumns({
  a,
  b,
  slugA,
  slugB,
}: {
  a: RepoStory;
  b: RepoStory;
  slugA: string;
  slugB: string;
}) {
  const { erasA, erasB, maxEras } = buildComparison(a, b);
  if (maxEras === 0) return null;

  return (
    <section aria-label="Era comparison" className="mt-10">
      <h2 className="text-lg font-semibold text-stone-200">Feature eras, in order</h2>
      <p className="mt-1 text-sm text-stone-500">
        Aligned by position, not date — era <span className="font-mono">n</span> of each repo.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {[slugA, slugB].map((slug, side) => {
          const eras = side === 0 ? erasA : erasB;
          return (
            <div key={slug} className="panel p-4">
              <Link
                href={`/github.com/${slug}`}
                className="font-mono text-sm text-amber-300/90 hover:text-amber-200"
              >
                {slug}
              </Link>
              <ol className="mt-3 space-y-3">
                {eras.length === 0 && <li className="text-xs text-stone-600">No eras detected.</li>}
                {eras.map((e, i) => (
                  <li key={e.id} className="border-l-2 border-stone-800 pl-3">
                    <div className="font-mono text-[11px] text-stone-500">
                      era {i + 1} · {formatMonth(e.start.slice(0, 7))} · {e.commitCount} commits
                    </div>
                    <div className="mt-0.5 text-sm text-stone-300">{e.title}</div>
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </section>
  );
}