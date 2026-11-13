import type { MDXContent } from "mdx/types";

type Loader = () => Promise<{ default: MDXContent }>;

/** One static import per page, so every page is compiled at build time. Keep in sync with NAVIGATION. */
export const PAGE_LOADERS: Record<string, Loader> = {
  index: () => import("../../content/index.mdx"),
  quickstart: () => import("../../content/quickstart.mdx"),
  "concepts/how-a-battle-works": () => import("../../content/concepts/how-a-battle-works.mdx"),
  "concepts/scoring-modes": () => import("../../content/concepts/scoring-modes.mdx"),
  "concepts/rewards-and-fees": () => import("../../content/concepts/rewards-and-fees.mdx"),
  "concepts/winners-vote": () => import("../../content/concepts/winners-vote.mdx"),
  "guides/get-test-tokens": () => import("../../content/guides/get-test-tokens.mdx"),
  "guides/create-a-battle": () => import("../../content/guides/create-a-battle.mdx"),
  "guides/join-and-deposit": () => import("../../content/guides/join-and-deposit.mdx"),
  "guides/follow-a-battle": () => import("../../content/guides/follow-a-battle.mdx"),
  "guides/claim-rewards": () => import("../../content/guides/claim-rewards.mdx"),
  "guides/refunds": () => import("../../content/guides/refunds.mdx"),
  "tools/assistant": () => import("../../content/tools/assistant.mdx"),
  "tools/player-agents": () => import("../../content/tools/player-agents.mdx"),
  "trust/token-safety": () => import("../../content/trust/token-safety.mdx"),
  "trust/how-funds-are-held": () => import("../../content/trust/how-funds-are-held.mdx"),
  "reference/faq": () => import("../../content/reference/faq.mdx"),
  "reference/glossary": () => import("../../content/reference/glossary.mdx"),
  "reference/testnet-status": () => import("../../content/reference/testnet-status.mdx"),
};
