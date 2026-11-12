## Context

The Terminal already maps a prompt to a strict intent (`web/src/lib/terminal/lifecycle-intent.ts`), shows a reviewed call and signs through the action boundary. A parser (rules or a server-side model route) only proposes an intent. The friendliness gap is in the intent model and the resolution steps, not in the boundary. Trust boundaries are unchanged: the model proposes, the validator decides, the backend reads supply ids and representations, and the wallet signs.

## Goals / Non-Goals

**Goals:**
- Type what you want ("deposit 100 CASHCAT to the open arena") and get a reviewed call, asking only when something is ambiguous.
- Answer "which arenas are open?" and "my positions" without any signing path.
- Make NEAR AI actually used, and say when it is not.

**Non-Goals:**
- Choosing a target on the user's behalf when several fit (explicitly decided: ask).
- Chaining several actions in one prompt, free-form prose answers, or payout.
- Changes to the action service, previews or custody.

## Decisions

1. **Amounts are converted by code.** The intent gains `amountTokens` on the wire (a plain decimal string); `tokensToBaseUnits` converts with BigInt and rejects anything else. The model copies the text and never computes. A plain number in the rule parser now means tokens. Alternative: keep base units and add a unit word; rejected because users never think in base units.
2. **`battleId: null` means "an open arena".** The wire form is `battle: "open"` with no `battleId`; both together are refused. Cancel and refund keep requiring an id. Resolution lives in a pure module (`lifecycle-open.ts`) over the backend battle list: filter to open arenas whose start has not passed, soonest first.
3. **Ask, never pick.** `chooseArena` returns one, many or none. Many renders a list with a "use" button; the chosen id re-enters the same plan, so the review and signing path are identical to a prompt that named the battle. Alternative: pick the soonest start automatically; rejected because it chooses a target that moves funds.
4. **Community by token against the battle's own communities** (`communityForToken`), by label symbol, label name or representation. One match is used, none offers "join with it first" (a button that swaps the intent to `join_battle`), several are listed.
5. **Read intents are intents too** (`list_battles`, `show_positions`): validated, described and routed to read-only plans. `intentToRequest` returns null for them, so no code path from them reaches the action service. Positions reuse `usePortfolio` (wallet read session).
6. **NEAR AI plumbing.** The default model becomes `deepseek-ai/DeepSeek-V4.1-Flash-1017` (served; V3.1 is not). The route reports `parser` and a `note` when it fell back, and the client carries them to the UI. In development `scripts/dev.mjs` passes the key from `agent/.env.local` to the web server only; it is never `NEXT_PUBLIC_`.
7. **Cost control.** One model call per prompt; the rule parser answers locally when no key is set and on any model failure, so credits are never required.

## Risks / Trade-offs

- **A number that used to mean base units now means tokens** → the intent summary and the review show the amount in tokens and the exact base units; the example prompts and helper text are updated.
- **A model proposes a wrong token or battle** → resolution is against backend data, the list/ask step handles ambiguity, and the review is shown before any signature.
- **An open arena list can be stale** → the resolved battle is re-read by the plan and the action service revalidates before signing.
- **Read question over-matching in the rule parser** → question detection yields to action verbs (deposit, cancel, refund, payout, create) and to an explicit battle id.

## Open Questions

- Chaining ("join with CASHCAT and deposit 100") in one prompt, with one review per signature.
- Prose explanations of results and a short conversation history.
- Whether the Terminal should be linked from the main navigation (tracked under `arena-mcp-terminal`).
