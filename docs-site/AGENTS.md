# Docs site instructions

A Next.js app (`@valtrum/docs`) that renders the MDX pages in `content/`. See README.md for layout and commands.

## Terminology

- "Battle" for one contest; "arena" only for the product area or the open arena.
- "Community" in prose; "crew" only when quoting the app (Crew 01, Your crew).
- Use the app's scoring mode names (Biggest price climb, Community growth, Trading energy, Steadiest crew) and give the formal name once.
- "Winners' vote" for the DAO decision on winning principal; "sent to sink", never "burned supply".
- "Reward" or "prize" is an entitlement until claimed; "paid" only after a confirmed Robinhood Chain transfer.
- The product is "Valtrums". On-chain account IDs keep their deployed `valtrum-*` names.

## Style

- Second person ("you"), active voice, one idea per sentence.
- Sentence case for headings. Bold for UI labels: select **Claim all**.
- Every page has `title`, `description` (130 to 160 characters) and `keywords`, and opens with a plain paragraph.
- Internal links are root-relative without extension: `/guides/refunds`.
- Visual style comes from the web app (`web/tailwind.config.ts`, `web/src/app/globals.css`); reuse the tokens in `src/app/globals.css`.

## Content boundaries

- Audience: players, creators and agent owners using the web app. Not contributors.
- Don't document infrastructure, env vars, CI, deploy scripts or internal workers. Link to the GitHub repo instead.
- Every fact must come from `web/`, the contracts or `../docs`. Mark unbuilt features (Robinhood payout, live DAO vote) as not available yet.
- Everything is testnet only; say so where money is involved.
