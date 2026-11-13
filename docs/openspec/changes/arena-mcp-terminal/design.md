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
- Read sessions. `open_read_session` / `POST /session` verify a NEP-413 signature over a fixed message and recipient, require a full-access key of the account (near-kit lookup), reject nonces older than 5 minutes or reused, and return an HMAC token (1 h) bound to the account. The web keeps the token in the tab's sessionStorage until it expires (not localStorage, cookies or URLs), so a reload does not ask the wallet again; it is cleared on sign-out and when the service rejects it. Account-scoped tools resolve the caller only from that token and refuse a different `accountId`. Over HTTP the token is accepted only in the Authorization header.
- Search. `list_battles` validates `q`, `mode`, `status`, `community`, `cursor`, `limit` (max 50) and scans at most 200 battles per request, returning `nextCursor`/`truncated`. The web controller debounces text, sends filter changes at once, aborts the previous request and drops superseded responses.
- Known limits: entitlements have no deployed view (`available: false`, not zero); `list_open_payouts` omits terminal payouts; escrow disposition is reported `undecided` until the D22 vote (decided, not implemented) exists.
- Action boundary (`agent/src/mcp/actions/`, #76, owner decision D25). One `ActionService` serves the MCP action tools and the `/actions` HTTP routes used by the terminal. It never signs or sends.
  - **Steps:** `preview` builds a canonical preview for create_battle, deposit or payout, `authorize` binds an authorization, `prepare` revalidates and hands out the transaction, `broadcast` records the hash, and `status` checks the receipt.
  - **Preview:** binds kind, network, the funds' account, the signer, assets, amounts, recipient, costs, policy `action-preview-v1`, a 5-minute expiry and the exact unsigned transaction. `previewHash` is SHA-256 over canonical JSON; `bindingHash` excludes timestamps.
  - **Authorization** is either:
    - a NEP-413 signature by a full-access key of the funds' account over `Authorize Valtrum action <previewHash>…` (single-use nonce, 5 minutes old at most); or
    - `{kind: "session"}`: the read session of the funds' account itself, accepted only for a user-signed preview whose account, signer and transaction signer are all the session's account. The session was opened with a full-access-key NEP-413 signature, and authorizing moves nothing: funds move only when that account's wallet signs the prepared transaction, whose receipt must match. The web uses this, so each action asks the wallet once (the transaction) instead of twice (owner decision, 2026-11-13); or
    - for a grant, the caller must be the grant's delegate, and the prepared transaction is only that delegate's `player-policy.reserve`, which re-checks the full scope on-chain.
  - **Revalidation:** `prepare` rebuilds from fresh reads (lock state, audit and backing evidence, registered position, balance or entitlement, grant revocation, expiry and caps) and refuses any binding change.
  - **Status:** a broadcast stays pending until a final receipt of the same signer, receiver, method, arguments and deposit succeeds in every receipt. Only `direct` deposits are supported; other routes are refused before anything is stored.
  - **Storage:** one versioned JSON file with atomic writes that fails closed on corruption.
  - **Limits:** grant-based payouts are refused (the grant needs the backing's asset identity), and executing a reserved grant action is #77.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.

- Lifecycle terminal (web). The earlier A/B USDC terminal is replaced by an intent terminal for the lifecycle contracts; there is no legacy mode.
  - **Intent model** (`web/src/lib/terminal/lifecycle-intent.ts`): a union of `create_battle` (mode plus asset references), `register_position`, `deposit` and `payout`, validated with the action boundary's rules (`validateRequest` in `agent/src/mcp/actions/preview.ts`): battle id a positive safe integer, community 0 to 15, amount `^[1-9][0-9]{0,38}$`, EVM addresses, four scoring modes, 2 to 16 assets. Users count communities from 1; the intent stores the 0-based index.
  - **Parsers:** a deterministic rule parser (English and Bahasa Indonesia) and an optional NEAR AI Cloud parser behind `/api/terminal/lifecycle` (server-side key `NEAR_AI_API_KEY`). The model sees the user text as data, returns JSON only, and its reply is validated strictly; an invalid reply falls back to the rule parser. A parser never produces an address: a `create_battle` carries asset references (0x address, `chain:address`, or an address prefix) that the client resolves through `/api/arena/v1/assets`. The registry has no symbols, so a name that is not an address is a clarifying question.
  - **Review:** the intent maps to the existing reviews (`buildCreateReview`, `buildRegisterReview`, `buildDepositReview`). A deposit's receiving token is read from the battle's recorded community representation, never from the prompt. Representation and custody domain for a created asset are not in the registry; the user enters them, as on the lifecycle create page.
  - **Execution:** the same `useLifecycleCreate` flow as the other lifecycle pages (preview, equality check, authorize, wallet signature, verified receipt). Credit for a deposit is read separately after the receipt. A payout shows its review with submission disabled and the specific reason. Nothing calls the action service until the user presses the preview button.
