/**
 * @shrug/listmonk — subscribers module (Phase 3).
 *
 * Covers: querySubscribers/getSubscriber (reads), importSubscribers (the
 * async global-singleton CSV import flow) + getImportStatus/stopImport,
 * upsertSubscriber (POST, 409-on-dup -> find-by-email -> PATCH/PUT),
 * deleteSubscriber, manageSubscriberLists.
 *
 * Pinned v6.2.0 contract highlights (see design/listmonk-extension.md):
 *  - Import is ASYNC + a GLOBAL SINGLETON: reset (DELETE) -> multipart POST
 *    (`params` JSON string + `file` CSV) -> poll GET until finished|failed ->
 *    GET /logs and SCAN even on finished (partial-row failures only surface
 *    there). CSV header is `email,name,attributes` (REST field is `attribs`,
 *    the CSV COLUMN is `attributes`).
 *  - `GET /api/subscribers?query=` is a RAW SQL fragment -> the email literal
 *    MUST be escaped (see escapeSqlLiteral) before interpolation.
 *  - POST /api/subscribers 409s on a duplicate email -> find-by-email, then
 *    PATCH (gentle partial update, PRESERVES list membership) or PUT (full
 *    replace; does not bind list_uuids) per caller's `updateMethod`.
 *  - PUT /api/subscribers/lists adds/removes/unsubscribes lists without a
 *    full subscriber replace.
 */
import { z } from "npm:zod@4";
import {
  assertId,
  type ExecuteContext,
  type ExecuteResult,
  type FetchLike,
  type LmConfig,
  lmFetch,
  lmFetchAll,
  type MethodMap,
  type ResourceMap,
} from "./http.ts";

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const SubscriberSchema = z.object({
  id: z.number(),
  uuid: z.string(),
  email: z.string(),
  name: z.string(),
  status: z.string(),
  attribs: z.record(z.string(), z.unknown()),
  lists: z.array(z.unknown()),
});

const SubscribersListSchema = z.object({
  retrievedAt: z.string(),
  query: z.string().nullable(),
  listId: z.number().nullable(),
  count: z.number(),
  rows: z.array(SubscriberSchema),
});

const SubscriberSingleSchema = z.object({
  retrievedAt: z.string(),
  found: z.boolean(),
  subscriber: SubscriberSchema.nullable(),
});

const ImportRunSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  status: z.string(),
  params: z.record(z.string(), z.unknown()).nullable(),
  rowCount: z.number().nullable(),
  imported: z.number().nullable(),
  errors: z.array(z.string()),
  logsScanned: z.boolean(),
  sampleCsv: z.string().optional(),
});

const SubscriberUpsertSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  email: z.string(),
  action: z.string(),
  method: z.string(),
  id: z.number().nullable(),
});

const SubscriberDeleteSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  id: z.number(),
  email: z.string().nullable(),
  action: z.string(),
});

const SubscriberListsSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  subscriberIds: z.array(z.number()),
  listIds: z.array(z.number()),
  action: z.string(),
  status: z.string().nullable(),
  applied: z.boolean(),
});

export const subscribersResources: ResourceMap = {
  subscribers: {
    description:
      "A querySubscribers snapshot: the (optionally query/list_id filtered) " +
      "subscriber rows, paginated via lmFetchAll.",
    schema: SubscribersListSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  subscriber: {
    description:
      "getSubscriber result — a single subscriber row, by id or email.",
    schema: SubscriberSingleSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  importRun: {
    description:
      "Audit of an importSubscribers/getImportStatus/stopImport call: status, " +
      "params, row-level errors scanned from /api/import/subscribers/logs.",
    schema: ImportRunSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  subscriberUpsert: {
    description:
      "Audit of an upsertSubscriber call (create or 409-then-update).",
    schema: SubscriberUpsertSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  subscriberDelete: {
    description: "Audit of a deleteSubscriber call.",
    schema: SubscriberDeleteSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  subscriberLists: {
    description: "Audit of a manageSubscriberLists call.",
    schema: SubscriberListsSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Escape a string for interpolation into listmonk's raw-SQL `query=` fragment
 * by doubling single quotes. This is the ONLY sanctioned way to put caller
 * input into that fragment — `query=` is not a parameterized API, so an
 * unescaped literal is a SQL-injection path straight through the listmonk DB.
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Build the raw-SQL `query=` fragment for an exact-email subscriber lookup. */
export function buildEmailQuery(email: string): string {
  return `subscribers.email='${escapeSqlLiteral(email)}'`;
}

function csvField(value: string): string {
  if (/["\n\r,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export interface ImportRow {
  email: string;
  name?: string;
  attribs?: Record<string, unknown>;
}

/**
 * Build the listmonk subscriber-import CSV. Header is `email,name,attributes`
 * — the REST field is `attribs`, but the CSV COLUMN listmonk expects is
 * `attributes` (a JSON blob per row).
 */
export function buildCsv(rows: ImportRow[]): string {
  const lines = ["email,name,attributes"];
  for (const row of rows) {
    const attributesJson = JSON.stringify(row.attribs ?? {});
    lines.push(
      [
        csvField(row.email),
        csvField(row.name ?? ""),
        csvField(attributesJson),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export interface ImportParamsInput {
  mode: "subscribe" | "blocklist";
  subscriptionStatus: "unconfirmed" | "confirmed" | "unsubscribed";
  delim: string;
  listIds: number[];
  overwrite: boolean;
  overwriteUserinfo?: boolean;
  overwriteSubscriptionStatus?: boolean;
}

/** Build the `params` JSON object (NOT yet stringified) for the import POST. */
export function buildImportParams(
  input: ImportParamsInput,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    mode: input.mode,
    subscription_status: input.subscriptionStatus,
    delim: input.delim,
    lists: input.listIds,
    overwrite: input.overwrite,
  };
  if (input.overwriteUserinfo !== undefined) {
    params.overwrite_userinfo = input.overwriteUserinfo;
  }
  if (input.overwriteSubscriptionStatus !== undefined) {
    params.overwrite_subscription_status = input.overwriteSubscriptionStatus;
  }
  return params;
}

/**
 * Scan raw import-log text for row-level error lines. listmonk's import log
 * is free-form text; row failures surface as lines mentioning an error even
 * when the overall import `status` is `finished` (partial-row failures don't
 * flip the overall status).
 */
export function scanImportErrors(logsText: string): string[] {
  return logsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /error/i.test(line));
}

/** Normalize a raw listmonk subscriber row into the SubscriberSchema shape. */
export function normalizeSubscriberRow(
  raw: Record<string, unknown>,
): z.infer<typeof SubscriberSchema> {
  return {
    id: Number(raw.id),
    uuid: String(raw.uuid ?? ""),
    email: String(raw.email ?? ""),
    name: String(raw.name ?? ""),
    status: String(raw.status ?? ""),
    attribs: (raw.attribs ?? {}) as Record<string, unknown>,
    lists: Array.isArray(raw.lists) ? raw.lists as unknown[] : [],
  };
}

/**
 * Extract the row array from a listmonk list/query envelope: either a bare
 * `{data:[...]}` array (empty-result shorthand) or the PageResults envelope
 * `{data:{results:[...], ...}}`.
 */
export function extractRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const env = (data ?? {}) as Record<string, unknown>;
  return Array.isArray(env.results)
    ? env.results as Array<Record<string, unknown>>
    : [];
}

/** True when `err` is an lmFetch error carrying HTTP 409 (duplicate email). */
export function isHttp409(err: unknown): boolean {
  return err instanceof Error && /\(HTTP 409\)/.test(err.message);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applySubscriberUpdate(
  cfg: LmConfig,
  id: number,
  args: {
    email: string;
    name?: string;
    attribs?: Record<string, unknown>;
    status?: "enabled" | "disabled" | "blocklisted";
    updateMethod: "patch" | "put";
  },
  doFetch?: FetchLike,
): Promise<string> {
  const idStr = assertId(id, "subscriberId");
  const body: Record<string, unknown> = {};
  if (args.name !== undefined) body.name = args.name;
  if (args.attribs !== undefined) body.attribs = args.attribs;
  if (args.status !== undefined) body.status = args.status;
  if (args.updateMethod === "put") {
    body.email = args.email;
    await lmFetch(
      cfg,
      "PUT",
      `api/subscribers/${idStr}`,
      { json: body },
      doFetch,
    );
    return "updated-put";
  }
  await lmFetch(
    cfg,
    "PATCH",
    `api/subscribers/${idStr}`,
    { json: body },
    doFetch,
  );
  return "updated-patch";
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const queryArgs = z.object({
  query: z.string().optional().describe(
    "Raw SQL fragment, e.g. subscribers.status='enabled'. For an email " +
      "lookup use buildEmailQuery (escapes the literal) rather than hand-" +
      "building it.",
  ),
  listId: z.number().int().positive().optional(),
});

const getArgs = z.object({
  id: z.union([z.number().int().positive(), z.string()]).optional(),
  email: z.string().min(1).optional(),
}).refine((a) => a.id !== undefined || a.email !== undefined, {
  message: "getSubscriber requires either id or email",
});

const importArgs = z.object({
  rows: z.array(
    z.object({
      email: z.string().min(1),
      name: z.string().optional(),
      attribs: z.record(z.string(), z.unknown()).optional(),
    }),
  ).min(1).describe(
    "Subscriber rows to import — depersonalized example: " +
      '[{"email":"user@example.com","name":"Example User"}].',
  ),
  mode: z.enum(["subscribe", "blocklist"]).default("subscribe"),
  subscriptionStatus: z.enum(["unconfirmed", "confirmed", "unsubscribed"])
    .default("unconfirmed")
    .describe(
      "The per-list subscription_status axis — distinct from subscriber-" +
        "level status (enabled|disabled|blocklisted).",
    ),
  listIds: z.array(z.number().int().positive()).default([]),
  overwrite: z.boolean().default(false),
  overwriteUserinfo: z.boolean().optional(),
  overwriteSubscriptionStatus: z.boolean().optional(),
  delim: z.string().default(","),
  pollIntervalMs: z.number().int().positive().default(1000),
  pollTimeoutMs: z.number().int().positive().default(5 * 60 * 1000),
});

const importStatusArgs = z.object({});

const stopImportArgs = z.object({});

const upsertArgs = z.object({
  email: z.string().min(1),
  name: z.string().optional(),
  attribs: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["enabled", "disabled", "blocklisted"]).optional(),
  listIds: z.array(z.number().int().positive()).optional().describe(
    "Bound on CREATE only (list_uuids) — not re-sent on PATCH/PUT. Use " +
      "manageSubscriberLists to change list membership on an existing row.",
  ),
  updateMethod: z.enum(["patch", "put"]).default("patch").describe(
    "On a 409 (duplicate email), PATCH (default) preserves existing list " +
      "membership; PUT fully replaces the row (does not bind list_uuids " +
      "either, but is a blunter replace — prefer PATCH unless you need PUT " +
      "semantics).",
  ),
});

const deleteArgs = z.object({
  id: z.union([z.number().int().positive(), z.string()]),
});

const manageListsArgs = z.object({
  subscriberIds: z.array(z.union([z.number().int().positive(), z.string()]))
    .min(1),
  listIds: z.array(z.number().int().positive()).min(1),
  action: z.enum(["add", "remove", "unsubscribe"]),
  status: z.enum(["unconfirmed", "confirmed", "unsubscribed"]).optional()
    .describe("subscription_status to set — only meaningful for action=add."),
});

export const subscribersMethods: MethodMap = {
  querySubscribers: {
    description:
      "GET /api/subscribers (subscribers:get_all), paginated via lmFetchAll. " +
      "Optional raw-SQL `query` (escape literals yourself, e.g. via " +
      "buildEmailQuery) and/or `listId` filter. Read-only.",
    arguments: queryArgs,
    execute: async (
      args: z.infer<typeof queryArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const query: Array<[string, string]> = [];
      if (args.query) query.push(["query", args.query]);
      if (args.listId !== undefined) {
        query.push(["list_id", assertId(args.listId, "listId")]);
      }
      const rows = await lmFetchAll(
        cfg,
        "api/subscribers",
        query,
        args._fetch,
        context.logger,
      );
      context.logger.info("querySubscribers: {n} rows", { n: rows.length });
      const handle = await context.writeResource("subscribers", "subscribers", {
        retrievedAt: new Date().toISOString(),
        query: args.query ?? null,
        listId: args.listId ?? null,
        count: rows.length,
        rows: rows.map(normalizeSubscriberRow),
      });
      return { dataHandles: [handle] };
    },
  },

  getSubscriber: {
    description:
      "Look up one subscriber: by id (GET /api/subscribers/:id) or by email " +
      "(GET /api/subscribers?query=<escaped SQL>). Read-only.",
    arguments: getArgs,
    execute: async (
      args: z.infer<typeof getArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const doFetch = args._fetch as FetchLike | undefined;
      let row: Record<string, unknown> | null = null;
      if (args.id !== undefined) {
        const idStr = assertId(args.id, "subscriberId");
        const j = await lmFetch(
          cfg,
          "GET",
          `api/subscribers/${idStr}`,
          {},
          doFetch,
        );
        row = (j.data ?? null) as Record<string, unknown> | null;
      } else {
        const sql = buildEmailQuery(args.email as string);
        const j = await lmFetch(
          cfg,
          "GET",
          "api/subscribers",
          { query: [["query", sql]] },
          doFetch,
        );
        row = extractRows(j.data)[0] ?? null;
      }
      const handle = await context.writeResource("subscriber", "subscriber", {
        retrievedAt: new Date().toISOString(),
        found: row !== null,
        subscriber: row ? normalizeSubscriberRow(row) : null,
      });
      return { dataHandles: [handle] };
    },
  },

  importSubscribers: {
    description:
      "GATED write. The full async import flow: DELETE /api/import/" +
      "subscribers (reset any stuck session) -> multipart POST (`params` " +
      "JSON string + CSV `file`) -> poll GET until status in " +
      "{finished,failed} -> GET /logs and scan for row errors even on " +
      "finished. Throws if the final status is failed. dryRun (default true) " +
      "computes the plan (params + row count + a CSV sample) and performs NO " +
      "HTTP call.",
    arguments: importArgs,
    execute: async (
      args:
        & z.infer<typeof importArgs>
        & { _fetch?: FetchLike; _sleep?: (ms: number) => Promise<void> },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const doFetch = args._fetch as FetchLike | undefined;
      const sleep =
        (args._sleep as ((ms: number) => Promise<void>) | undefined) ??
          defaultSleep;

      const params = buildImportParams({
        mode: args.mode,
        subscriptionStatus: args.subscriptionStatus,
        delim: args.delim,
        listIds: args.listIds,
        overwrite: args.overwrite,
        overwriteUserinfo: args.overwriteUserinfo,
        overwriteSubscriptionStatus: args.overwriteSubscriptionStatus,
      });
      const csv = buildCsv(args.rows);

      if (cfg.dryRun) {
        context.logger.warning(
          "importSubscribers DRY RUN: {n} rows, no HTTP calls",
          { n: args.rows.length },
        );
        const sampleCsv = csv.split("\r\n").slice(0, 4).join("\r\n");
        const handle = await context.writeResource("importRun", "importRun", {
          retrievedAt: new Date().toISOString(),
          dryRun: true,
          status: "none",
          params,
          rowCount: args.rows.length,
          imported: null,
          errors: [],
          logsScanned: false,
          sampleCsv,
        });
        return { dataHandles: [handle] };
      }

      // --- live path ---
      context.logger.info("importSubscribers: resetting any stuck session");
      await lmFetch(cfg, "DELETE", "api/import/subscribers", {}, doFetch);

      const form = new FormData();
      form.append("params", JSON.stringify(params));
      form.append(
        "file",
        new Blob([csv], { type: "text/csv" }),
        "subscribers.csv",
      );
      await lmFetch(
        cfg,
        "POST",
        "api/import/subscribers",
        { form },
        doFetch,
      );

      let status = "importing";
      let lastRow: Record<string, unknown> = {};
      const deadline = Date.now() + args.pollTimeoutMs;
      while (true) {
        const j = await lmFetch(
          cfg,
          "GET",
          "api/import/subscribers",
          {},
          doFetch,
        );
        lastRow = (j.data ?? {}) as Record<string, unknown>;
        status = String(lastRow.status ?? "");
        if (status === "finished" || status === "failed") break;
        if (Date.now() > deadline) {
          throw new Error(
            `importSubscribers: polling timed out after ${args.pollTimeoutMs}ms` +
              ` (last status=${status})`,
          );
        }
        await sleep(args.pollIntervalMs);
      }

      const logsJson = await lmFetch(
        cfg,
        "GET",
        "api/import/subscribers/logs",
        {},
        doFetch,
      );
      const logsText = typeof logsJson.data === "string"
        ? logsJson.data
        : JSON.stringify(logsJson.data ?? "");
      const errors = scanImportErrors(logsText);

      context.logger.info(
        "importSubscribers: status={status}, {n} error-log lines",
        { status, n: errors.length },
      );

      const handle = await context.writeResource("importRun", "importRun", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        status,
        params,
        rowCount: args.rows.length,
        imported: typeof lastRow.imported === "number"
          ? lastRow.imported
          : null,
        errors,
        logsScanned: true,
      });

      if (status === "failed") {
        throw new Error(
          `importSubscribers: listmonk reported status=failed ` +
            `(${errors.length} error-log lines; see the importRun resource)`,
        );
      }
      return { dataHandles: [handle] };
    },
  },

  getImportStatus: {
    description:
      "GET /api/import/subscribers — read-only import-session status.",
    arguments: importStatusArgs,
    execute: async (
      args: z.infer<typeof importStatusArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const j = await lmFetch(
        cfg,
        "GET",
        "api/import/subscribers",
        {},
        args._fetch,
      );
      const data = (j.data ?? {}) as Record<string, unknown>;
      const handle = await context.writeResource("importRun", "importRun", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        status: String(data.status ?? "none"),
        params: (data.params ?? null) as Record<string, unknown> | null,
        rowCount: null,
        imported: typeof data.imported === "number" ? data.imported : null,
        errors: [],
        logsScanned: false,
      });
      return { dataHandles: [handle] };
    },
  },

  stopImport: {
    description:
      "GATED write. DELETE /api/import/subscribers — stops/resets the " +
      "global-singleton import session back to `none`.",
    arguments: stopImportArgs,
    execute: async (
      args: z.infer<typeof stopImportArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      if (cfg.dryRun) {
        context.logger.warning("stopImport DRY RUN: no DELETE sent");
        const handle = await context.writeResource("importRun", "importRun", {
          retrievedAt: new Date().toISOString(),
          dryRun: true,
          status: "would-stop",
          params: null,
          rowCount: null,
          imported: null,
          errors: [],
          logsScanned: false,
        });
        return { dataHandles: [handle] };
      }
      await lmFetch(cfg, "DELETE", "api/import/subscribers", {}, args._fetch);
      const handle = await context.writeResource("importRun", "importRun", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        status: "none",
        params: null,
        rowCount: null,
        imported: null,
        errors: [],
        logsScanned: false,
      });
      return { dataHandles: [handle] };
    },
  },

  upsertSubscriber: {
    description:
      "GATED write. POST /api/subscribers; on HTTP 409 (duplicate email) " +
      "finds the row by email then PATCH (default, preserves list " +
      "membership) or PUT per `updateMethod`. dryRun (default true) looks up " +
      "the email (read-only) to report would-create vs would-update and " +
      "performs no mutating call.",
    arguments: upsertArgs,
    execute: async (
      args: z.infer<typeof upsertArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const doFetch = args._fetch as FetchLike | undefined;
      const sql = buildEmailQuery(args.email);

      let existingId: number | null = null;
      try {
        const found = await lmFetch(
          cfg,
          "GET",
          "api/subscribers",
          { query: [["query", sql]] },
          doFetch,
        );
        const row = extractRows(found.data)[0];
        if (row && typeof row.id === "number") existingId = row.id;
      } catch (e) {
        context.logger.warning(
          "upsertSubscriber: email lookup failed ({msg}); assuming create",
          { msg: (e as Error).message },
        );
      }

      if (cfg.dryRun) {
        const action = existingId !== null
          ? `would-update-${args.updateMethod}`
          : "would-create";
        context.logger.warning(
          "upsertSubscriber DRY RUN: {email} -> {action}",
          { email: args.email, action },
        );
        const handle = await context.writeResource(
          "subscriberUpsert",
          "subscriberUpsert",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            email: args.email,
            action,
            method: args.updateMethod,
            id: existingId,
          },
        );
        return { dataHandles: [handle] };
      }

      // --- live path ---
      let id = existingId;
      let action: string;
      if (existingId === null) {
        const createBody: Record<string, unknown> = { email: args.email };
        if (args.name !== undefined) createBody.name = args.name;
        if (args.attribs !== undefined) createBody.attribs = args.attribs;
        if (args.status !== undefined) createBody.status = args.status;
        if (args.listIds !== undefined) createBody.lists = args.listIds;
        try {
          const created = await lmFetch(
            cfg,
            "POST",
            "api/subscribers",
            { json: createBody },
            doFetch,
          );
          const row = (created.data ?? {}) as Record<string, unknown>;
          id = typeof row.id === "number" ? row.id : null;
          action = "created";
        } catch (e) {
          if (!isHttp409(e)) throw e;
          const refound = await lmFetch(
            cfg,
            "GET",
            "api/subscribers",
            { query: [["query", sql]] },
            doFetch,
          );
          const row = extractRows(refound.data)[0];
          if (!row || typeof row.id !== "number") {
            throw new Error(
              `upsertSubscriber: 409 creating ${args.email} but could not ` +
                "find the existing row by email afterward",
            );
          }
          id = row.id;
          action = await applySubscriberUpdate(cfg, id, args, doFetch);
        }
      } else {
        action = await applySubscriberUpdate(cfg, existingId, args, doFetch);
      }

      const handle = await context.writeResource(
        "subscriberUpsert",
        "subscriberUpsert",
        {
          retrievedAt: new Date().toISOString(),
          dryRun: false,
          email: args.email,
          action,
          method: args.updateMethod,
          id,
        },
      );
      return { dataHandles: [handle] };
    },
  },

  deleteSubscriber: {
    description:
      "GATED write. Verifies the subscriber exists (GET /api/subscribers/:id) " +
      "then DELETE /api/subscribers/:id. dryRun (default true) verifies only.",
    arguments: deleteArgs,
    execute: async (
      args: z.infer<typeof deleteArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const doFetch = args._fetch as FetchLike | undefined;
      const idStr = assertId(args.id, "subscriberId");
      const existing = await lmFetch(
        cfg,
        "GET",
        `api/subscribers/${idStr}`,
        {},
        doFetch,
      );
      const row = (existing.data ?? null) as Record<string, unknown> | null;
      if (!row) {
        // Already gone: a delete of a nonexistent subscriber is a no-op, not an
        // error, so reruns are idempotent (matches deleteTemplate).
        context.logger.warning(
          "deleteSubscriber: subscriber {id} not found — nothing to delete " +
            "(no-op)",
          { id: idStr },
        );
        const handle = await context.writeResource(
          "subscriberDelete",
          "subscriberDelete",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: cfg.dryRun,
            id: Number(idStr),
            email: null,
            action: "not-found",
          },
        );
        return { dataHandles: [handle] };
      }
      const email = typeof row.email === "string" ? row.email : null;

      if (cfg.dryRun) {
        context.logger.warning(
          "deleteSubscriber DRY RUN: would delete {id} ({email})",
          { id: idStr, email },
        );
        const handle = await context.writeResource(
          "subscriberDelete",
          "subscriberDelete",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            id: Number(idStr),
            email,
            action: "would-delete",
          },
        );
        return { dataHandles: [handle] };
      }

      await lmFetch(cfg, "DELETE", `api/subscribers/${idStr}`, {}, doFetch);
      const handle = await context.writeResource(
        "subscriberDelete",
        "subscriberDelete",
        {
          retrievedAt: new Date().toISOString(),
          dryRun: false,
          id: Number(idStr),
          email,
          action: "deleted",
        },
      );
      return { dataHandles: [handle] };
    },
  },

  manageSubscriberLists: {
    description:
      "GATED write. PUT /api/subscribers/lists — add/remove/unsubscribe a " +
      "set of subscribers from a set of lists WITHOUT a full subscriber " +
      "replace. `status` (subscription_status) only applies to action=add.",
    arguments: manageListsArgs,
    execute: async (
      args: z.infer<typeof manageListsArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const subscriberIds = args.subscriberIds.map((id) =>
        Number(assertId(id, "subscriberId"))
      );

      if (cfg.dryRun) {
        context.logger.warning(
          "manageSubscriberLists DRY RUN: {action} {n} subscribers x {m} lists",
          {
            action: args.action,
            n: subscriberIds.length,
            m: args.listIds.length,
          },
        );
        const handle = await context.writeResource(
          "subscriberLists",
          "subscriberLists",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            subscriberIds,
            listIds: args.listIds,
            action: args.action,
            status: args.status ?? null,
            applied: false,
          },
        );
        return { dataHandles: [handle] };
      }

      const body: Record<string, unknown> = {
        ids: subscriberIds,
        action: args.action,
        target_list_ids: args.listIds,
      };
      if (args.status !== undefined) body.status = args.status;
      await lmFetch(
        cfg,
        "PUT",
        "api/subscribers/lists",
        { json: body },
        args._fetch,
      );

      const handle = await context.writeResource(
        "subscriberLists",
        "subscriberLists",
        {
          retrievedAt: new Date().toISOString(),
          dryRun: false,
          subscriberIds,
          listIds: args.listIds,
          action: args.action,
          status: args.status ?? null,
          applied: true,
        },
      );
      return { dataHandles: [handle] };
    },
  },
};
