## Why

The Terminal (`/terminal`, change `arena-mcp-terminal`) turns a prompt into one validated intent, a reviewed call and a wallet signature, but it needs battle ids, community numbers, amounts in base units and token addresses, so it is not the "just type what you want" menu it is meant to be. NEAR AI is also not actually active there: the web server does not receive `NEAR_AI_API_KEY`, and the Terminal's default model (`deepseek-ai/DeepSeek-V3.1`) is no longer served by NEAR AI Cloud, so a model call would silently fall back to the rules. It cannot answer simple read questions either.

## What Changes

- **Target:** friendlier write intents: a plain token amount ("100", "0.5") converted to base units once, by code; "an open arena" instead of a battle id; the community of a deposit named by its token (CASHCAT) instead of a number.
- **Target:** when more than one arena or community fits, the Terminal asks: it lists them and the user picks. It never chooses among several. With exactly one it uses it and says why. A deposit of a token no open arena has offers "join with it first".
- **Target:** read-only questions answered from the existing reads: "which arenas are open?" and "my positions". They never build a request and cannot sign.
- **Target:** NEAR AI works in the Terminal: a served default model, the key passed server-side in development (and documented as a server secret in production), and the UI says which parser understood the request and why NEAR AI was not used when it was not.
- **BREAKING (UI semantics):** a plain number in a deposit prompt now means tokens, not base units ("deposit 250 ..." was 250 base units). The review still shows the exact base units and the token before anything is signed.
- Unchanged: intent, review, wallet signature; the model only proposes an intent and never supplies an address, receiver or amount arithmetic; payout stays locked; creating a battle stays on the create page.
- No mainnet deployment and no change to the action boundary.

## Capabilities

### New Capabilities

- `terminal-natural-language`: natural-language Terminal intents, arena and community resolution that asks when ambiguous, read questions, and NEAR AI parsing with an honest parser indicator.

### Modified Capabilities

None. `arena-mcp-terminal` is still a pending change (not in `openspec/specs/`), so its requirements cannot take a delta; this change builds on them.

## Impact

- `web/src/lib/terminal/` (intent model and validation, rule parser, model parser and route, client parser, a new open-arena resolver), `web/src/components/terminal/lifecycle-terminal.tsx`.
- `scripts/dev.mjs` passes the NEAR AI variables to the web server; `.env.example` documents them.
- Cost: one NEAR AI call per prompt (about USD 0.0003); the rule parser answers without one when no key is set or the model fails.
- Open: the Terminal does not yet explain results in prose or chain several actions in one prompt (for example join and then deposit); it offers the next step as a button.
