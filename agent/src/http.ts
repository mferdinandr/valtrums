export interface HttpClient {
  /** GET a URL and parse the JSON body. Must throw on network errors and non-2xx statuses. */
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
}

export function createFetchHttpClient(timeoutMs = 10_000): HttpClient {
  return {
    async getJson(url, headers) {
      const res = await fetch(url, {
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`GET ${new URL(url).host} failed with status ${res.status}`);
      return res.json();
    },
  };
}
