/**
 * GitHub App installation-token auth client.
 *
 * Mints a short-lived App JWT (RS256 via Web Crypto), exchanges it for an
 * installation access token, and exposes a thin authed REST client that
 * auto-refreshes before the token expires.
 *
 * No native modules — Web Crypto only (runs in Node ≥ 16 and edge runtimes).
 */

import type { webcrypto } from "node:crypto";

const API_BASE = "https://api.github.com";
const USER_AGENT = "github-warden (+https://github.com/INTENTIUS/github-warden)";

/** Number of seconds before expiry to refresh proactively. */
const REFRESH_SKEW_S = 60;

// ── JWT helpers (RS256 via crypto.subtle) ────────────────────────────────────

function b64url(buf: ArrayBuffer): string {
  // String.fromCharCode(...new Uint8Array(buf)) is safe here because RSA
  // signatures are 256–512 bytes (2048–4096-bit keys), well within the call
  // stack argument limit. If this function were ever used on large buffers
  // (e.g. file content), the spread would exceed the JS engine argument limit
  // (~65 k entries in V8) and throw a RangeError. For large inputs, use a
  // chunked loop: iterate over the array in ~1 k-byte blocks and call btoa on
  // each chunk, concatenating the results before the base64url substitutions.
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jsonB64url(obj: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Parse a PKCS#8 or PKCS#1 RSA PEM and import it as a CryptoKey for RS256
 * signing.
 *
 * GitHub App private keys are distributed as PKCS#1 ("RSA PRIVATE KEY"). Web
 * Crypto only accepts PKCS#8, so we convert the raw DER by prepending the
 * PKCS#8 AlgorithmIdentifier header when we detect a PKCS#1 PEM.
 */
async function importRsaPrivateKey(pem: string): Promise<webcrypto.CryptoKey> {
  const stripped = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");

  let derBytes: Uint8Array;
  try {
    const binary = atob(stripped);
    derBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      derBytes[i] = binary.charCodeAt(i);
    }
  } catch {
    throw new AppAuthError("private key PEM contains invalid base64");
  }

  const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(pem);
  let keyDer: Uint8Array;
  if (isPkcs1) {
    // Wrap PKCS#1 RSA key in a PKCS#8 PrivateKeyInfo container.
    // PKCS#8 AlgorithmIdentifier for rsaEncryption OID 1.2.840.113549.1.1.1:
    //   SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
    const algorithmIdentifier = new Uint8Array([
      0x30, 0x0d,            // SEQUENCE (13 bytes)
      0x06, 0x09,            // OID (9 bytes)
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
      0x05, 0x00,            // NULL
    ]);
    // OCTET STRING wrapper: 0x04 + length + content
    const octetStr = encodeDerTlv(0x04, derBytes);
    // PKCS#8 PrivateKeyInfo SEQUENCE:
    //   INTEGER 0 (version)
    //   algorithmIdentifier
    //   OCTET STRING (pkcs1 key)
    const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
    const inner = concatUint8(version, algorithmIdentifier, octetStr);
    keyDer = encodeDerTlv(0x30, inner); // SEQUENCE
  } else {
    keyDer = derBytes;
  }

  try {
    return (await crypto.subtle.importKey(
      "pkcs8",
      keyDer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )) as webcrypto.CryptoKey;
  } catch (err) {
    throw new AppAuthError(
      `failed to import private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function encodeDerTlv(tag: number, content: Uint8Array): Uint8Array {
  const len = content.byteLength;
  let lenBytes: Uint8Array;
  if (len < 0x80) {
    lenBytes = new Uint8Array([len]);
  } else if (len < 0x100) {
    lenBytes = new Uint8Array([0x81, len]);
  } else {
    lenBytes = new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  return concatUint8(new Uint8Array([tag]), lenBytes, content);
}

function concatUint8(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

/**
 * Build and sign an App JWT valid for ~9 minutes.
 *
 * GitHub rejects App JWTs whose `exp` is more than 10 minutes in the future. We
 * cap at 9 minutes (`now + 540`) to leave clock-skew headroom — a host clock
 * running fast would otherwise push `exp` past the limit and trigger a 422.
 * `iat` is backdated 60s for the same reason (host clock running slow).
 */
async function buildAppJwt(appId: string, key: webcrypto.CryptoKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = jsonB64url({ alg: "RS256", typ: "JWT" });
  const payload = jsonB64url({ iat: now - 60, exp: now + 540, iss: appId });
  const sigInput = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key as Parameters<typeof crypto.subtle.sign>[1], sigInput);
  return `${header}.${payload}.${b64url(sig)}`;
}

// ── Public errors ────────────────────────────────────────────────────────────

export class AppAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "AppAuthError";
  }
}

// ── mintInstallationToken ────────────────────────────────────────────────────

export interface MintOptions {
  /** GitHub App ID (numeric string or number). */
  appId: string | number;
  /** RSA private key in PEM format (PKCS#1 or PKCS#8). */
  privateKeyPem: string;
  /** GitHub App installation ID. */
  installationId: string | number;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface InstallationToken {
  token: string;
  /** ISO-8601 expiry from the GitHub API response. */
  expiresAt: string;
}

/**
 * Build an App JWT, exchange it at `POST /app/installations/{id}/access_tokens`,
 * and return the short-lived installation token + its expiry.
 */
export async function mintInstallationToken(opts: MintOptions): Promise<InstallationToken> {
  const { appId, privateKeyPem, installationId, fetchImpl } = opts;
  const doFetch = fetchImpl ?? fetch;

  const key = await importRsaPrivateKey(privateKeyPem);
  const jwt = await buildAppJwt(String(appId), key);

  const url = `${API_BASE}/app/installations/${installationId}/access_tokens`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
    });
  } catch (err) {
    throw new AppAuthError(
      `network error minting installation token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401) {
    throw new AppAuthError("GitHub rejected the App JWT — check appId and privateKeyPem", 401);
  }
  if (res.status === 404) {
    throw new AppAuthError(
      `installation ${installationId} not found — check installationId and App permissions`,
      404,
    );
  }
  if (!res.ok) {
    throw new AppAuthError(`unexpected status ${res.status} from GitHub token endpoint`, res.status);
  }

  let body: { token?: string; expires_at?: string };
  try {
    body = (await res.json()) as { token?: string; expires_at?: string };
  } catch {
    throw new AppAuthError("could not parse GitHub token response as JSON");
  }

  if (!body.token || !body.expires_at) {
    throw new AppAuthError("GitHub token response missing token or expires_at field");
  }

  return { token: body.token, expiresAt: body.expires_at };
}

// ── createAppClient ──────────────────────────────────────────────────────────

export interface AppClientOptions extends MintOptions {}

export interface AppClient {
  /**
   * Make an authed GitHub API request. The token is injected automatically and
   * refreshed if within REFRESH_SKEW_S of expiry.
   */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

/**
 * Returns a thin authed REST client that mints an installation token on the
 * first call and refreshes it before it expires.
 */
export function createAppClient(opts: AppClientOptions): AppClient {
  let cached: InstallationToken | null = null;
  // Single-flight guard: when a mint is in progress, concurrent callers await
  // the same promise instead of each kicking off their own token exchange. The
  // reconciler makes parallel request() calls, so without this two stale/empty
  // reads would double-mint and waste rate-limit quota.
  let pendingMint: Promise<InstallationToken> | null = null;
  const doFetch = opts.fetchImpl ?? fetch;

  async function getToken(): Promise<string> {
    const nowS = Math.floor(Date.now() / 1000);
    if (cached) {
      const expiryS = Math.floor(new Date(cached.expiresAt).getTime() / 1000);
      if (expiryS - nowS > REFRESH_SKEW_S) {
        return cached.token;
      }
    }
    if (!pendingMint) {
      pendingMint = mintInstallationToken(opts).finally(() => {
        pendingMint = null;
      });
    }
    cached = await pendingMint;
    return cached.token;
  }

  return {
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      const token = await getToken();
      const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          redirect: "manual",
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        throw new AppAuthError(
          `network error on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!res.ok) {
        // GitHub API error bodies carry the failure reason (e.g. which field is
        // invalid) and contain no secrets, so surfacing them is safe and makes
        // prod debugging possible. Cap the length to keep error messages sane.
        let detail = "";
        try {
          const text = await res.text();
          if (text) detail = `: ${text.slice(0, 500)}`;
        } catch {
          // best-effort — fall back to the bare status line
        }
        throw new AppAuthError(`${method} ${path} returned ${res.status}${detail}`, res.status);
      }

      // 204 No Content — return empty object cast to T
      if (res.status === 204) return {} as T;

      try {
        return (await res.json()) as T;
      } catch {
        throw new AppAuthError(`could not parse response from ${method} ${path} as JSON`);
      }
    },
  };
}
