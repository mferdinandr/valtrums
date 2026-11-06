# Tasks

Check tasks only after implementation and verification. Arithmetic alone does not authenticate observations or resolve a live battle.

## Exact scoring

- [ ] Implement four exact signed rational formulas.
- [ ] Specify and enforce canonical price, supply and quote-volume scales in the frozen observation policy.
- [ ] Verify negative gains, exact ties, supply changes, initial market cap, zero volume, interim peaks and wide-integer boundaries.
- [ ] Reject nonpositive prices or supply, malformed values and arithmetic overflow without assigning a default score.

## Round evidence

- [ ] Define versioned source, quote, eligible pools, quantization, boundary tolerance, cadence, freshness and finality policy before lock.
- [ ] Bind each observation to battle, round, candidate asset, mode, source, policy, interval and evidence provenance.
- [ ] Record immutable 30-second start and end boundaries and prevent late scheduling from shifting them.
- [ ] Validate required endpoint price and circulating-supply evidence for the selected mode.
- [ ] Verify deduplicated eligible quote-volume over `[t0, t1)` and distinguish complete zero volume from missing evidence.
- [ ] Validate ordered drawdown samples and policy-required boundary and intermediate coverage.
- [ ] Hold the round Pending on stale, incomplete, conflicting, wrong-source or unauthenticated evidence.
- [ ] Test late, duplicate, out-of-order, overwritten and wrong-round observations and exact interval boundaries.

## Overtime and integration

- [ ] Compare exact scores with the correct highest/lowest direction and select all tied leaders.
- [ ] Open a fresh 30-second round for tied leaders only, resetting baselines, volume and drawdown peaks.
- [ ] Repeat overtime without a policy cap; prevent eliminated communities from re-entering.
- [ ] Keep the original snapshot and every vault locked, including eliminated communities, until a unique final winner.
- [ ] Integrate the verified final result with lifecycle without accepting a worker-supplied winner label alone.
- [ ] Test repeated ties, negative fresh-round scores, eliminated vault locking, duplicate resolution and missing observations.
