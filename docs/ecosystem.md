# Ecosystem and integration map

Status as of **2026-11-14**. Valtrums runs on NEAR testnet only; Robinhood Chain mainnet is read for prices, liquidity and token audits, and nothing is sent to Robinhood Chain. Priority P0 blocks the target acceptance, P1 is an enhancement and P2 is a candidate. "Live" means it runs in the deployed testnet application; documentation availability is not an integration test.

| Partner / component | Function in Valtrums | Priority | State |
| --- | --- | --- | --- |
| NEAR Protocol / NEP-141 | Battle state, community tokens, rewards, escrow and burns | P0 | Live on testnet |
| Robinhood Chain (mainnet, 4663) | Uniswap v3 `slot0` prices for round scoring and the live price preview; pool balances for the LP check (read only) | P0 | Live |
| GoPlus | Critical token-risk evidence for each mainnet reference token ([policy](goplus-audit.md)) | P0 | Live; tokens without coverage stay Pending |
| NEAR AI Cloud (TEE) | Player agent decisions and terminal intent parsing | P0 | Live; an autonomous agent played a battle on 2026-11-11 |
| Wallet connection (HOT connector) | User signing | P0 | In the web app |
| FastNEAR | NEAR RPC and indexed data | P1 | In use |
| SputnikDAO | Protocol authority and protocol-fee recipient ([authority map](sputnik-authority.md)); the winners' vote stays in the arena contract | P2 / DAO design P0 | Deployed as `valtrum-protocol.sputnikv2.testnet` |
| Bitte | Agent orchestration | P0 | Planned; not demonstrated |
| Trezu, OutLayer, Agent Market | Treasury UI, AI transaction policy, agent discovery | P2 | Evaluated only; not integrated |

## Evidence required before claiming an integration

Record the endpoint, account or contract, source commit, timestamp, request/response evidence and transaction links. Keep credentials out of records. Label fixtures as fixtures. An unsupported chain or a missing field holds an audit Pending; a canned response may test an adapter but cannot be presented as a live audit.

## Planned integration acceptance

- **Bitte:** demonstrate an API/OpenAPI agent request orchestrating a canonical arena preview and a user-authorized action, reconciled with the same action status used by MCP.
- **Candidate partners:** record benefit, testnet availability, permissions and integration cost before selection. Selecting DAO infrastructure does not settle membership, quorum, voting weight or fallback.
