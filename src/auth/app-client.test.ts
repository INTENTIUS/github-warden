import { describe, test, expect, beforeAll } from "vitest";
import type { webcrypto } from "node:crypto";
import { mintInstallationToken, createAppClient, AppAuthError } from "./app-client.js";

// ---------------------------------------------------------------------------
// Test RSA key pair generated once for the whole suite.
// We use crypto.subtle directly here (same as the implementation) to avoid
// any external key-gen dependency.
// ---------------------------------------------------------------------------

let testPrivateKeyPem: string;
let testPublicKey: webcrypto.CryptoKey;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  testPublicKey = pair.publicKey;

  // Export as PKCS#8 and wrap in PEM — this is the format the implementation
  // accepts natively (PKCS#8 path).
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = arrayBufferToBase64(pkcs8);
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPIRES_AT = new Date(Date.now() + 3600_000).toISOString(); // +1 h

function makeTokenResponse(token = "ghs_test_token", expiresAt = EXPIRES_AT): Response {
  return new Response(JSON.stringify({ token, expires_at: expiresAt }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// mintInstallationToken
// ---------------------------------------------------------------------------

describe("mintInstallationToken", () => {
  test("exchanges JWT for an installation token", async () => {
    let capturedRequest: Request | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      capturedRequest = new Request(input as Request | string, init);
      return makeTokenResponse();
    };

    const result = await mintInstallationToken({
      appId: "12345",
      privateKeyPem: testPrivateKeyPem,
      installationId: "67890",
      fetchImpl: mockFetch,
    });

    expect(result.token).toBe("ghs_test_token");
    expect(result.expiresAt).toBe(EXPIRES_AT);
    expect(capturedRequest?.url).toBe(
      "https://api.github.com/app/installations/67890/access_tokens",
    );
    expect(capturedRequest?.method).toBe("POST");
    const authHeader = capturedRequest?.headers.get("Authorization");
    expect(authHeader).toMatch(/^Bearer ey/); // JWT starts with ey (base64 of {"alg"...})
    expect(capturedRequest?.headers.get("Accept")).toBe("application/vnd.github+json");
  });

  test("JWT contains correct iss claim", async () => {
    let capturedAuth = "";
    const mockFetch: typeof fetch = async (_, init) => {
      capturedAuth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return makeTokenResponse();
    };

    await mintInstallationToken({
      appId: "999",
      privateKeyPem: testPrivateKeyPem,
      installationId: "1",
      fetchImpl: mockFetch,
    });

    // Decode the JWT payload (middle segment)
    const jwt = capturedAuth.replace("Bearer ", "");
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.iss).toBe("999");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(600); // 9 min window + 60s backdate
  });

  test("throws AppAuthError on 401", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });

    await expect(
      mintInstallationToken({
        appId: "1",
        privateKeyPem: testPrivateKeyPem,
        installationId: "2",
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(AppAuthError);

    await expect(
      mintInstallationToken({
        appId: "1",
        privateKeyPem: testPrivateKeyPem,
        installationId: "2",
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/JWT/);
  });

  test("throws AppAuthError on 404", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

    const err = (await mintInstallationToken({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "999",
      fetchImpl: mockFetch,
    }).catch((e: unknown) => e)) as AppAuthError;

    expect(err).toBeInstanceOf(AppAuthError);
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/999/);
    expect(err.message).toMatch(/not found/i);
  });

  test("throws AppAuthError on unexpected status", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response("Internal Server Error", { status: 500 });

    const err = (await mintInstallationToken({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    }).catch((e: unknown) => e)) as AppAuthError;

    expect(err).toBeInstanceOf(AppAuthError);
    expect(err.statusCode).toBe(500);
  });

  test("throws AppAuthError on bad key PEM", async () => {
    await expect(
      mintInstallationToken({
        appId: "1",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnotvalidbase64!!!\n-----END PRIVATE KEY-----",
        installationId: "2",
        fetchImpl: async () => makeTokenResponse(),
      }),
    ).rejects.toThrow(AppAuthError);
  });

  test("throws AppAuthError on network failure", async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(
      mintInstallationToken({
        appId: "1",
        privateKeyPem: testPrivateKeyPem,
        installationId: "2",
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(AppAuthError);
  });
});

// ---------------------------------------------------------------------------
// createAppClient
// ---------------------------------------------------------------------------

describe("createAppClient", () => {
  test("injects Authorization header on first request", async () => {
    let requestCount = 0;
    let capturedAuth = "";

    const mockFetch: typeof fetch = async (input, init) => {
      requestCount++;
      const headers = init?.headers as Record<string, string>;
      if (typeof input === "string" && input.includes("access_tokens")) {
        return makeTokenResponse("tok_first");
      }
      capturedAuth = headers["Authorization"] ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    await client.request("GET", "/orgs/my-org");

    expect(capturedAuth).toBe("Bearer tok_first");
    expect(requestCount).toBe(2); // 1 token mint + 1 API call
  });

  test("reuses cached token on subsequent requests", async () => {
    let mintCount = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("access_tokens")) {
        mintCount++;
        return makeTokenResponse(`tok_${mintCount}`);
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    await client.request("GET", "/orgs/my-org");
    await client.request("GET", "/orgs/my-org/teams");
    await client.request("GET", "/repos/my-org/my-repo");

    expect(mintCount).toBe(1); // only one token mint for all 3 calls
  });

  test("two concurrent requests trigger only one token mint", async () => {
    let mintCount = 0;

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("access_tokens")) {
        mintCount++;
        // Defer to a microtask so the second concurrent request reaches
        // getToken() while the first mint is still in flight.
        await Promise.resolve();
        return makeTokenResponse(`tok_${mintCount}`);
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    // Fire two requests in parallel with no token cached yet.
    await Promise.all([
      client.request("GET", "/orgs/my-org"),
      client.request("GET", "/orgs/my-org/teams"),
    ]);

    expect(mintCount).toBe(1); // single-flight guard collapses to one mint
  });

  test("refreshes token when near expiry", async () => {
    let mintCount = 0;
    const expiredAt = new Date(Date.now() + 30_000).toISOString(); // expires in 30s (< 60s skew)
    const freshAt = new Date(Date.now() + 3600_000).toISOString();

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("access_tokens")) {
        mintCount++;
        return makeTokenResponse(`tok_${mintCount}`, mintCount === 1 ? expiredAt : freshAt);
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    // First call mints a token that expires in 30s (below the 60s skew threshold)
    await client.request("GET", "/orgs/my-org");
    // Second call should detect near-expiry and refresh
    await client.request("GET", "/orgs/my-org/members");

    expect(mintCount).toBe(2);
  });

  test("forwards request body as JSON", async () => {
    let capturedBody: unknown;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("access_tokens")) return makeTokenResponse();
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    await client.request("PATCH", "/repos/my-org/my-repo", { private: true });
    expect(capturedBody).toEqual({ private: true });
  });

  test("handles 204 No Content gracefully", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("access_tokens")) return makeTokenResponse();
      return new Response(null, { status: 204 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    const result = await client.request("DELETE", "/teams/1/members/alice");
    expect(result).toEqual({});
  });

  test("throws AppAuthError on non-ok API response", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("access_tokens")) return makeTokenResponse();
      return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    const err = (await client.request("GET", "/orgs/my-org").catch((e: unknown) => e)) as AppAuthError;
    expect(err).toBeInstanceOf(AppAuthError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/Forbidden/); // response body surfaced for debugging
  });

  test("accepts a full URL as the path", async () => {
    let capturedUrl = "";

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("access_tokens")) return makeTokenResponse();
      capturedUrl = url;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const client = createAppClient({
      appId: "1",
      privateKeyPem: testPrivateKeyPem,
      installationId: "2",
      fetchImpl: mockFetch,
    });

    await client.request("GET", "https://api.github.com/orgs/my-org");
    expect(capturedUrl).toBe("https://api.github.com/orgs/my-org");
  });
});
