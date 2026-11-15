/**
 * A GitHub REST client over a pre-minted token (`--token-env`): an
 * installation token from actions/create-github-app-token, or any token the
 * caller already holds. It satisfies `AppClient` without minting anything.
 *
 * The CLI builds it for `--token-env`, and the drift reader builds it from the
 * token variable its kinds-file config names.
 */

import type { AppClient } from "./app-client.js";

/** GitHub's REST API, the default base. */
export const GITHUB_API_URL = "https://api.github.com";

export interface TokenClientOptions {
  token: string;
  /** API base URL; default https://api.github.com. GHES, or a test double. */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function createTokenClient(opts: TokenClientOptions): AppClient {
  const apiBase = (opts.baseUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
  return {
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      const doFetch = opts.fetchImpl ?? fetch;
      const url = path.startsWith("http") ? path : `${apiBase}${path}`;
      const res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "github-warden (+https://github.com/INTENTIUS/github-warden)",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        redirect: "manual",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 204) return {} as T;
      if (!res.ok) {
        let detail = "";
        try {
          const text = await res.text();
          if (text) detail = `: ${text.slice(0, 500)}`;
        } catch {
          // best-effort
        }
        throw new Error(`${method} ${path} returned ${res.status}${detail}`);
      }
      return (await res.json()) as T;
    },
  };
}
