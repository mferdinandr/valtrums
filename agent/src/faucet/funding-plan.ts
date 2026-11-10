/**
 * The plan for funding the faucet account with backed representation. It only builds text: no network call, no key,
 * no transaction. Every step that changes state names who signs it, the chain, and the exact command to review, and
 * the operator (the owner) approves and runs each one. Keys are always referenced by environment variable name.
 *
 * Why this path: a representation can only be minted from finalized custody (`claim_representation`), so the faucet
 * account is funded by a real deposit on Robinhood testnet that names the faucet account as beneficiary.
 */
export interface Backing {
  symbol: string;
  /** NEAR account of the representation (the backing contract). */
  account: string;
  /** The EVM mock token it is backed by. */
  token: string;
}

export interface FundingFacts {
  chainId: string;
  forwarder: string;
  holder: string;
  retired: string[];
  mappingVersion: string;
  custodyDomain: string;
  registry: string;
  verifier: string;
  backings: Backing[];
}

export interface PlanOptions {
  faucet: string;
  /** An existing OPEN lifecycle battle that includes the token's backing; claim_receipt fails closed without one. */
  battleId: string;
  /** The EVM address that deposits (and signs approve and deposit). */
  depositor: string;
  /** Where a late deposit would be returned; defaults to the depositor. */
  refund?: string;
  /** Whole tokens of stock per symbol (the tokens have 18 decimals). A claim is 100 by default, so 1,000,000 serves 10,000 claims. */
  tokens: number;
  symbols?: string[];
}

export interface Step {
  id: string;
  title: string;
  chain: "evm" | "near" | "local";
  signer: string;
  /** True when the step sends a transaction. */
  mutating: boolean;
  command: string;
  note?: string;
}

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const RPC = '--rpc-url "$ROBINHOOD_RPC_URL"';

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Reads the recorded deploy facts. Throws a specific message when a file does not have what the plan needs. */
export function loadFundingFacts(readJson: (name: string) => unknown): FundingFacts {
  const fwd = asRecord(readJson("2026-11-10-forwarder-deploy.json"));
  const wiring = asRecord(readJson("2026-11-09-near-testnet-wiring.json"));
  const forwarder = asRecord(fwd.forwarder);
  const retired = asRecord(fwd.retired);
  const init = asRecord(asRecord(wiring.backings).init_common);
  const verifier = asRecord(wiring.verifier);
  const deployments = asRecord(wiring.backings).deployments;
  if (!EVM_ADDR.test(String(forwarder.address)) || !EVM_ADDR.test(String(forwarder.holder))) throw new Error("the forwarder deploy evidence has no forwarder or holder address");
  if (!Array.isArray(deployments) || deployments.length === 0) throw new Error("the wiring evidence lists no backings");
  const backings = deployments.map((d) => {
    const x = asRecord(d);
    return { symbol: String(x.symbol), account: String(x.account), token: String(x.token).toLowerCase() };
  });
  for (const b of backings) if (!ACCOUNT.test(b.account) || !EVM_ADDR.test(b.token)) throw new Error(`the wiring evidence has a malformed backing for ${b.symbol}`);
  const domain = String(init.custody_domain ?? "").split(/\s+/)[0] ?? "";
  if (!EVM_ADDR.test(domain)) throw new Error("the wiring evidence has no custody domain");
  const registry = String(init.registry ?? "");
  const verifierAccount = String(verifier.account ?? "");
  if (!ACCOUNT.test(registry) || !ACCOUNT.test(verifierAccount)) throw new Error("the wiring evidence has no registry or verifier account");
  return {
    chainId: String(init.chain_id ?? "46630"),
    forwarder: String(forwarder.address),
    holder: String(forwarder.holder),
    retired: [String(retired.address ?? domain)].filter((a) => EVM_ADDR.test(a)),
    mappingVersion: String(init.mapping_version ?? ""),
    custodyDomain: domain.toLowerCase(),
    registry,
    verifier: verifierAccount,
    backings,
  };
}

const units = (tokens: number): string => (BigInt(tokens) * 10n ** 18n).toString();

export function buildPlan(facts: FundingFacts, o: PlanOptions): Step[] {
  const problems: string[] = [];
  if (!ACCOUNT.test(o.faucet)) problems.push("the faucet account must be a NEAR account id");
  if (!/^[1-9][0-9]{0,19}$/.test(o.battleId)) problems.push("the battle id must be a positive integer");
  if (!EVM_ADDR.test(o.depositor)) problems.push("the depositor must be a 20-byte EVM address");
  if (o.refund !== undefined && !EVM_ADDR.test(o.refund)) problems.push("the refund address must be a 20-byte EVM address");
  if (!Number.isInteger(o.tokens) || o.tokens < 1 || o.tokens > 100_000_000) problems.push("tokens must be a whole number from 1 to 100000000");
  if (!/^[1-9][0-9]{0,19}$/.test(facts.mappingVersion)) problems.push("the recorded mapping version is missing");
  const wanted = (o.symbols?.length ? o.symbols : facts.backings.map((b) => b.symbol)).map((s) => s.toUpperCase());
  const chosen = wanted.map((s) => facts.backings.find((b) => b.symbol.toUpperCase() === s) ?? (problems.push(`unknown token ${s}`), null)).filter((b): b is Backing => b !== null);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const refund = o.refund ?? o.depositor;
  const amount = units(o.tokens);
  const steps: Step[] = [];
  const add = (s: Step) => steps.push(s);

  add({
    id: "prereq-battle", title: "Check that the battle exists and is open", chain: "near", signer: "none (read-only)", mutating: false,
    command: `near contract call-function as-read-only arena.valtrum-owner-b694.testnet get_lifecycle_battle_v1 json-args '{"battle_id":"${o.battleId}"}' network-config testnet now`,
    note: "claim_receipt fails closed unless this battle exists. It must be open (not locked) and include each backing below, or the deposit is recorded as a late deposit instead of ordinary custody. Create one in the app first if none exists.",
  });
  add({
    id: "prereq-faucet-account", title: "Create the faucet account (not the owner account) and fund it with testnet NEAR", chain: "near", signer: "the testnet faucet service", mutating: true,
    command: `near account create-account sponsor-by-faucet-service ${o.faucet} autogenerate-new-keypair save-to-keychain network-config testnet create`,
    note: "Skip if the account exists. Keep this key separate from the owner key. It needs a few NEAR for storage deposits.",
  });
  add({
    id: "prereq-rpc", title: "Reach the official Robinhood RPC", chain: "local", signer: "none", mutating: false,
    command: 'export ROBINHOOD_RPC_URL="https://rpc.testnet.chain.robinhood.com"',
    note: "Some ISP DNS resolvers hijack this host. If reads fail, use a resolver such as 1.1.1.1 or Cloudflare WARP, or a local DNS-over-HTTPS relay. Do not switch to an unverified RPC without recording it.",
  });

  for (const b of chosen) {
    const t = b.symbol.toLowerCase();
    add({
      id: `${t}-mint`, title: `${b.symbol}: mint ${o.tokens} mock tokens to the depositor`, chain: "evm", signer: "the token owner (deployer): $DEPLOYER_PRIVATE_KEY", mutating: true,
      command: `cast send ${b.token} "mint(address,uint256)" ${o.depositor} ${amount} ${RPC} --private-key "$DEPLOYER_PRIVATE_KEY"`,
      note: "mint is owner-only on the mock token. Costs a few thousand ETH-testnet wei.",
    });
    add({
      id: `${t}-approve`, title: `${b.symbol}: approve the forwarder`, chain: "evm", signer: "the depositor: $DEPOSITOR_PRIVATE_KEY", mutating: true,
      command: `cast send ${b.token} "approve(address,uint256)" ${facts.forwarder} ${amount} ${RPC} --private-key "$DEPOSITOR_PRIVATE_KEY"`,
    });
    add({
      id: `${t}-deposit`, title: `${b.symbol}: deposit through the forwarder, naming the faucet account as beneficiary`, chain: "evm", signer: "the depositor: $DEPOSITOR_PRIVATE_KEY", mutating: true,
      command: `cast send ${facts.forwarder} "deposit(address,uint64,uint64,address,string,uint256)" ${b.token} ${o.battleId} ${facts.mappingVersion} ${refund} ${o.faucet} ${amount} ${RPC} --private-key "$DEPOSITOR_PRIVATE_KEY"`,
      note: "The tokens go straight to the holder; the forwarder keeps nothing. Save the transaction hash printed here as <TX_HASH>. mappingVersion must equal the backing's immutable mapping version.",
    });
    add({
      id: `${t}-logindex`, title: `${b.symbol}: find the log index of the Deposited event`, chain: "evm", signer: "none (read-only)", mutating: false,
      command: `cast receipt <TX_HASH> --json ${RPC} | jq '.logs[] | select(.address|ascii_downcase=="${facts.forwarder.toLowerCase()}") | .logIndex'`,
      note: "The value is the <LOG_INDEX> used below (hex from cast; convert to decimal).",
    });
    add({
      id: `${t}-finality`, title: `${b.symbol}: wait until the receipt block is finalized (about an hour in the recorded run)`, chain: "evm", signer: "none (read-only)", mutating: false,
      command: `cast receipt <TX_HASH> blockNumber ${RPC}  &&  cast block finalized --field number ${RPC}`,
      note: "Continue only when the finalized number is at least the receipt block number.",
    });
    add({
      id: `${t}-verify`, title: `${b.symbol}: verify the finalized deposit with the custody verifier`, chain: "local", signer: "none (read-only)", mutating: false,
      command: `node dist/custody-verify-cli.js --rpc "$ROBINHOOD_RPC_URL" --tx <TX_HASH> --log-index <LOG_INDEX> --token ${b.token} --custody ${facts.forwarder} --holder ${facts.holder} --payout-sender ${facts.holder} --custody-domain ${facts.custodyDomain} --retired ${facts.retired.join(",")} --mapping-version ${facts.mappingVersion} --battle ${o.battleId} --representation ${b.account} > verify-${t}.json`,
      note: "Run from the agent folder after pnpm build. Add --state-rpc <dRPC url> if the official RPC cannot serve state. Stop if the verdict is not verified.",
    });
    add({
      id: `${t}-attest`, title: `${b.symbol}: the verifier attests the claim to the receipt registry`, chain: "near", signer: `the verifier account ${facts.verifier}`, mutating: true,
      command: `pnpm -C agent faucet:plan attest --file verify-${t}.json   # prints the exact near command with the attest arguments`,
      note: "Generates, but does not send, the registry attest call (1 yoctoNEAR) from the verified attestation. Review the arguments before signing.",
    });
    add({
      id: `${t}-register`, title: `${b.symbol}: register the faucet account for storage on the representation`, chain: "near", signer: `the faucet account ${o.faucet}`, mutating: true,
      command: `near account manage-storage-deposit ${b.account} deposit ${o.faucet} '0.01 NEAR' sign-as ${o.faucet} network-config testnet sign-with-keychain send`,
      note: "claim_representation requires the beneficiary to be registered already.",
    });
    add({
      id: `${t}-claim-receipt`, title: `${b.symbol}: claim the attested receipt on the backing`, chain: "near", signer: `any account, here ${o.faucet}`, mutating: true,
      command: `near contract call-function as-transaction ${b.account} claim_receipt json-args '{"transaction_hash":"<TX_HASH>","log_index":<LOG_INDEX>}' prepaid-gas '100 Tgas' attached-deposit '0.02 NEAR' sign-as ${o.faucet} network-config testnet sign-with-keychain send`,
      note: "Storage deposit is partly refunded. Use the same <TX_HASH> format as the verification output.",
    });
    add({
      id: `${t}-claim-representation`, title: `${b.symbol}: mint the representation to the faucet account`, chain: "near", signer: `the faucet account ${o.faucet}`, mutating: true,
      command: `near contract call-function as-transaction ${b.account} claim_representation json-args '{"beneficiary":"${o.faucet}","amount":"${amount}"}' prepaid-gas '50 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${o.faucet} network-config testnet sign-with-keychain send`,
      note: "Mints exactly what the finalized custody backs. This is the first live run of this path on testnet.",
    });
    add({
      id: `${t}-check`, title: `${b.symbol}: check the faucet balance`, chain: "near", signer: "none (read-only)", mutating: false,
      command: `near tokens ${o.faucet} view-ft-balance ${b.account} network-config testnet now`,
    });
  }
  add({
    id: "go-live", title: "Start the faucet live", chain: "local", signer: "none", mutating: false,
    command: `FAUCET_ACCOUNT_ID=${o.faucet} FAUCET_LIVE=1 FAUCET_PRIVATE_KEY=<the faucet key, from a secret store> pnpm -C agent faucet:serve`,
    note: "Only after every balance check above shows the expected amount. Do not put the key in a file in the repository.",
  });
  return steps;
}

// ── The attest call ────────────────────────────────────────────────────────────────────────────────────

const hexBytes = (value: unknown, length: number, what: string): number[] => {
  const hex = String(value ?? "").replace(/^0x/i, "");
  if (!new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex)) throw new Error(`${what} must be ${length} bytes of hex`);
  return Array.from({ length }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
};
const dec = (value: unknown, what: string): string => {
  const s = String(value ?? "");
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`${what} must be a decimal integer`);
  return s;
};

/** The arguments of `receipt-registry.attest` from the verified attestation in the verifier's JSON output. */
export function attestArgsFromVerifyOutput(output: unknown): { key: Record<string, unknown>; claim: Record<string, unknown> } {
  const timeline = asRecord(output).timeline;
  if (!Array.isArray(timeline)) throw new Error("the file has no timeline");
  const last = asRecord(timeline[timeline.length - 1]);
  if (last.verdict !== "verified") throw new Error(`the last verdict is ${String(last.verdict)}, not verified; do not attest`);
  const a = asRecord(last.attestation);
  return {
    key: { chain_id: dec(a.chainId, "chainId"), transaction_hash: hexBytes(a.transactionHash, 32, "transactionHash"), log_index: Number(dec(a.logIndex, "logIndex")) },
    claim: {
      representation: String(a.representation),
      token_address: String(a.token).toLowerCase(),
      custody_domain: String(a.custodyDomain),
      mapping_version: dec(a.mappingVersion, "mappingVersion"),
      beneficiary: String(a.beneficiary),
      refund_address: hexBytes(a.refundAddress, 20, "refundAddress"),
      battle_id: dec(a.battleId, "battleId"),
      actual_received: dec(a.actualReceived, "actualReceived"),
      block_number: dec(a.blockNumber, "blockNumber"),
      block_hash: hexBytes(a.blockHash, 32, "blockHash"),
      finalized_head_number: dec(a.finalizedHeadNumber, "finalizedHeadNumber"),
      finalized_head_hash: hexBytes(a.finalizedHeadHash, 32, "finalizedHeadHash"),
      evidence_hash: hexBytes(a.evidenceHash, 32, "evidenceHash"),
    },
  };
}

export function attestCommand(facts: FundingFacts, args: { key: unknown; claim: unknown }): string {
  return `near contract call-function as-transaction ${facts.registry} attest json-args '${JSON.stringify(args)}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${facts.verifier} network-config testnet sign-with-keychain send`;
}
