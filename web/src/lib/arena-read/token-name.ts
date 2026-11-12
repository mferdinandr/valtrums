/** The plain name of a token: the testnet mocks are labelled "mCASHCAT", but people (and the UI) say CASHCAT. */
export function plainSymbol(symbol: string): string {
  return /^m[A-Z][A-Z0-9]*$/.test(symbol) ? symbol.slice(1) : symbol;
}
