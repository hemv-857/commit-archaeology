# Commit Archaeology

Turn any public GitHub repository's commit history into a readable narrative: feature
eras, who broke what, why the ugly code exists, and how risky the bus factor is.

Paste a repo URL, get a shareable story at `/github.com/{owner}/{repo}`.

## How it works

```
POST /api/scan ──▶ queue ──▶ pipeline ──▶ store ──▶ SSE progress ──▶ story page
                   (memory     clone           (file or
                    or BullMQ) git log         Postgres)
```

A scan runs in stages, each emitting progress over Server-Sent Events so the UI shows
live state instead of a spinner:

| Stage | What happens |
| --- | --- |
| `validate` | Repo metadata + default-branch HEAD (the cache key) |
| `clone` | Bare, blobless clone (`--filter=blob:none`) into a temp dir |
| `history` | One `git log --numstat` pass → commits + per-file churn |
| `prs` | GraphQL pull-request index (titles, bodies, authors) |
| `compute` | Eras, incidents, hotspots, churn, authors, bus factor, timeline |
| `ai` | *Optional.* LLM narrative beats per era, cached by commit range |
| `persist` | Store the story, keyed by HEAD sha |

Everything degrades gracefully: no PRs still yields a commit-level story, no
`OPENAI_API_KEY` skips narration, no Redis falls back to an in-process queue.

## Requirements

- **Node.js >= 22**
- **git** on `PATH` (the app shells out; `/api/health` reports `checks.git`)

## Quick start

```bash
npm install
cp .env.example .env      # optional — every value has a working default
npm run dev               # http://localhost:3000
```

With no configuration at all, the app runs fully self-contained: file-backed cache,
in-process queue, in-memory rate limiting.

### Try it without hitting GitHub

```bash
npm run fixture:repos     # writes deterministic fixtures to public/fixtures
MOCK_GITHUB=1 npm run dev # serves acme/widget from fixtures, zero network
```

## Configuration

Every variable is optional. See `.env.example` for the annotated list.

| Variable | Default | Notes |
| --- | --- | --- |
| `GITHUB_TOKENS` | *(empty)* | Comma-separated pool. Anonymous calls are capped at 60/hour per IP and will surface a rate-limit error. |
| `DATABASE_URL` | *(empty)* | Postgres. Unset → JSON files under `DATA_DIR`. |
| `REDIS_URL` | *(empty)* | Redis for BullMQ + cross-instance progress. Unset → in-process queue. |
| `DISABLE_INLINE_WORKER` | `0` | Set to `1` on web containers when running dedicated workers. |
| `DATA_DIR` | `.data` | File-store location. |
| `MAX_COMMIT_COUNT` | `200000` | Newest-N commits analyzed. |
| `SCAN_CONCURRENCY` | `2` | Simultaneous scans per worker. |
| `CLONE_TIMEOUT_MS` | `300000` | Wall-clock cap on clone *and* `git log`. |
| `REVALIDATE_AFTER_SEC` | `3600` | Cached stories older than this re-scan in the background. |
| `OPENAI_API_KEY` | *(empty)* | Enables era narration. Fails soft. |
| `SENTRY_DSN` | *(empty)* | Error reporting. |

## Testing

```bash
npm run lint
npm run typecheck
npm test            # 62 unit + integration tests, no network
npm run build
npm run test:e2e    # Playwright; builds fixtures, resets its own cache
```

E2E boots the production build on port 3187 with `MOCK_GITHUB=1`, so it never
touches the network and never collides with a dev server you have running.

## Self-hosting

### Docker Compose

```bash
docker compose up --build          # app + postgres + redis
```

The web container runs scans inline. To scale scanning out, add dedicated workers:

```bash
DISABLE_INLINE_WORKER=1 docker compose --profile scale up --build
```

The memory queue driver is per-process, so standalone workers **require**
`REDIS_URL` — they exit with an error otherwise.

### Fly.io

```bash
fly launch --copy-config --no-deploy    # fly.toml is ready
fly secrets set GITHUB_TOKENS=... REDIS_URL=... DATABASE_URL=...
fly deploy
```

## Architecture notes

**Cache key is the HEAD sha.** A story is stored per commit range, so a repo that has
not moved serves instantly from cache. Stale entries re-scan in the background
(stale-while-revalidate) instead of blocking the request.

**The worker boots lazily** on the first enqueue, not at process start. A web process
that never receives a scan opens no Redis connection and runs no queue consumer. This
is also why there is no `instrumentation.ts`: Next.js does not apply
`serverExternalPackages` to the instrumentation bundle, so importing the worker there
pulls bullmq's node builtins into a bundle that cannot resolve them and the production
build fails.

**Git access is bounded.** Clone and `git log` share one helper with a wall-clock
timeout, capped output, and `GIT_TERMINAL_PROMPT=0`. Tokens reach git via an ephemeral
`http.extraheader` in the child env — never in a URL, never logged.

**Input validation is strict.** Only `https://github.com/{owner}/{repo}` is accepted;
host, scheme, port and userinfo are re-checked after parsing. Route handlers receive
raw path params rather than a typed URL, so they validate independently before those
segments become filesystem paths.

## License

MIT