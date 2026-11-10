import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Old bookmarks of the former A/B app enter the single lifecycle application.
  async redirects() {
    return [
      { source: "/battles", destination: "/arena", permanent: true },
      { source: "/battles/new", destination: "/arena/new", permanent: true },
      { source: "/battles/:id(\\d+)", destination: "/arena/:id", permanent: true },
      { source: "/arena/preview", destination: "/arena", permanent: true },
    ];
  },
};

export default nextConfig;
