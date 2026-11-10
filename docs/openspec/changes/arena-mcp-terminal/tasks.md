# Tasks

Check tasks only after implementation and verification. Player authorization and stable read/preview interfaces are prerequisites.

## Read interfaces

- [x] Expose battle, round and audit reads with network, source, freshness and known limitations. (`agent/src/mcp/tools.ts`, `envelope.ts`)
- [x] Expose account-scoped positions, entitlements, payouts and principal escrow without granting signing authority. Entitlements report `available: false` until a contract exposes them; escrow disposition stays `undecided` until the D22 vote is implemented (#75).
- [x] Show available, reserved, broadcast, confirmation-pending and confirmed payout states separately. (`agent/src/mcp/payout-display.ts`; `inspect_payouts` returns `displayState` and a label per payout.)
- [x] Use backend search and filtering for searchable lists and dropdowns; debounce text requests and prevent stale results. (`list_battles`, `web/src/hooks/use-battle-search.ts`); no new-arena list UI exists yet to wire it into.

## Preview and execution

- [x] Define canonical create, deposit and payout previews binding assets, amounts, recipient, network, costs, policy version and expiry. (`agent/src/mcp/actions/preview.ts`, policy `action-preview-v1`, 5-minute expiry.)
- [x] Hash and persist previews and bind user authorization or a valid scoped grant to the canonical action. (Canonical-JSON SHA-256 `previewHash`; versioned JSON store `actions/store.ts`; NEP-413 signature over the preview hash, or the grant delegate preparing the contract's `reserve` call.)
- [x] Revalidate preview, balances, audit, round state and grant scope before signing or reserving budget. (`ActionService.prepare` rebuilds the preview from fresh reads and refuses any change in the binding hash.)
- [x] Return durable action identity and status; reject changed or expired previews without valid authorization. (`act_…` ids; statuses previewed, authorized, ready_to_sign, broadcast, confirmed, failed, rejected, expired.)
- [x] Explicitly reject unsupported testnet funding routes and label fixture outputs as fixtures. (Only `direct` deposits; any other route returns `unsupported_route` before anything is stored or built. The only addition is the labelled testnet `intents-fixture` route of #114 / D29, enabled by `INTENTS_FIXTURE=1` on testnet; the real `intents` route stays refused.)
- [x] Connect MCP tool and terminal action paths to the same authorization and status boundary. (MCP action tools and `/actions` HTTP routes call one `ActionService`; the terminal uses `web/src/lib/terminal/actions.ts` through `/api/arena/actions`.)

## Verification

- [x] Test read-only calls cannot sign or spend and account-scoped reads do not expose another user's data.
- [x] Test changed recipient, amount, policy or expired preview and revoked or missing authorization. (`agent/test/mcp/actions.test.ts`)
- [x] Test broadcast hash remains pending until verified receipt and unsupported routes submit no funds. (`agent/test/mcp/actions.test.ts`, `web/src/lib/terminal/actions.test.ts`)
- [x] Test backend search parameters, debounce, cancellation and stale-response protection where search is provided.

## Lifecycle terminal UI

- [x] Specify the lifecycle intent terminal requirements and scenarios (this change).
- [x] Strict lifecycle intent model and mapping to action requests. (`web/src/lib/terminal/lifecycle-intent.ts`)
- [x] Rule parser (English and Bahasa Indonesia), asset resolution through the backend registry search, and the optional model parser behind `/api/terminal/lifecycle`. (`lifecycle-rule-parser.ts`, `lifecycle-resolve.ts`, `lifecycle-llm-parser.ts`, `lifecycle-parse-route.ts`). Tokens resolve by registry address only: the registry has no symbols, so a name is a clarifying question.
- [x] Terminal UI replacing the A/B terminal: prompt, intent summary, reviewed call, preview/compare/authorize/sign, verified receipt, separate deposit credit read. (`web/src/components/terminal/lifecycle-terminal.tsx`, `/terminal`). Wallet signing itself is NOT exercised by any test here (needs a real wallet, acceptance issue #80).
- [x] Payout intent reviewed with submission disabled and the specific reason (blocked on #148 and an exposed entitlement). The payout stays blocked; nothing in the terminal can submit it.
- [x] Unit tests (parsers, hostile model output, amount edges, 2 to 16 communities, unresolved assets, mapping, route with a fake model fetch) and a Brave e2e on the fixture service (`web/e2e/arena.spec.ts`, no action request before the user asks for a preview).
- [ ] Remove the legacy A/B terminal panel, `/api/terminal/parse` and `/api/terminal/funding`, funding adapters and session keys once the legacy battle page and providers no longer import them (owned by the legacy cleanup).
- [ ] Link the terminal from the navigation (navbar is outside this change).
