import { createHash, createHmac, randomUUID } from "node:crypto";

export const bithumbApiBaseUrl = "https://api.bithumb.com";

export interface BithumbCredentials {
  accessKey: string;
  secretKey: string;
}

export type BithumbParamValue = string | number | boolean | readonly (string | number | boolean)[];
export type BithumbParams = Record<string, BithumbParamValue | null | undefined>;

export interface BithumbResponseBody {
  endpoint?: string;
  data?: unknown;
  error?: string;
}

export interface BithumbHttpResponse {
  status: number;
  body: BithumbResponseBody;
}

export interface BithumbPrivateRequest {
  method: "GET" | "POST" | "DELETE";
  endpoint: string;
  params?: BithumbParams;
  body?: BithumbParams;
}

type MaybePromise<T> = T | Promise<T>;
type CredentialsProvider = () => MaybePromise<BithumbCredentials | null>;
type FetchLike = typeof fetch;

export interface BithumbClientOptions {
  baseUrl?: string;
  credentialsProvider?: CredentialsProvider;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class BithumbClient {
  private readonly baseUrl: string;
  private readonly credentialsProvider: CredentialsProvider;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: BithumbClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? bithumbApiBaseUrl;
    this.credentialsProvider = options.credentialsProvider ?? (() => null);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async requestPublic(endpoint: string): Promise<BithumbHttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      const data = await readResponseBody(response);

      return {
        status: response.status,
        body: response.ok
          ? { endpoint: `${this.baseUrl}${endpoint}`, data }
          : { endpoint: `${this.baseUrl}${endpoint}`, error: "Bithumb API request failed", data }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestPrivate({ method, endpoint, params, body }: BithumbPrivateRequest): Promise<BithumbHttpResponse> {
    const credentials = await this.credentialsProvider();
    if (!credentials) {
      return {
        status: 401,
        body: { error: "Bithumb credentials are not configured" }
      };
    }

    const query = params ? encodeBithumbParams(params) : "";
    const requestPath = `${endpoint}${query ? `?${query}` : ""}`;
    const hashSource = body ? encodeBithumbParams(body) : query;
    const token = createBithumbJwt(credentials.accessKey, credentials.secretKey, hashSource);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(stripEmptyParams(body)) : undefined,
        signal: controller.signal
      });
      const data = await readResponseBody(response);

      return {
        status: response.status,
        body: response.ok
          ? { endpoint: `${this.baseUrl}${requestPath}`, data }
          : { endpoint: `${this.baseUrl}${requestPath}`, error: "Bithumb private API request failed", data }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchTradePrice(market: string): Promise<number> {
    const response = await this.requestPublic(`/v1/ticker?${encodeBithumbParams({ markets: market })}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error("Bithumb ticker request failed");
    }

    const data = response.body.data;
    const ticker = Array.isArray(data) ? data[0] : undefined;
    const tradePrice = isRecord(ticker) ? Number(ticker.trade_price) : NaN;
    if (!Number.isFinite(tradePrice) || tradePrice <= 0) {
      throw new Error("Bithumb ticker response did not include trade_price");
    }

    return tradePrice;
  }
}

export function createBithumbJwt(
  accessKey: string,
  secretKey: string,
  hashSource: string,
  options: { nonce?: string; timestamp?: number } = {}
) {
  const payload: Record<string, string | number> = {
    access_key: accessKey,
    nonce: options.nonce ?? randomUUID(),
    timestamp: options.timestamp ?? Date.now()
  };

  if (hashSource) {
    payload.query_hash = createHash("sha512").update(hashSource, "utf8").digest("hex");
    payload.query_hash_alg = "SHA512";
  }

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secretKey).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function encodeBithumbParams(params: BithumbParams) {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${key}[]=${encodeURIComponent(String(item))}`);
      }
      continue;
    }

    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }

  return parts.join("&");
}

function stripEmptyParams(params: BithumbParams): Record<string, string | number | boolean | readonly (string | number | boolean)[]> {
  const stripped: Record<string, string | number | boolean | readonly (string | number | boolean)[]> = {};

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    stripped[key] = value;
  }

  return stripped;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
