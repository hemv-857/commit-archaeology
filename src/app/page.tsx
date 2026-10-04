import { ScanForm } from "@/components/ScanForm";

const STEPS = [
  {
    n: "01",
    title: "Paste any public repo",
    body: "No signup, no tokens from you. We validate the URL and start digging.",
  },
  {
    n: "02",
    title: "We excavate the history",
    body: "A blobless clone, every commit's numstat, every PR — clustered into eras, incidents and hotspots.",
  },
  {
    n: "03",
    title: "Read the story",
    body: "Scrub the timeline. Find out who broke what, why the ugly code exists, and how risky the bus factor is.",
  },
];

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-2">
          <span className="text-xl">⛏️</span>
          <span className="font-semibold tracking-tight">Commit Archaeology</span>
        </div>
        <a
          href="https://github.com/hemv-857/commit-archaeology"
          className="text-sm text-stone-500 transition hover:text-stone-300"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
      </header>

      <section className="rise flex flex-1 flex-col items-center justify-center py-16 text-center">
        <div className="chip mb-6 border-amber-500/30 text-amber-300/90">
          git log · archaeology mode
        </div>
        <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight text-stone-100 sm:text-6xl">
          Every repository
          <br />
          <span className="bg-gradient-to-r from-amber-300 via-amber-400 to-orange-400 bg-clip-text text-transparent">
            has a past.
          </span>
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-stone-400 sm:text-lg">
          Commit Archaeology digs through a GitHub repo&apos;s commit history and
          turns it into a readable story: feature eras, who broke what, why the
          ugly code exists, and the bus factor you should worry about.
        </p>
        <div className="mt-10 flex w-full justify-center">
          <ScanForm />
        </div>
      </section>

      <section className="grid gap-4 pb-16 sm:grid-cols-3">
        {STEPS.map((s) => (
          <div key={s.n} className="panel p-5">
            <div className="font-mono text-xs text-amber-500/80">{s.n}</div>
            <div className="mt-2 font-semibold text-stone-200">{s.title}</div>
            <p className="mt-2 text-sm leading-relaxed text-stone-500">{s.body}</p>
          </div>
        ))}
      </section>

      <footer className="flex flex-col items-center gap-2 border-t border-stone-900 py-8 text-xs text-stone-600 sm:flex-row sm:justify-between">
        <span>MIT licensed · analyze responsibly</span>
        <span>
          Built with Next.js · data from the GitHub API ·{" "}
          {/* A plain <a>, deliberately not <Link>: Next prefetches every
              in-viewport Link, which fired /api/health on every landing-page
              visit — spawning a `git --version` subprocess and a store ping per
              page view. The RSC prefetch of a JSON route also never settles,
              holding a connection open. */}
          <a href="/api/health" className="hover:text-stone-400">
            status
          </a>
        </span>
      </footer>
    </main>
  );
}
