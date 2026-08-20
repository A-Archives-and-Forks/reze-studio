import type { NextConfig } from "next"
// import { join } from "path"

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: false,
  devIndicators: false,
  // outputFileTracingRoot: join(__dirname, ".."),
  /**
   * Let browsers KEEP the bundled model + demo motion.
   *
   * Next serves `public/` as `max-age=0, must-revalidate` — cache the bytes,
   * then ask about them anyway. These directories are versioned by PATH (see
   * reze-design's next.config.ts), so they can be immutable, with the
   * discipline that comes with it: rename, never overwrite in place.
   */
  async headers() {
    return [
      {
        source: "/:dir(models|animations)/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ]
  },
}

export default nextConfig
