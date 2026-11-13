/** Site-wide constants and the sidebar, in reading order. Every slug is a file in `content/<slug>.mdx`. */

export const SITE_URL = "https://docs.valtrums.xyz";
export const APP_URL = "https://valtrums.xyz";
export const GITHUB_URL = "https://github.com/mferdinandr/valtrums";

export interface NavGroup {
  group: string;
  pages: string[];
}

export const NAVIGATION: NavGroup[] = [
  {
    group: "Get started",
    pages: ["index", "quickstart", "concepts/how-a-battle-works"],
  },
  {
    group: "Play",
    pages: [
      "guides/get-test-tokens",
      "guides/create-a-battle",
      "guides/join-and-deposit",
      "guides/follow-a-battle",
      "concepts/scoring-modes",
    ],
  },
  {
    group: "After the battle",
    pages: [
      "concepts/rewards-and-fees",
      "guides/claim-rewards",
      "concepts/winners-vote",
      "guides/refunds",
    ],
  },
  {
    group: "Tools",
    pages: ["tools/assistant", "tools/player-agents"],
  },
  {
    group: "Trust and safety",
    pages: ["trust/token-safety", "trust/how-funds-are-held"],
  },
  {
    group: "Reference",
    pages: ["reference/faq", "reference/glossary", "reference/testnet-status"],
  },
];

export const ALL_SLUGS: string[] = NAVIGATION.flatMap((g) => g.pages);

/** The URL path of a page: `index` is the site root. */
export function hrefOf(slug: string): string {
  return slug === "index" ? "/" : `/${slug}`;
}

export function groupOf(slug: string): string | undefined {
  return NAVIGATION.find((g) => g.pages.includes(slug))?.group;
}
