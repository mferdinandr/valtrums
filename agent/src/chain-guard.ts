/** Anything that can report the chain id its endpoint serves. */
export interface ChainIdSource {
  chainId(): Promise<bigint>;
}

export class ChainMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainMismatchError";
  }
}

/**
 * Fail-closed check that an RPC serves the configured chain. Throws when the
 * endpoint reports a different chain, a missing or malformed id, or cannot be
 * read at all. The message never includes the RPC URL (it may embed a key).
 */
export async function assertRpcChain(source: ChainIdSource, expected: bigint, what: string): Promise<void> {
  let actual: unknown;
  try {
    actual = await source.chainId();
  } catch {
    throw new ChainMismatchError(`${what}: could not read the RPC chain id, refusing to continue`);
  }
  if (typeof actual !== "bigint" || actual <= 0n) {
    throw new ChainMismatchError(`${what}: the RPC returned a missing or malformed chain id, refusing to continue`);
  }
  if (actual !== expected) {
    throw new ChainMismatchError(`${what}: the RPC serves chain ${actual}, expected ${expected}`);
  }
}
