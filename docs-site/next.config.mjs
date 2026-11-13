import createMDX from "@next/mdx";

const withMDX = createMDX({
  extension: /\.mdx$/,
  options: {
    // Plugin names as strings so the config also works under Turbopack.
    remarkPlugins: ["remark-gfm", "remark-frontmatter"],
    rehypePlugins: ["rehype-slug"],
  },
});

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx"],
  // Page sources are read at build time for metadata, search and the Markdown copy of each page.
  outputFileTracingIncludes: {
    "/*": ["./content/**/*.mdx"],
  },
  async rewrites() {
    // Every page also has a raw Markdown version at its URL plus `.md`.
    return [{ source: "/:path(.+)\\.md", destination: "/md/:path" }];
  },
};

export default withMDX(nextConfig);
