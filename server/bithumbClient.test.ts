import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BithumbClient, createBithumbJwt, encodeBithumbParams } from "./bithumbClient";

describe("bithumbClient", () => {
  it("encodes scalar and array params for Bithumb query hashes", () => {
    expect(encodeBithumbParams({ market: "KRW-BTC", client_order_ids: ["a", "b"], empty: "" })).toBe(
      "market=KRW-BTC&client_order_ids[]=a&client_order_ids[]=b"
    );
  });

  it("creates JWT payloads with SHA-512 query hashes", () => {
    const token = createBithumbJwt("access-key", "secret-key", "market=KRW-BTC", {
      nonce: "nonce-1",
      timestamp: 1_717_000_000_000
    });
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;

    expect(payload).toMatchObject({
      access_key: "access-key",
      nonce: "nonce-1",
      timestamp: 1_717_000_000_000,
      query_hash_alg: "SHA512"
    });
    expect(payload.query_hash).toBe(createHash("sha512").update("market=KRW-BTC", "utf8").digest("hex"));
  });

  it("does not call private endpoints when credentials are missing", async () => {
    let called = false;
    const client = new BithumbClient({
      baseUrl: "https://example.test",
      credentialsProvider: () => null,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });

    const response = await client.requestPrivate({ method: "GET", endpoint: "/v1/accounts" });

    expect(response).toEqual({ status: 401, body: { error: "Bithumb credentials are not configured" } });
    expect(called).toBe(false);
  });

  it("signs private requests with the same query string sent to Bithumb", async () => {
    let requestedUrl = "";
    let authorization = "";
    const client = new BithumbClient({
      baseUrl: "https://example.test",
      credentialsProvider: () => ({ accessKey: "access-key", secretKey: "secret-key" }),
      fetchImpl: (async (input, init) => {
        requestedUrl = String(input);
        authorization = String((init?.headers as Record<string, string>).authorization);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch
    });

    const response = await client.requestPrivate({
      method: "GET",
      endpoint: "/v1/orders/chance",
      params: { market: "KRW-BTC" }
    });

    const payload = JSON.parse(Buffer.from(authorization.replace("Bearer ", "").split(".")[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;

    expect(requestedUrl).toBe("https://example.test/v1/orders/chance?market=KRW-BTC");
    expect(response.status).toBe(200);
    expect(payload.query_hash).toBe(createHash("sha512").update("market=KRW-BTC", "utf8").digest("hex"));
  });
});
