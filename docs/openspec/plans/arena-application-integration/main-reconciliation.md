# Main reconciliation for PR 152

PR 152 merges main commit `16a8062dfffac65e2d29be824a51859cc13dea13`.
This addendum takes precedence over absence/OPEN claims in the original
`4881fd7` plus working-tree inspection. Preserve that inventory as historical
evidence, not a current post-merge implementation checklist.

## Existing implementation to reuse

- `agent/src/main.ts` now injects `JsonFileReportArchive` when archive configuration
  is enabled. Audit issue #145 is a verification/provenance/consumer handoff gap
  assessment, not an instruction to duplicate the sink. Audit retention remains
  a separate documented decision; archive existence does not imply live coverage.
- `agent/src/mcp/{cli,http,server,search,account-state}.ts` already provides a runnable
  MCP/read service, backend search, account states and action/session boundaries.
  Web `app/api/arena/{tools,session,actions}` and `lib/arena-read/*` already supply
  gateway/client patterns. Read API #143 must adapt/extend these for versioned
  namespaces, capabilities and missing endpoints instead of inventing a parallel
  service. Preserve existing session/access controls when consuming private reads.
- `contracts/player-policy` and MCP canonical action/proposal services now exist.
  Review their supported paths, grant enforcement and fixture/live limitations;
  the historical assertion that no MCP/player implementation exists is superseded.
- Main wires a recorded-file indexer into the agent behind `INDEXER_ENABLED` and
  extends retention/event handling. #144 must first inventory existing reducers;
  implement only missing projections/live sources rather than assuming the old
  three-event allowlist is still the entire coverage.
- `docs/dao-governance.md`, decision log D22/D24/D28 and arena DAO/escrow APIs define
  participant-weighted burn/return and distinct protocol Sputnik authority. DAO
  design is no longer generically OPEN. Honor the current owning specs; do not
  invent an owner-only principal release or remove existing governance capability.
  The four new integration changes do not add a new DAO implementation workstream.
- Main adds the explicitly testnet-only `intents-fixture` service and route support.
  Preserve its labels and refusal outside testnet; it is not real Intents evidence.

## Still separate gates

The current round view still lacks full exact-score/window history, and new
versioned endpoints remain proposed. A recorded indexer is not a live BlockSource.
The deposit-only EVM custody warning and independently authorized oracle/signing/
confirmation runtime gates still require source/deployment verification. Reuse
current main's provider/evidence documents before repeating qualification work.

## Apply policy after merge

Before applying a child task, compare it with current main's implementation and
owner task status. Verify existing code first and refine remaining task scope;
do not reimplement a historical gap merely because a snapshot task is unchecked.
In particular, #143/#144/#145/#151 need this reconciliation at implementation
start. Historical GitHub issue bodies record their original source snapshot;
this published addendum is the handoff for the newer merged source.

Both sides of the testnet spec conflict are retained: application worker/custody
gates and the labelled Intents fixture requirements. pnpm regenerates the merged
lockfile from both manifests, retaining MCP and 3D dependencies together. No
application behavior, contract economics or production deployment is manually
changed by conflict resolution.
