# Battle rules

Status: **planned**. These rules implement the decisions in [product-spec.md](product-spec.md). They do not describe the current two-side contract.

## Fixed inputs and intervals

A battle has at least two distinct, audited token communities. All communities, backed deposits and creator participation are fixed before round 1. The creator selects one mode for the entire battle, including overtime. Every round lasts exactly **30 seconds**: record start `t0` and end `t1 = t0 + 30 seconds`. Price observations are points, **not TWAPs**.

A versioned observation policy must be committed before lock. It specifies chain/token identity, quote currency (USD), price/supply/volume sources, eligible pools, sampling cadence, boundary selection tolerance, freshness and finality. It must use a consistent interval for every candidate. These provider/cadence choices are OPEN; the policy cannot be invented after seeing the outcome. Scheduler delay never moves a recorded boundary.

Let `P_i(t)` be positive USD price per whole token, `C_i(t)` its positive circulating supply in whole-token units, and `M_i(t) = P_i(t) * C_i(t)` its market cap. Circulating supply is not total or fully diluted supply. Record the supply definition and source; a contract's total supply alone cannot stand in for it.

## Formulas

### Price % Gain

`G_i = 100 * (P_i(t1) - P_i(t0)) / P_i(t0)`.

The **highest** signed score wins. Example: A goes 100 → 95 (-5%); B goes 100 → 90 (-10%); A wins even though both fell.

### Market Cap % Growth

`H_i = 100 * (M_i(t1) - M_i(t0)) / M_i(t0)`.

The **highest** signed score wins. Supply must be observed at both endpoints. Example: A price 2 → 2.2 and circulating supply 1,000 → 900 gives market cap 2,000 → 1,980, or **-1%**. B price 1 → 1 and supply 2,000 → 2,100 gives **+5%**, so B wins.

### Volume-to-Market Cap Ratio

Let `V_i` be USD quote-volume of eligible, deduplicated trades during `[t0, t1)`. Include a trade at `t0`; exclude one at `t1` so an overtime boundary cannot double-count it.

`R_i = V_i / M_i(t0)`.

The **highest** ratio wins. It is dimensionless; a UI may display `100 * R_i` as a percentage, but must label that display. Do not use end market cap, 24-hour rolling volume, raw token quantity or an aggregate with duplicate pool trades. Example: A volume 300 / initial cap 1,000 = **0.30**; B volume 400 / initial cap 2,000 = **0.20**; A wins. A complete verified round with no trades has volume zero. No volume evidence is an invalid observation, not a zero.

### Lowest % Drawdown

For ordered price observations `p_0 ... p_n` over the round, including valid start and end points:

`peak_k = max(p_0, ..., p_k)`

`D_i = 100 * max_k((peak_k - p_k) / peak_k)`.

The **lowest maximum drawdown** wins. This is not simply the start-to-end loss. A path 100 → 120 → 90 → 110 has maximum drawdown **25%** (120 → 90). A path 100 → 95 → 105 → 100 has maximum drawdown **5%**, so the second community wins despite its smaller end gain. A complete nondecreasing path has drawdown **0%**. Two fully observed zero-drawdown candidates tie. Missing intermediate observations cannot be treated as a flat path.

This is maximum drawdown over the approved sampled observations, not a claim to know every continuous-time market tick. The approved sampling/coverage policy must be disclosed.

## Exact comparison and invalid data

Use checked wide integer/rational math with declared decimal scales; never binary floating point or rounded display percentages for winner selection. Compare rational scores by safe cross multiplication, retaining negative signs for gain and growth. Quantization of input data is part of the frozen policy. At the canonical input precision, equality means a tie; no undocumented epsilon or random tiebreaker.

Reject nonpositive price/start market cap, negative volume, absent or invalid circulating supply, duplicate/out-of-order records, wrong chain/token, stale or incomplete required coverage and conflicting observations. Validate only the fields needed by the selected mode plus the battle's audit policy. Missing evidence holds resolution pending; it must not produce a winner, zero score, default loss or an automatic refund. Recovery/emergency policy is OPEN.

## Overtime

1. Score only the current round's candidates.
2. For gain/growth/ratio choose all candidates at the maximum; for drawdown choose all at the minimum.
3. If exactly one remains, it is the final winner.
4. Otherwise record the tied leaders as the next candidate set. Begin a fresh 30-second round with fresh baselines, volume counters and drawdown peaks.
5. Repeat without a cap. Keep the original deposit snapshot and **all original vaults** locked, including communities already eliminated.

Example with three communities:

| Round | Candidates and Price % Gain | Result |
| --- | --- | --- |
| 1 | A +10%, B +10%, C +2% | Only A/B advance; C's assets stay locked |
| 2 | A -3%, B -3% from fresh starts | Another round; no fees or payout yet |
| 3 | A -4%, B -5% from fresh starts | A is final winner; both B and C are losing vaults |

No community can re-enter after elimination. New deposits and changes to mode or token set are refused through every overtime round. Gaps waiting for valid next-round observations are visible as pending; they do not reopen deposits. No cumulative score from an earlier round affects the next winner.

## Verification cases

Implementation acceptance must cover two and three communities, negative signed comparisons, supply changing against price, initial rather than final market cap in the ratio, exact boundary trade inclusion, complete zero-volume/zero-drawdown observations, drawdown's interim peak, exact rational ties, repeated overtime, eliminated vault locking, late scheduler calls and incomplete data. [OpenSpec scoring](openspec/changes/redesign-permissionless-robinhood-arena/specs/arena-scoring/spec.md) makes these behavioral requirements explicit.
