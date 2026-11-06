/** Exact scoring for the planned multi-community arena; no price fetching or authority is implied. */
export type ScoringMode =
  | "PricePercentGain"
  | "MarketCapPercentGrowth"
  | "VolumeToInitialMarketCap"
  | "LowestMaximumDrawdown";

export interface Rational { readonly numerator: bigint; readonly denominator: bigint }
export const ROUND_DURATION_NS = 30_000_000_000n;

function requireCondition(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function rational(numerator: bigint, denominator = 1n): Rational {
  requireCondition(typeof numerator === "bigint" && typeof denominator === "bigint" && denominator > 0n,
    "rational requires bigint numerator and positive bigint denominator");
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

function validRational(value: Rational): void {
  requireCondition(value != null && typeof value.numerator === "bigint" &&
    typeof value.denominator === "bigint" && value.denominator > 0n, "invalid rational");
}
function positive(value: Rational): void {
  validRational(value);
  requireCondition(value.numerator > 0n, "price and circulating supply must be positive");
}
export function compareRationals(left: Rational, right: Rational): -1 | 0 | 1 {
  validRational(left); validRational(right);
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function multiply(left: Rational, right: Rational): Rational {
  validRational(left); validRational(right);
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}
function add(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

/** Returns the signed fractional gain; multiply by 100 only when formatting a percentage. */
export function priceGain(start: Rational, end: Rational): Rational {
  positive(start); positive(end);
  return rational(end.numerator * start.denominator - start.numerator * end.denominator,
    end.denominator * start.numerator);
}
export function marketCapGrowth(
  priceStart: Rational, supplyStart: Rational, priceEnd: Rational, supplyEnd: Rational,
): Rational {
  positive(priceStart); positive(priceEnd); positive(supplyStart); positive(supplyEnd);
  return priceGain(multiply(priceStart, supplyStart), multiply(priceEnd, supplyEnd));
}
export function volumeToInitialMarketCap(volumeUsd: Rational, priceStart: Rational, supplyStart: Rational): Rational {
  validRational(volumeUsd); positive(priceStart); positive(supplyStart);
  requireCondition(volumeUsd.numerator >= 0n, "volume cannot be negative");
  const cap = multiply(priceStart, supplyStart);
  return rational(volumeUsd.numerator * cap.denominator, volumeUsd.denominator * cap.numerator);
}
export function maximumDrawdown(prices: readonly Rational[]): Rational {
  requireCondition(prices.length >= 2, "drawdown requires at least start and end prices");
  let peak = prices[0]!;
  positive(peak);
  let worst = rational(0n);
  for (const price of prices) {
    positive(price);
    if (compareRationals(price, peak) > 0) peak = price;
    const gain = priceGain(peak, price);
    const drop = rational(-gain.numerator, gain.denominator);
    if (compareRationals(drop, worst) > 0) worst = drop;
  }
  return worst;
}

export interface AssetIdentity {
  readonly chainId: string;
  readonly tokenAddress: string;
}
export interface Candidate {
  readonly communityId: string;
  readonly asset: AssetIdentity;
}
export interface ScoringPolicy {
  /** Hash/version pinned by the arena before lock; source authentication is the caller's responsibility. */
  readonly id: string;
  readonly quoteCurrency: "USD";
  readonly priceSourceId: string;
  readonly supplySourceId: string;
  readonly volumeSourceId: string;
  readonly boundaryToleranceNs: bigint;
  readonly maxPriceGapNs: bigint;
  readonly maxPublicationLagNs: bigint;
  readonly eligiblePoolsByCommunity: Readonly<Record<string, readonly string[]>>;
}
export interface ScoringRound {
  readonly battleId: string;
  readonly index: bigint;
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly mode: ScoringMode;
  readonly policyId: string;
  /** Original community snapshot never changes during overtime. */
  readonly originalCommunities: readonly Candidate[];
  readonly candidates: readonly string[];
}
export interface ObservationProvenance {
  readonly battleId: string;
  readonly roundIndex: bigint;
  readonly policyId: string;
  readonly asset: AssetIdentity;
  readonly sourceId: string;
  readonly blockHash: string;
  readonly observedAtNs: bigint;
  readonly publishedAtNs: bigint;
  readonly finalized: boolean;
  readonly fixture: boolean;
}
export interface ValueObservation {
  readonly provenance: ObservationProvenance;
  readonly value: Rational;
}
export interface TradeObservation {
  readonly provenance: ObservationProvenance;
  readonly txHash: string;
  readonly logIndex: bigint;
  readonly poolId: string;
  readonly quoteVolumeUsd: Rational;
}
export interface VolumeEvidence {
  /** The source must attest complete interval coverage, not merely a list of trades it happened to return. */
  readonly provenance: ObservationProvenance;
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly complete: boolean;
  readonly eligiblePools: readonly string[];
  readonly trades: readonly TradeObservation[];
}
export interface CandidateEvidence {
  readonly communityId: string;
  readonly prices?: readonly ValueObservation[];
  readonly circulatingSupplyStart?: ValueObservation;
  readonly circulatingSupplyEnd?: ValueObservation;
  readonly volume?: VolumeEvidence;
}
export interface RoundScoringInput {
  readonly round: ScoringRound;
  readonly policy: ScoringPolicy;
  readonly evidence: readonly CandidateEvidence[];
  readonly nowNs: bigint;
}
export interface ScoringIssue { readonly communityId?: string; readonly reason: string }
export interface CandidateScore {
  readonly communityId: string;
  readonly score: Rational;
  /** Provider evidence is not a cryptographic assertion; the authorized oracle must authenticate it. */
  readonly evidenceKind: "fixture" | "provider";
}
export type RoundResolution =
  | { readonly status: "Pending"; readonly issues: readonly ScoringIssue[] }
  | { readonly status: "Winner"; readonly winnerId: string; readonly scores: readonly CandidateScore[] }
  | { readonly status: "Overtime"; readonly scores: readonly CandidateScore[]; readonly nextRound: ScoringRound };

function sameAsset(left: AssetIdentity, right: AssetIdentity): boolean {
  return left.chainId === right.chainId && left.tokenAddress.toLowerCase() === right.tokenAddress.toLowerCase();
}
function validAsset(asset: AssetIdentity): void {
  requireCondition(/^\d+$/.test(asset.chainId) && BigInt(asset.chainId) > 0n &&
    /^0x[0-9a-fA-F]{40}$/.test(asset.tokenAddress), "invalid source chain/token identity");
}
function validTimestamp(value: bigint): void {
  requireCondition(typeof value === "bigint" && value >= 0n, "invalid timestamp");
}
function absolute(value: bigint): bigint { return value < 0n ? -value : value; }
function validateContext(input: RoundScoringInput): void {
  const { round, policy, nowNs } = input;
  validTimestamp(nowNs); validTimestamp(round.startNs); validTimestamp(round.endNs);
  requireCondition(typeof round.index === "bigint" && round.index >= 0n, "invalid round index");
  requireCondition(round.endNs - round.startNs === ROUND_DURATION_NS, "round must be exactly 30 seconds");
  requireCondition(nowNs >= round.endNs, "round has not ended");
  requireCondition(round.battleId.length > 0 && round.policyId === policy.id && policy.id.length > 0,
    "round policy identity mismatch");
  requireCondition(policy.quoteCurrency === "USD", "quote currency must be USD");
  for (const duration of [policy.boundaryToleranceNs, policy.maxPriceGapNs, policy.maxPublicationLagNs])
    validTimestamp(duration);
  requireCondition(policy.maxPriceGapNs > 0n && policy.maxPriceGapNs <= ROUND_DURATION_NS &&
    policy.boundaryToleranceNs < ROUND_DURATION_NS / 2n, "invalid observation coverage policy");
  requireCondition(["PricePercentGain", "MarketCapPercentGrowth", "VolumeToInitialMarketCap", "LowestMaximumDrawdown"]
    .includes(round.mode), "unknown scoring mode");
  const communities = round.originalCommunities.map((candidate) => candidate.communityId);
  requireCondition(communities.length >= 2 && new Set(communities).size === communities.length &&
    communities.every((id) => id.length > 0), "invalid original community snapshot");
  const identities = new Set<string>();
  for (const candidate of round.originalCommunities) {
    validAsset(candidate.asset);
    const key = `${candidate.asset.chainId}:${candidate.asset.tokenAddress.toLowerCase()}`;
    requireCondition(!identities.has(key), "duplicate community source asset"); identities.add(key);
  }
  requireCondition(round.candidates.length >= 2 && new Set(round.candidates).size === round.candidates.length &&
    round.candidates.every((id) => communities.includes(id)), "invalid round candidates");
  requireCondition(new Set(input.evidence.map((e) => e.communityId)).size === input.evidence.length,
    "duplicate candidate evidence");
  requireCondition(input.evidence.every((e) => round.candidates.includes(e.communityId)), "evidence for eliminated candidate");
}

function scoreCandidate(input: RoundScoringInput, candidate: Candidate, evidence: CandidateEvidence): CandidateScore {
  const { round, policy, nowNs } = input;
  let fixture = false;
  function provenance(p: ObservationProvenance, source: string): void {
    requireCondition(source.length > 0 && p.battleId === round.battleId && p.roundIndex === round.index &&
      p.policyId === policy.id && sameAsset(p.asset, candidate.asset) && p.sourceId === source,
    "observation battle/round/policy/source/asset mismatch");
    validTimestamp(p.observedAtNs); validTimestamp(p.publishedAtNs);
    requireCondition(p.finalized === true && typeof p.fixture === "boolean" && p.blockHash.length > 0,
      "observation requires finalized block provenance and explicit fixture label");
    requireCondition(p.publishedAtNs >= p.observedAtNs && p.publishedAtNs <= nowNs &&
      p.publishedAtNs - p.observedAtNs <= policy.maxPublicationLagNs, "stale or future observation publication");
    fixture ||= p.fixture;
  }
  function point(observation: ValueObservation | undefined, source: string, boundary: bigint): Rational {
    requireCondition(observation !== undefined, "missing required endpoint observation");
    provenance(observation.provenance, source); positive(observation.value);
    requireCondition(absolute(observation.provenance.observedAtNs - boundary) <= policy.boundaryToleranceNs,
      "observation misses recorded boundary");
    return observation.value;
  }
  const prices = evidence.prices;
  requireCondition(prices !== undefined && prices.length > 0, "missing required price evidence");
  // Unused end/intermediate data cannot change a mode that only consumes an initial point or endpoints.
  const requiredPrices = round.mode === "VolumeToInitialMarketCap" ? [prices[0]!] :
    round.mode === "LowestMaximumDrawdown" ? prices :
      prices.length >= 2 ? [prices[0]!, prices[prices.length - 1]!] : [prices[0]!];
  let previous: bigint | undefined;
  for (const price of requiredPrices) {
    provenance(price.provenance, policy.priceSourceId); positive(price.value);
    const time = price.provenance.observedAtNs;
    requireCondition(time >= round.startNs - policy.boundaryToleranceNs &&
      time <= round.endNs + policy.boundaryToleranceNs, "price outside recorded interval");
    requireCondition(previous === undefined || time > previous, "duplicate or out-of-order price observation");
    if (round.mode === "LowestMaximumDrawdown" && previous !== undefined)
      requireCondition(time - previous <= policy.maxPriceGapNs, "incomplete drawdown sample coverage");
    previous = time;
  }
  const start = point(prices[0], policy.priceSourceId, round.startNs);
  let score: Rational;
  switch (round.mode) {
    case "PricePercentGain":
      requireCondition(prices.length >= 2, "missing end price");
      score = priceGain(start, point(prices[prices.length - 1], policy.priceSourceId, round.endNs));
      break;
    case "MarketCapPercentGrowth":
      requireCondition(prices.length >= 2, "missing end price");
      score = marketCapGrowth(start, point(evidence.circulatingSupplyStart, policy.supplySourceId, round.startNs),
        point(prices[prices.length - 1], policy.priceSourceId, round.endNs),
        point(evidence.circulatingSupplyEnd, policy.supplySourceId, round.endNs));
      break;
    case "LowestMaximumDrawdown":
      requireCondition(prices.length >= 2, "missing end price");
      point(prices[prices.length - 1], policy.priceSourceId, round.endNs);
      score = maximumDrawdown(prices.map((price) => price.value));
      break;
    case "VolumeToInitialMarketCap": {
      const supply = point(evidence.circulatingSupplyStart, policy.supplySourceId, round.startNs);
      const volume = evidence.volume;
      requireCondition(volume !== undefined && volume.complete === true, "missing complete volume coverage");
      provenance(volume.provenance, policy.volumeSourceId);
      requireCondition(volume.startNs === round.startNs && volume.endNs === round.endNs &&
        volume.provenance.observedAtNs === round.endNs, "volume coverage interval mismatch");
      const approvedPools = policy.eligiblePoolsByCommunity[candidate.communityId];
      requireCondition(approvedPools !== undefined && approvedPools.length > 0 &&
        new Set(approvedPools).size === approvedPools.length && approvedPools.every((pool) => pool.length > 0) &&
        volume.eligiblePools.length === approvedPools.length && new Set(volume.eligiblePools).size === volume.eligiblePools.length &&
        volume.eligiblePools.every((pool) => approvedPools.includes(pool)), "eligible pools differ from frozen policy");
      let total = rational(0n);
      const seen = new Map<string, TradeObservation>();
      for (const trade of volume.trades) {
        provenance(trade.provenance, policy.volumeSourceId); validRational(trade.quoteVolumeUsd);
        requireCondition(trade.quoteVolumeUsd.numerator >= 0n && /^0x[0-9a-fA-F]{64}$/.test(trade.txHash) &&
          typeof trade.logIndex === "bigint" && trade.logIndex >= 0n && volume.eligiblePools.includes(trade.poolId),
        "invalid trade volume/identity/pool");
        const key = `${trade.provenance.asset.chainId}:${trade.txHash.toLowerCase()}:${trade.logIndex}`;
        const other = seen.get(key);
        if (other !== undefined) {
          requireCondition(other.provenance.observedAtNs === trade.provenance.observedAtNs &&
            other.provenance.blockHash === trade.provenance.blockHash && other.poolId === trade.poolId &&
            compareRationals(other.quoteVolumeUsd, trade.quoteVolumeUsd) === 0, "conflicting duplicate trade");
          continue;
        }
        seen.set(key, trade);
        if (trade.provenance.observedAtNs >= round.startNs && trade.provenance.observedAtNs < round.endNs)
          total = add(total, trade.quoteVolumeUsd);
      }
      score = volumeToInitialMarketCap(total, start, supply);
      break;
    }
  }
  return { communityId: candidate.communityId, score, evidenceKind: fixture ? "fixture" : "provider" };
}

/** Does not move funds, open deposits, cap overtime or authenticate an oracle's signature. */
export function evaluateRound(input: RoundScoringInput): RoundResolution {
  try { validateContext(input); }
  catch (error) { return { status: "Pending", issues: [{ reason: String(error) }] }; }
  const scores: CandidateScore[] = [];
  const issues: ScoringIssue[] = [];
  for (const communityId of input.round.candidates) {
    try {
      const evidence = input.evidence.find((item) => item.communityId === communityId);
      requireCondition(evidence !== undefined, "missing candidate evidence");
      const candidate = input.round.originalCommunities.find((item) => item.communityId === communityId)!;
      scores.push(scoreCandidate(input, candidate, evidence));
    } catch (error) { issues.push({ communityId, reason: String(error) }); }
  }
  if (issues.length) return { status: "Pending", issues };
  const lowerWins = input.round.mode === "LowestMaximumDrawdown";
  let best = scores[0]!.score;
  for (const item of scores) {
    const comparison = compareRationals(item.score, best);
    if (lowerWins ? comparison < 0 : comparison > 0) best = item.score;
  }
  const leaders = scores.filter((item) => compareRationals(item.score, best) === 0).map((item) => item.communityId);
  if (leaders.length === 1) return { status: "Winner", winnerId: leaders[0]!, scores };
  return {
    status: "Overtime", scores,
    nextRound: {
      ...input.round, index: input.round.index + 1n, candidates: leaders,
      startNs: input.round.endNs, endNs: input.round.endNs + ROUND_DURATION_NS,
    },
  };
}
