> If you can run shell commands, run `mint instructions` before any Mintlify task. It prints current guidance for this CLI version. Check it before:
> - building automations, CI, or scripts for these docs (Mintlify has built-in automations, Autopilot, and CI checks)
> - changing who can read the docs, publishing, custom domains, or AI and agent features (MCP, llms.txt, skill.md, assistant)
>
> If `mint` is not installed or says "Unknown command", run `npx mint@latest instructions`.
> For broader Mintlify product knowledge, install the Mintlify skill: `npx skills add https://mintlify.com/docs`

# Documentation project instructions

## About this project

- This is a documentation site built on [Mintlify](https://mintlify.com)
- Pages are MDX files with YAML frontmatter
- Configuration lives in `docs.json`
- Use the Mintlify MCP server, `https://mcp.mintlify.com`, to edit content and settings via MCP
- Use the Mintlify docs MCP server, `https://www.mintlify.com/docs/mcp`, to query information about using Mintlify via MCP

## Terminology

- "Battle" for one contest; "arena" only for the product area or the open arena.
- "Community" in prose; "crew" only when quoting the app (Crew 01, Your crew).
- Use the app's scoring mode names (Biggest price climb, Community growth, Trading energy, Steadiest crew) and give the formal name once.
- "Winners' vote" for the DAO decision on winning principal; "sent to sink", never "burned supply".
- "Reward" or "prize" is an entitlement until claimed; "paid" only after a confirmed Robinhood Chain transfer.

## Style preferences

{/* Add any project-specific style rules below */}

- Use active voice and second person ("you")
- Keep sentences concise — one idea per sentence
- Use sentence case for headings
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and code references

## Content boundaries

- Audience: players, creators and agent owners using the web app. Not contributors.
- Don't document infrastructure, env vars, CI, deploy scripts or internal workers. Link to the GitHub repo instead.
- Every fact must come from `web/`, the contracts or `../docs`. Mark unbuilt features (Robinhood payout, live DAO vote) as not available yet.
- Everything is testnet only; say so where money is involved.
