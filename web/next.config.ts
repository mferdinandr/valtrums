import type { NextConfig } from "next";

// LOCAL_CI_JOBS (set by scripts/pre-commit.sh) caps the build worker count so a local check does not
// saturate the machine. Unset, Next.js keeps its own default.
const jobs = Number(process.env.LOCAL_CI_JOBS);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(Number.isInteger(jobs) && jobs > 0 ? { experimental: { cpus: jobs } } : {}),
};

export default nextConfig;
