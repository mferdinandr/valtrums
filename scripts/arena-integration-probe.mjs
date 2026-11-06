#!/usr/bin/env node
/** Read-only public service probes. Never signs, deposits, or requests wet quotes. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const output = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
const hash = (body) => createHash("sha256").update(body).digest("hex");
async function probe(name, url, init, summarize) {
  const base = { name, host: new URL(url).hostname, checkedAt: new Date().toISOString(), fixture: false };
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000), headers: { accept: "application/json", "content-type": "application/json" } });
    const raw = await response.text();
    if (!response.ok) return { ...base, state: "Unavailable", httpStatus: response.status, responseSha256: hash(raw) };
    const body = JSON.parse(raw);
    return { ...base, responseSha256: hash(raw), ...summarize(body) };
  } catch (error) {
    return { ...base, state: "Unavailable", reason: error instanceof Error ? error.name : "request failed" };
  }
}
const rpc = (method, params = []) => ({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const results = await Promise.all([
  probe("robinhood-testnet", "https://rpc.testnet.chain.robinhood.com", rpc("eth_chainId"), (body) => ({ state: body.result === "0xb626" ? "Verified" : "Mismatch", expectedChainId: "46630", returnedChainId: typeof body.result === "string" ? body.result : null })),
  probe("near-testnet", "https://rpc.testnet.near.org", rpc("status"), (body) => ({ state: body.result?.chain_id === "testnet" ? "Verified" : "Mismatch", returnedChainId: body.result?.chain_id ?? null })),
  probe("goplus-token-security-coverage", "https://api.gopluslabs.io/api/v1/supported_chains?name=token_security", {}, (body) => {
    if (body.code !== 1 || !Array.isArray(body.result)) return { state: "Unavailable", reason: "unexpected coverage response" };
    const chain = body.result.find((item) => String(item.id) === "46630");
    return { state: chain ? "Listed" : "NotListed", expectedChainId: "46630", meaning: "Coverage listing does not verify any specific token audit" };
  }),
  probe("intents-asset-discovery", "https://1click.chaindefuser.com/v0/tokens", {}, (body) => {
    if (!Array.isArray(body)) return { state: "Unavailable", reason: "unexpected token discovery response" };
    const tokens = body.filter((item) => /robinhood/i.test(String(item.blockchain)));
    return { state: tokens.length ? "Candidates" : "NotListed", candidateAssetIds: tokens.map((item) => item.assetId), meaning: "Named-chain asset discovery alone does not prove testnet chain ID, route, quote or settlement support" };
  }),
]);
const report = { schemaVersion: 1, mode: "read-only-public-probe", results, unverified: ["signer derived key and signature", "funded Robinhood transaction and canonical receipt", "actual token security fields", "30-second market observations", "Intents testnet route execution", "Bitte orchestration"] };
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
for (const result of results) console.log(`${result.name}: ${result.state}`);
if (results.some((result) => result.state === "Unavailable" || result.state === "Mismatch")) process.exitCode = 1;
