## 1. Intent model and parsers

- [x] 1.1 Add plain token amounts (`amountTokens`, code-side conversion), `battle: "open"`, a token instead of a community number, and the `list_battles` and `show_positions` intents to the strict validator, the wire form and the descriptions.
- [x] 1.2 Extend the rule parser (English and Bahasa Indonesia) for open arenas, token amounts, token names and the two questions; update its tests (a plain number now means tokens).
- [x] 1.3 Update the NEAR AI parser prompt for the new schema and the default model to one that is served.
- [x] 1.4 Report the parser used and the fallback reason from the route and carry them through the client parser.

## 2. Resolution and UI

- [x] 2.1 Add the pure open-arena and token resolution module with tests (one, many, none; never picks among several).
- [x] 2.2 Render the open-arena resolver (use the only one and say why, or list and ask), the "join with it first" step, community-by-token, the arena list answer and the positions answer.
- [x] 2.3 Show which parser understood the request and why NEAR AI was not used; update examples and helper text.

## 3. Configuration, docs and verification

- [x] 3.1 Pass the NEAR AI variables from `agent/.env.local` to the web server in `pnpm dev`; document them in `.env.example`.
- [x] 3.2 Try the Terminal against NEAR AI Cloud with a small, bounded number of prompts and record the result.
- [x] 3.3 Run `scripts/pre-commit.sh` and `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`.
- [ ] 3.4 Chaining several actions in one prompt (left open; see design).
