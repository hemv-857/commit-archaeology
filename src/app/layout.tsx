import type { Metadata } from "next";
import "./globals.css";
import { config } from "@/server/config";

export const metadata: Metadata = {
  // Absolute URLs for OG/Twitter images. Without this Next falls back to the
  // incoming request host, which produces wrong links behind a proxy.
  metadataBase: new URL(config().publicBaseUrl),
  title: {
    default: "Commit Archaeology — every repo has a past",
    template: "%s · Commit Archaeology",
  },
  description:
    "Turn any public GitHub repository's commit history into a readable narrative: feature eras, who broke what, why the ugly code exists, and the bus factor.",
  openGraph: {
    title: "Commit Archaeology",
    description:
      "Every repo has a past. Dig through feature eras, broken commits, hotspots and bus factor.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="site-bg min-h-screen">{children}</body>
    </html>
  );
}
