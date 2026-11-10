## Outcome

Tracking: #150. Live custody compatibility comes from #148; read/projection coordination with #143/#144. Provides signing/finality readiness to #151. Recorded runtime work can start before live custody release. Final acceptance: #80.

Complete runnable reservation-bound signature initiation and separately authorized finality confirmation, preserving the existing reconciler's restricted role.

## Scope

Canonical owner: `arena-chain-signatures` application runtime role follow-up. Inspect payout contract request/signature/status methods and `agent/src/payout-{wiring,reconciler}.ts`.

- Durable eligible-request discovery and signature initiation under relayer authority; reconcile current attempts before retry.
- Separate operator process for exact finalized receipt confirmation/revert/restoration. Existing reconciler deliberately holds no operator key and does not initiate signatures.
- Preserve backing/account/request/asset/destination/nonce/payload binding and replacement history. Timeout is not proof of no spend.
- Expose non-secret capability/status handoff for read API/portfolio. A signature or broadcast is not delivered funds.

## Acceptance

Verify interruption/restart, lost response, duplicate request, replacement, revert, used nonce, wrong receipt and exact final evidence without duplicate spend. Record real testnet proof separately from library fixtures before enabling live payout readiness. Missing spendable custody blocks live release even if workers run.

## Dependencies and delivery

Requires backing/payout contracts and custody compatibility evidence. Coordinate testnet owner; cross-service acceptance remains [#80](https://github.com/mferdinandr/valtrum/issues/80). No player spending authority, DAO release shortcut or operator credentials in read service/client/relayer.

Local snapshot 2026-11-10: `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree. Follow-up OpenSpec spec/tasks and crosscheck are uncommitted; publish/reconcile before apply elsewhere. No deployment, funds, database migrations or Playwright authorized by issue creation.
