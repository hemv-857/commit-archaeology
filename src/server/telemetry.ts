/**
 * Optional Sentry integration. Everything is a no-op unless SENTRY_DSN is set,
 * so dev and self-hosted builds carry zero observability overhead.
 */
export async function initTelemetry(): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? "development",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
      sendDefaultPii: false,
    });
  } catch {
    // Sentry is optional; never let telemetry break the app.
  }
}

export async function captureException(err: unknown, context?: Record<string, unknown>): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    if (context) Sentry.setContext("extra", context);
    Sentry.captureException(err);
  } catch {
    /* ignore */
  }
}
