# Tasks

Check tasks only after implementation and verification. Player authorization and stable read/preview interfaces are prerequisites.

## Read interfaces

- [x] Expose battle, round and audit reads with network, source, freshness and known limitations. (`agent/src/mcp/tools.ts`, `envelope.ts`)
- [x] Expose account-scoped positions, entitlements, payouts and principal escrow without granting signing authority. Entitlements report `available: false` until a contract exposes them; escrow disposition stays `undecided` until the D22 vote is implemented (#75).
- [ ] Show available, reserved, broadcast, confirmation-pending and confirmed payout states separately.
- [x] Use backend search and filtering for searchable lists and dropdowns; debounce text requests and prevent stale results. (`list_battles`, `web/src/hooks/use-battle-search.ts`); no new-arena list UI exists yet to wire it into.

## Preview and execution

- [ ] Define canonical create, deposit and payout previews binding assets, amounts, recipient, network, costs, policy version and expiry.
- [ ] Hash and persist previews and bind user authorization or a valid scoped grant to the canonical action.
- [ ] Revalidate preview, balances, audit, round state and grant scope before signing or reserving budget.
- [ ] Return durable action identity and status; reject changed or expired previews without valid authorization.
- [ ] Explicitly reject unsupported testnet funding routes and label fixture outputs as fixtures.
- [ ] Connect MCP tool and terminal action paths to the same authorization and status boundary.

## Verification

- [x] Test read-only calls cannot sign or spend and account-scoped reads do not expose another user's data.
- [ ] Test changed recipient, amount, policy or expired preview and revoked or missing authorization.
- [ ] Test broadcast hash remains pending until verified receipt and unsupported routes submit no funds.
- [x] Test backend search parameters, debounce, cancellation and stale-response protection where search is provided.
