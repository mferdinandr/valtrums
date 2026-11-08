## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver mcp and terminal and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-mcp-terminal/spec.md).
- Integration boundary: Requires player authorization and stable read/preview interfaces.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

- Read layer (`agent/src/mcp/`). Tools receive only an `ArenaReadSource` (NEAR `view` calls; no private key in the read service), the audit report archive and the session verifier, so no handler can sign, send or reserve. Every answer uses one envelope: network, source kind (`live`/`recorded`/`fixture`), observedAt, freshness and limitations. Unknown tools and arguments are refused before any read.
- Read sessions. `open_read_session` / `POST /session` verify a NEP-413 signature over a fixed message and recipient, require a full-access key of the account (near-kit lookup), reject nonces older than 5 minutes or reused, and return an HMAC token (1 h) bound to the account. Account-scoped tools resolve the caller only from that token and refuse a different `accountId`. Over HTTP the token is accepted only in the Authorization header.
- Search. `list_battles` validates `q`, `mode`, `status`, `community`, `cursor`, `limit` (max 50) and scans at most 200 battles per request, returning `nextCursor`/`truncated`. The web controller debounces text, sends filter changes at once, aborts the previous request and drops superseded responses.
- Known limits: entitlements have no deployed view (`available: false`, not zero); `list_open_payouts` omits terminal payouts; escrow disposition is reported `undecided` until the D22 vote (decided, not implemented) exists. Preview, submit, action status and revocation are separate tasks.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
