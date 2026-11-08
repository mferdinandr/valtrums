# Audit report archive: review corrections and operating limits

This note covers the independently delivered report archive/API from issue #60. Reports remain historical observations, not current lock approval or proof of foreign-chain custody. All automated data remains synthetic unless separately documented as live evidence.

## Observation identity and capacity

The archive deduplicates identical decision content for the same evidence, attribution and provenance. It excludes report wall-clock timestamps from that decision fingerprint and keeps the first stored timestamps. A time-only re-evaluation of fixed evidence therefore does not append another record. A changed result or reason is preserved separately.

Fresh evidence is different: `decision.ts` commits the provider query timestamp and LP observation metadata into `evidenceHash`. The real GoPlus client timestamps each request. New provider evidence produces a new observation even if the tax/risk findings have not changed. This is intentional evidence preservation, not a claim that all pending/rejected refreshes collapse into one record. Regression tests now distinguish fixed-evidence retries from fresh timestamped provider queries.

The archive has a 64 KiB report size limit and a global 100000-observation capacity. At one new observation per 30 seconds, one continuously refreshed community can consume that capacity in about 35 days; several communities consume it faster. Every write reloads and validates the full snapshot, so file size also affects latency before the count limit is reached. There is no automatic prune, provider backoff change, verdict-only deduplication, or evidence suppression in this feature. Capacity errors are surfaced by the lifecycle sink; they do not change audit verdicts, on-chain submissions or the provider refresh cadence. Retention, segmentation or capacity increases require separately reviewed work, without silently discarding committed evidence.

## Writer lock recovery

Writers use exclusive creation of `<archive path>.lock` and bounded retry. An old lock is never removed automatically: elapsed time cannot prove that its writer has exited. This prevents a paused/slow writer from racing another writer's snapshot or temporary file.

If a writer crashes and leaves its lock:

1. Stop **every** process that can write this archive, including supervisors that restart them. Do not remove a lock while a writer can resume.
2. Preserve copies of the committed archive, lock and any `<archive path>.tmp` for diagnosis. Do not promote a temporary file just because it is newer.
3. Validate the committed archive with the read-only `list` command documented below. If it is corrupt, preserve it and restore a separately verified backup; do not reset to empty history.
4. Once all writers are confirmed stopped and the committed state is understood, remove only the abandoned `.lock` (and discard an uncommitted `.tmp` if appropriate). Restart a single writer. The next write reloads the committed archive before appending.

Normal lock timeouts leave both the existing lock and committed archive unchanged. The read-only service needs no writer lock and does not modify or recover state automatically. The implementation uses temp-file/rename atomic visibility; it does not claim fsync-based durability against power loss or distributed locking across hosts.

## Text output and local verification

HTTP `/audit-reports/:evidenceHash/text` and CLI `get --text` use the same `ObservationView` as JSON. A shared wrapper emits provenance (including `fixture`), observation ID, arena/custody domain, battle/community attribution, archive timestamp/sequence, historical result, read-time freshness and `currentApproval: notEstablished`, followed by limitations and the existing `formatAuditReport` content. Reference-token wording remains unchanged. An expired pass still displays its historical pass together with `Freshness: expired`; a synthetic pass is explicitly marked `Provenance: fixture`.

After building the agent, these existing commands exercise a throwaway archive (choose a temporary path; do not seed a real archive):

```bash
pnpm -F @valtrum/agent build
pnpm -F @valtrum/agent audit:report:seed-demo --dir /path/to/throwaway-audit-reports
pnpm -F @valtrum/agent audit:report:list --dir /path/to/throwaway-audit-reports
pnpm -F @valtrum/agent audit:report:get <evidenceHash> --dir /path/to/throwaway-audit-reports --text
```

Targeted regressions are in `agent/test/audit/report-archive.test.ts`, `report-sink.test.ts`, `report-server.test.ts`, and `report-cli.test.ts`. They cover an old held lock and timeout/recovery, fresh-evidence history versus time-only deduplication, and HTTP/CLI fixture/expired-pass text. Run the full agent tests and typecheck/build plus strict OpenSpec validation as required by the issue. Actual validation results belong in the PR; this note does not imply an unrun test passed.
