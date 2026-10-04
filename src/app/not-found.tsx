import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <div className="text-5xl">🦴</div>
      <h1 className="mt-4 text-2xl font-bold">Nothing buried here</h1>
      <p className="mt-2 text-sm text-stone-500">
        The page you asked for doesn&apos;t exist. Only public GitHub repositories
        can be excavated at <code className="font-mono text-amber-400/80">/github.com/owner/repo</code>.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-400"
      >
        Back to the dig site
      </Link>
    </main>
  );
}
