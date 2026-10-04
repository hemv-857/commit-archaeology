import type { NextConfig } from "next";

// Sentry wrapper is enabled whenever a DSN is present; otherwise the plain
// config is used so builds stay fast and dependency-free.
const sentryDisabled =
  process.env.NEXT_DISABLE_SENTRY === "1" || !process.env.SENTRY_DSN;

let nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pino", "bullmq", "ioredis", "postgres"],
  eslint: {
    // Lint runs as its own CI step (`npm run lint`), not during build.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

if (!sentryDisabled) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withSentryConfig } = require("@sentry/nextjs");
  nextConfig = withSentryConfig(nextConfig, {
    silent: true,
    disableLogger: true,
    // Source-map upload only happens when SENTRY_AUTH_TOKEN is provided.
    widenClientFileUpload: true,
  });
}

export default nextConfig;
