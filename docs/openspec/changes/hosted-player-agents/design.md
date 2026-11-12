## Context

Autonomous agents exist (`agent/src/player/autonomous.ts`, `autonomous-cli.ts`): an agent has its own NEAR account, NEAR AI Cloud decides each play, and it signs `join`, `register` and `deposit` with no approval step. The web page makes the key in the browser and the user must run the process (docs/player-agents.md). The key is held only in React state, so a refresh loses it. The open decision "where an autonomous agent runs for users other than the owner" is decided for testnet: hosted, testnet only.

Trust boundaries:
- **Owner:** controls their own wallet and funds the agent from it. Owns no key on the hosted path unless they export it.
- **Operator/platform:** holds the agent key (encrypted), the NEAR AI key and the runner. This is a custody position the project rules normally forbid ("infrastructure never holds authority over player funds"). The exception is limited to the agent's own account, funded by the user, on testnet.
- **Model:** untrusted; its output is validated as today.
- **Signer/oracle/audit roles:** unchanged; the runner uses none of their keys.

## Goals / Non-Goals

**Goals:**
- Create, fund, start and stop an agent from the web with no terminal and no user secrets.
- Keep keys safe from refresh loss and out of logs and responses.
- Bound the platform's cost and the blast radius of a leak.

**Non-Goals:**
- Mainnet or any non-testnet hosting.
- TEE key custody (undecided, separate change).
- Automatic payout of winnings (still a manual entitlement payout).
- Fees, bring-your-own-key and billing.
- Changing the autonomous decision rules or the grant agent.

## Decisions

1. **Reuse the existing agent loop in a worker.** The runner imports the autonomous loop rather than reimplementing it. A long-lived worker process is required, so this is not a serverless function. Alternative: a function per tick; rejected because the loop keeps state and a 15 s cadence.
2. **Server generates and stores the key.** Encrypted at rest (envelope encryption with a key-encryption key from the environment or a secret manager, not in the database). Alternative: browser key plus upload; rejected because it exposes the key in transit and adds nothing since the operator holds it anyway.
3. **Owner proof via NEP-413 message signing** of a short-lived challenge with the connected wallet, exchanged for a session. Alternative: a plain account id in a header; rejected because it lets anyone control any agent.
4. **Caps enforced server-side** in the worker and the API: agents per owner, per-agent and global model-call caps, per-agent fund cap, and a kill switch read each round. Alternative: rely only on a NEAR AI account spending limit; kept as a last backstop, not the control.
5. **Testnet guard.** The service reads `NEAR_NETWORK` and refuses anything but `testnet`, matching the existing agent check.
6. **Export key** as the owner's exit, so the platform is not the only holder and a user can leave.
7. **Persistence:** a small store (a database or encrypted file store) holds owner, agent account, encrypted key, settings, counters and state. Exact storage is an open question below.

## Risks / Trade-offs

- **Key theft from the operator** → testnet-only and valueless tokens, encrypted keys, per-agent fund cap, clear banner. Not acceptable for mainnet.
- **AI cost abuse** → per-owner agent limit, per-agent and global caps, kill switch, spending limit on the NEAR AI account.
- **Owner impersonation** → signed challenge required for every action; sessions are short-lived.
- **Operator is the single runner** → a worker crash stops all agents; state is resumed from the store and the agent never plays a battle twice.
- **Custody precedent** → recorded as a deviation; reviewed again before any non-testnet use.

## Open Questions

- Where the worker runs (a small VM or container host; not Vercel functions) and who operates it.
- Where keys and state live (managed database vs encrypted files) and where the key-encryption key is kept.
- The exact cap values (agents per owner, calls per hour, fund cap). Do not invent them; the operator sets them in configuration.
- Whether to show a read-only view of agents started outside the web app.
- DAO and audit mechanics remain OPEN and are not touched here.
