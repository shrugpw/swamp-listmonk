/**
 * @shrug/listmonk — shared HTTP seam + cross-module contracts.
 *
 * This is the single dependency hub: every domain module (auth/settings/lists/
 * subscribers/campaigns) imports ONLY from here, and `../listmonk.ts` imports
 * the config schema + shared types from here too. Keeping all shared contracts
 * in one file lets the domain modules be authored independently without
 * colliding on a shared edit.
 *
 * Auth contract (listmonk v6.2.0, verified against the v6.2.0 source tag AND a
 * live local v6.2.0 instance 2026-10-28):
 *   Authorization: token <apiUser>:<apiToken>   ← literal word "token", a space,
 *                                                  then user:token (NOT bearer).
 * NEVER send a `Cookie:` header — a stray `Cookie: session=...` silently shadows
 * the Authorization header (a v3->v4 migration shim) and the request 403s even
 * with a valid token. `fetch` does not attach cookies on its own, but we also
 * never let a caller inject one.
 *
 * Error contract: listmonk wraps every success as `{"data": ...}`; deletes and
 * toggles return `{"data": true}`; errors are `{"message": "..."}` carrying the
 * HTTP status. Unauth / insufficient-perm => HTTP 403 (NOT 401). Create returns
 * 200 (not 201).
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Config (globalArguments) — the FROZEN cross-module contract.
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .describe(
      "listmonk base URL, no trailing slash and no /api suffix " +
        "(e.g. https://listmonk.example.com). Paths like `api/lists` are appended.",
    ),
  apiUser: z
    .string()
    .min(1)
    .describe(
      "The SCOPED operational API username (listmonk user of type=api, a " +
        "non-superadmin role). Routine methods authenticate as this user. " +
        "Minted by provisionApiUser; never the superadmin.",
    ),
  apiToken: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "The scoped operational API token paired with apiUser. Wire via CEL " +
        'from the vault, e.g. ${{ vault.get("listmonk","api_token") }} ' +
        "— resolved before execute, never logged. Minted once by " +
        "provisionApiUser (listmonk only returns it at creation).",
    ),
  perPage: z
    .number()
    .int()
    .positive()
    .default(100)
    .describe("List pagination page size (listmonk default is 20)."),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      "Global write gate. When true (default), every write method returns a " +
        "would-do preview and performs NO mutating HTTP call. A real write " +
        "requires an explicit dryRun=false. Campaign sends have an ADDITIONAL " +
        "per-call gate on top of this.",
    ),
  maxRetries: z
    .number()
    .int()
    .min(0)
    .default(4)
    .describe("Max retries on HTTP 429 (exponential backoff)."),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The subset of config the network seam needs. GlobalArgs satisfies it. */
export interface LmConfig {
  baseUrl: string;
  apiUser: string;
  apiToken: string;
  perPage?: number;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Logging + execute-context contracts (shared by every module's methods).
// ---------------------------------------------------------------------------

export interface MethodLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

export interface ExecuteContext {
  globalArgs: GlobalArgs;
  logger: MethodLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: {
      lifetime?: string;
      garbageCollection?: number;
      tags?: Record<string, string>;
    },
  ) => Promise<{ name: string }>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

export interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

/** A single method definition, the shape each module's method-map holds. */
// deno-lint-ignore no-explicit-any
export interface MethodDef<A = any> {
  description: string;
  arguments: z.ZodType<A>;
  execute: (args: A, context: ExecuteContext) => Promise<ExecuteResult>;
}

export type MethodMap = Record<string, MethodDef>;

/** A resource output spec — the shape each module's resource-map holds. */
export interface ResourceSpec {
  description: string;
  schema: z.ZodType;
  lifetime: string;
  garbageCollection: number;
  /** Treat every field as sensitive (vault-stored) — e.g. the apiCredential. */
  sensitiveOutput?: boolean;
  /** Override which vault stores sensitive fields for this spec. */
  vaultName?: string;
}

export type ResourceMap = Record<string, ResourceSpec>;

// ---------------------------------------------------------------------------
// Fetch seam — the SOLE place auth/headers/error-mapping/retry live.
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  headers: { get(name: string): string | null };
}>;

export interface LmFetchOptions {
  /** Query pairs appended to the URL. */
  query?: Array<[string, string]>;
  /** JSON body (object) — serialized with Content-Type: application/json. */
  json?: unknown;
  /**
   * Raw multipart/form body (FormData) — used only by subscriber import. When
   * set, Content-Type is NOT set (fetch adds the multipart boundary) and `json`
   * is ignored.
   */
  form?: BodyInit;
  /**
   * When true, return the raw response TEXT instead of parsing `{data:...}`.
   * Campaign preview endpoints return raw html/text, not the JSON envelope.
   */
  raw?: boolean;
}

/** Build the `Authorization: token user:token` header value (exported for tests). */
export function authHeader(cfg: LmConfig): string {
  return `token ${cfg.apiUser}:${cfg.apiToken}`;
}

/**
 * Perform a single listmonk API call against the shared seam.
 *
 * Returns the FULL parsed envelope (`{data: ...}` or `{data: true}`); callers
 * read `.data`. With `opts.raw`, returns the response body as a string instead
 * (for campaign previews). Throws on any non-2xx, surfacing listmonk's
 * `{message}` plus the HTTP status (403 => auth/permission).
 */
export async function lmFetch(
  cfg: LmConfig,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: LmFetchOptions = {},
  doFetch: FetchLike = fetch as unknown as FetchLike,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL(
    `${cfg.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
  );
  for (const [k, v] of opts.query ?? []) url.searchParams.append(k, v);

  // Authorization is the ONLY auth header. We deliberately never set Cookie.
  const headers: Record<string, string> = {
    "Authorization": authHeader(cfg),
    "Accept": "application/json",
  };
  let body: BodyInit | undefined;
  if (opts.form !== undefined) {
    body = opts.form; // multipart; let fetch set Content-Type + boundary.
  } else if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  const maxAttempts = (cfg.maxRetries ?? 4) + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await doFetch(url.toString(), {
      method,
      headers,
      body,
      signal,
    });
    if (resp.status === 429 && attempt < maxAttempts) {
      const retryAfter = Number(resp.headers.get("Retry-After"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 250;
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    const text = await resp.text();
    if (!resp.ok) {
      // Error bodies are `{"message":"..."}` but a proxy 5xx may be non-JSON;
      // surface the HTTP status regardless so a 403 is never swallowed.
      let detail = resp.statusText;
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j && typeof j.message === "string") detail = j.message;
      } catch { /* non-JSON error body: keep statusText */ }
      throw new Error(
        `listmonk ${method} ${path} failed (HTTP ${resp.status}): ${detail}`,
      );
    }
    if (opts.raw) return { raw: text };
    if (text === "") return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A 2xx with a non-JSON body (e.g. a proxy's HTML interstitial) must
      // surface as a mapped error, not a raw SyntaxError the caller can't place.
      throw new Error(
        `listmonk ${method} ${path} returned a non-JSON 2xx body ` +
          `(HTTP ${resp.status}); expected a {data:...} envelope`,
      );
    }
  }
  throw new Error(`listmonk ${method} ${path}: unexpected retry fall-through`);
}

/**
 * The listmonk PageResults envelope: `{data:{results:[...],total,per_page,page}}`.
 * An empty result MAY come back as a bare `{data: []}` array instead — handle
 * both. Returns the accumulated `results` rows across all pages.
 */
export async function lmFetchAll(
  cfg: LmConfig,
  path: string,
  query: Array<[string, string]> = [],
  doFetch: FetchLike = fetch as unknown as FetchLike,
  logger?: MethodLogger,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  const perPage = cfg.perPage ?? 100;
  const maxPages = 100000; // safety valve against a misreported `total`.
  let page = 1;
  while (page <= maxPages) {
    const pageQuery: Array<[string, string]> = [
      ...query,
      ["page", String(page)],
      ["per_page", String(perPage)],
    ];
    const json = await lmFetch(
      cfg,
      "GET",
      path,
      { query: pageQuery },
      doFetch,
      signal,
    );
    const data = json.data;
    // Bare-array fallback: `{data: []}` (or a populated bare array) with no
    // pagination envelope.
    if (Array.isArray(data)) {
      for (const row of data as Array<Record<string, unknown>>) all.push(row);
      break;
    }
    const envelope = (data ?? {}) as Record<string, unknown>;
    const results = Array.isArray(envelope.results)
      ? envelope.results as Array<Record<string, unknown>>
      : [];
    for (const row of results) all.push(row);
    const total = typeof envelope.total === "number" ? envelope.total : null;
    if (results.length === 0 || total === null || all.length >= total) break;
    page += 1;
  }
  if (page > maxPages) {
    logger?.warning(
      "listmonk {path} pagination hit the {maxPages}-page cap ({rows} rows); " +
        "snapshot is TRUNCATED",
      { path, maxPages, rows: all.length },
    );
  }
  return all;
}

/**
 * Guard a value destined for `:id` path interpolation. The token is privileged,
 * so an unvalidated id ("../users/1") would let a caller reach arbitrary host
 * endpoints — this is a security boundary, not a convenience check. listmonk
 * ids are positive integers.
 */
export function assertId(id: number | string, what = "id"): string {
  const s = String(id);
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`invalid ${what} (must be a positive integer): ${s}`);
  }
  return s;
}
