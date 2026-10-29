/**
 * @shrug/listmonk — Phase 2: lists domain (listLists/findListByName/getList,
 * upsertList/deleteList).
 *
 * Pinned v6.2.0 contract (see design/listmonk-extension.md + the method-level
 * docs below for the authoritative detail):
 *   - GET /api/lists is fetched with `minimal=true` (cheapest). Its `query=`
 *     param is FUZZY, so exact-name lookup is done CLIENT-SIDE after fetching;
 *     >1 exact match is ambiguous and throws.
 *   - POST /api/lists (lists:manage_all) only validates `name` (1-2000 chars)
 *     server-side; a bad type/optin/status enum 500s at the DB layer, so those
 *     are validated client-side BEFORE the request.
 *   - DELETE /api/lists/:id (list:manage) unlinks subscribers, it does not
 *     delete them. The id is verified to exist (GET) before DELETE.
 *   - PUT /api/lists/:id is a PARTIAL PATCH for name/type/optin/status/
 *     description: an EMPTY STRING field PRESERVES the existing value
 *     (`CASE WHEN ... != ''`). `tags` has NO such guard — it is ALWAYS
 *     overwritten wholesale. So upsertList always sends the intended `tags`
 *     array and may omit the other fields it isn't changing.
 */
import { z } from "npm:zod@4";
import {
  assertId,
  type ExecuteContext,
  type ExecuteResult,
  type FetchLike,
  lmFetch,
  lmFetchAll,
  type MethodMap,
  type ResourceMap,
} from "./http.ts";

// Exact lowercase enums (v6.2.0). A bad value past this point 500s at the DB.
const LIST_TYPES = ["public", "private"] as const;
const LIST_OPTINS = ["single", "double"] as const;
const LIST_STATUSES = ["active", "archived"] as const;

const ListTypeSchema = z.enum(LIST_TYPES);
const ListOptinSchema = z.enum(LIST_OPTINS);
const ListStatusSchema = z.enum(LIST_STATUSES);

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const ListSummarySchema = z.object({
  id: z.number(),
  uuid: z.string(),
  name: z.string(),
  type: z.string(),
  optin: z.string(),
  status: z.string(),
  tags: z.array(z.string()),
  subscriberCount: z.number().nullable(),
});

const ListsSchema = z.object({
  retrievedAt: z.string(),
  count: z.number(),
  lists: z.array(ListSummarySchema),
});

const ListSchema = z.object({
  retrievedAt: z.string(),
  found: z.boolean(),
  list: ListSummarySchema.nullable(),
  // Only set by findListByName when found===false or ambiguous info is useful.
  matchCount: z.number().optional(),
});

const ListUpsertSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  name: z.string(),
  // would-create | would-update | in-sync | created | updated | in-sync (live)
  action: z.string(),
  listId: z.number().nullable(),
  requestBody: z.record(z.string(), z.unknown()),
  // The per-field changes a would-update / updated action carries (empty for
  // in-sync and would-create). Each: { field, from (live), to (declared) }.
  changes: z.array(z.object({
    field: z.string(),
    from: z.unknown(),
    to: z.unknown(),
  })).optional(),
});

const ListDeleteSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  listId: z.number(),
  action: z.string(), // would-delete | deleted
  existed: z.boolean(),
});

export const listsResources: ResourceMap = {
  lists: {
    description:
      "All lists (minimal=true summaries): id,uuid,name,type,optin,status," +
      "tags,subscriberCount. Written by listLists.",
    schema: ListsSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  list: {
    description:
      "A single list lookup result (by id via getList, or by exact name via " +
      "findListByName). `found:false` with `list:null` means no match.",
    schema: ListSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  listUpsert: {
    description:
      "Audit of an upsertList run: the resolved create/update plan or the " +
      "live create/update result. Never carries secrets.",
    schema: ListUpsertSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  listDelete: {
    description:
      "Audit of a deleteList run: the resolved delete plan or the live " +
      "delete result.",
    schema: ListDeleteSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Shape a raw listmonk list row into the resource's list-summary fields. */
export function summarizeList(raw: Record<string, unknown>) {
  return {
    id: Number(raw.id),
    uuid: String(raw.uuid ?? ""),
    name: String(raw.name ?? ""),
    type: String(raw.type ?? ""),
    optin: String(raw.optin ?? ""),
    status: String(raw.status ?? ""),
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : [],
    subscriberCount: typeof raw.subscriber_count === "number"
      ? raw.subscriber_count
      : null,
  };
}

/**
 * Exact-match a list by name against a set of raw listmonk list rows.
 * `GET /api/lists?query=` is FUZZY, so callers fetch broadly and use this to
 * find the exact match client-side. Throws if more than one row has the
 * exact (case-sensitive) name — list names are NOT unique in listmonk, so an
 * ambiguous match must not silently pick one.
 */
export function findExactListMatch(
  rows: Array<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | null {
  const matches = rows.filter((r) => r.name === name);
  if (matches.length > 1) {
    throw new Error(
      `ambiguous list name "${name}": ${matches.length} lists share this ` +
        "exact name (list names are not unique in listmonk) — resolve by id " +
        "instead",
    );
  }
  return matches[0] ?? null;
}

/**
 * Validate the enum fields destined for a list create/update body. listmonk
 * only validates `name` server-side on POST /api/lists; a bad type/optin/
 * status value 500s at the DB layer instead of a clean 4xx, so these are
 * checked client-side before any request is sent.
 */
export function validateListEnums(fields: {
  type?: string;
  optin?: string;
  status?: string;
}): void {
  if (fields.type !== undefined) ListTypeSchema.parse(fields.type);
  if (fields.optin !== undefined) ListOptinSchema.parse(fields.optin);
  if (fields.status !== undefined) ListStatusSchema.parse(fields.status);
}

/**
 * Build the PUT /api/lists/:id body for an update. `tags` is ALWAYS included
 * (no empty-string-preserve guard server-side — it is unconditionally
 * overwritten). The other fields are included ONLY when the caller actually
 * supplied them, so an omitted field relies on listmonk's own
 * empty-string-preserve PATCH semantics rather than us sending a value at all.
 */
export function buildUpdateBody(args: {
  name?: string;
  type?: string;
  optin?: string;
  status?: string;
  description?: string;
  tags: string[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = { tags: args.tags };
  if (args.name !== undefined) body.name = args.name;
  if (args.type !== undefined) body.type = args.type;
  if (args.optin !== undefined) body.optin = args.optin;
  if (args.status !== undefined) body.status = args.status;
  if (args.description !== undefined) body.description = args.description;
  return body;
}

export interface ListChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Order-insensitive tag-set equality (listmonk stores tags as an array). */
function tagsEqual(have: unknown, want: string[]): boolean {
  const a = (Array.isArray(have) ? (have as unknown[]).map(String) : [])
    .slice().sort();
  const b = want.slice().sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Field-diff a DECLARED list spec against the existing live row, so upsertList
 * can report `in-sync` (and skip a redundant PUT) instead of a blanket
 * `would-update`. DECLARED-SUBSET: only fields the caller actually supplied are
 * compared (an omitted scalar is not drift). `tags` is always declared
 * (default []) and compared as a SET — listmonk overwrites tags unconditionally,
 * so a differing set is a real change and the same set is a no-op. `name` is not
 * compared (the row was matched BY exact name, so it is equal by construction).
 *
 * `description` is only meaningful when `existing` carries it — a minimal list
 * summary (what listLists/upsertList's broad fetch returns) does NOT include
 * description, so the caller must pass a FULL list row (GET /api/lists/:id) when
 * `desired.description` is set, or the diff would false-positive.
 */
export function computeListDrift(
  existing: Record<string, unknown>,
  desired: {
    name: string;
    type?: string;
    optin?: string;
    status?: string;
    description?: string;
    tags: string[];
  },
): { inSync: boolean; changes: ListChange[] } {
  const changes: ListChange[] = [];
  const scalar = (field: string, want?: string) => {
    if (want === undefined) return;
    const have = existing[field];
    if (String(have ?? "") !== want) {
      changes.push({ field, from: have ?? null, to: want });
    }
  };
  scalar("type", desired.type);
  scalar("optin", desired.optin);
  scalar("status", desired.status);
  scalar("description", desired.description);
  if (!tagsEqual(existing.tags, desired.tags)) {
    changes.push({
      field: "tags",
      from: Array.isArray(existing.tags) ? existing.tags : [],
      to: desired.tags,
    });
  }
  return { inSync: changes.length === 0, changes };
}

/** Build the POST /api/lists body for a create. */
export function buildCreateBody(args: {
  name: string;
  type?: string;
  optin?: string;
  status?: string;
  description?: string;
  tags: string[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: args.name,
    tags: args.tags,
  };
  if (args.type !== undefined) body.type = args.type;
  if (args.optin !== undefined) body.optin = args.optin;
  if (args.status !== undefined) body.status = args.status;
  if (args.description !== undefined) body.description = args.description;
  return body;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const listsMethods: MethodMap = {
  listLists: {
    description:
      "GET /api/lists (minimal=true, paginated via lmFetchAll) — every list " +
      "as a summary. Write the `lists` resource.",
    arguments: z.object({}),
    execute: async (
      args: { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      context.logger.info("Listing all lists (GET /api/lists, minimal=true)");
      const rows = await lmFetchAll(
        cfg,
        "api/lists",
        [["minimal", "true"]],
        args._fetch,
        context.logger,
      );
      const lists = rows.map(summarizeList);
      const handle = await context.writeResource("lists", "lists", {
        retrievedAt: new Date().toISOString(),
        count: lists.length,
        lists,
      });
      return { dataHandles: [handle] };
    },
  },

  findListByName: {
    description:
      "Find a list by EXACT name (client-side match over GET /api/lists; " +
      "the server `query=` param is fuzzy). Throws if more than one list " +
      "shares the exact name (list names are not unique in listmonk). " +
      "Writes a `list` resource — found:false/list:null when no match.",
    arguments: z.object({
      name: z.string().min(1).describe("Exact list name to match."),
    }),
    execute: async (
      args: { name: string; _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      context.logger.info("Finding list by exact name {name}", {
        name: args.name,
      });
      const rows = await lmFetchAll(
        cfg,
        "api/lists",
        [["minimal", "true"]],
        args._fetch,
        context.logger,
      );
      const match = findExactListMatch(rows, args.name);
      const handle = await context.writeResource("list", "list", {
        retrievedAt: new Date().toISOString(),
        found: match !== null,
        list: match ? summarizeList(match) : null,
      });
      return { dataHandles: [handle] };
    },
  },

  getList: {
    description: "GET /api/lists/:id. Writes a `list` resource.",
    arguments: z.object({
      listId: z.union([z.number(), z.string()]).describe(
        "The list id (positive integer).",
      ),
    }),
    execute: async (
      args: { listId: number | string; _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.listId, "listId");
      context.logger.info("Getting list {id}", { id });
      const json = await lmFetch(
        cfg,
        "GET",
        `api/lists/${id}`,
        {},
        args._fetch,
      );
      const raw = (json.data ?? null) as Record<string, unknown> | null;
      const handle = await context.writeResource("list", "list", {
        retrievedAt: new Date().toISOString(),
        found: raw !== null,
        list: raw ? summarizeList(raw) : null,
      });
      return { dataHandles: [handle] };
    },
  },

  upsertList: {
    description:
      "Find a list by exact name; POST /api/lists if absent, PUT /api/" +
      "lists/:id if present. When the list already exists the declared " +
      "fields are DIFFED against it: an exact match is reported `in-sync` " +
      "and the redundant PUT is SKIPPED (the audit's `changes` is empty); " +
      "otherwise `would-update`/`updated` carries the per-field `changes`. " +
      "`tags` is ALWAYS sent in full on a real update (listmonk " +
      "unconditionally overwrites it, no empty-string-preserve guard) and " +
      "is diffed as a SET — other fields are included only when the caller " +
      "supplies them, relying on listmonk's own empty-string-preserve PATCH " +
      "semantics for the rest. `description` isn't in the minimal list fetch, " +
      "so a full GET /api/lists/:id is made to diff it when declared. " +
      "type/optin/status are validated client-side before any request (a bad " +
      "value 500s at the DB layer server-side). Gated by dryRun (default " +
      "true): a dry run resolves the plan and writes a preview with NO " +
      "mutating HTTP call.",
    arguments: z.object({
      name: z.string().min(1).max(2000).describe("Exact list name."),
      type: ListTypeSchema.optional().describe("public | private."),
      optin: ListOptinSchema.optional().describe("single | double."),
      status: ListStatusSchema.optional().describe("active | archived."),
      description: z.string().optional(),
      tags: z.array(z.string()).default([]).describe(
        "ALWAYS sent in full on update — listmonk overwrites tags " +
          "unconditionally, there is no partial-merge.",
      ),
    }),
    execute: async (
      args: {
        name: string;
        type?: string;
        optin?: string;
        status?: string;
        description?: string;
        tags: string[];
        _fetch?: FetchLike;
      },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      validateListEnums(args);

      const rows = await lmFetchAll(
        cfg,
        "api/lists",
        [["minimal", "true"]],
        args._fetch,
        context.logger,
      );
      const existing = findExactListMatch(rows, args.name);

      // When the list exists, field-diff the declared spec against it so we
      // report in-sync (and skip a redundant PUT) instead of a blanket update.
      // `description` is absent from the minimal fetch, so pull the full row
      // when it is declared, else the diff would false-positive on it.
      let drift: { inSync: boolean; changes: ListChange[] } | null = null;
      if (existing) {
        let full = existing;
        if (args.description !== undefined) {
          const id = assertId(existing.id as number | string, "listId");
          const got = await lmFetch(
            cfg,
            "GET",
            `api/lists/${id}`,
            {},
            args._fetch,
          );
          full = (got.data ?? existing) as Record<string, unknown>;
        }
        drift = computeListDrift(full, args);
      }

      if (cfg.dryRun) {
        const requestBody = existing
          ? buildUpdateBody(args)
          : buildCreateBody(args);
        const action = existing
          ? (drift!.inSync ? "in-sync" : "would-update")
          : "would-create";
        context.logger.warning(
          'upsertList DRY RUN: {action} "{name}"; no writes',
          { action, name: args.name },
        );
        const h = await context.writeResource("listUpsert", "listUpsert", {
          retrievedAt: new Date().toISOString(),
          dryRun: true,
          name: args.name,
          action,
          listId: existing ? Number(existing.id) : null,
          requestBody,
          changes: drift ? drift.changes : [],
        });
        return { dataHandles: [h] };
      }

      // --- live path ---
      if (existing) {
        const id = assertId(existing.id as number | string, "listId");
        const body = buildUpdateBody(args);
        // Already converged: skip the redundant PUT (mirrors reconcileSettings'
        // no-op-when-in-sync behavior) and record it as a no-op.
        if (drift!.inSync) {
          context.logger.info(
            'List {id} "{name}" already in sync; no write',
            { id, name: args.name },
          );
          const h = await context.writeResource("listUpsert", "listUpsert", {
            retrievedAt: new Date().toISOString(),
            dryRun: false,
            name: args.name,
            action: "in-sync",
            listId: Number(existing.id),
            requestBody: body,
            changes: [],
          });
          return { dataHandles: [h] };
        }
        context.logger.info('Updating list {id} "{name}"', {
          id,
          name: args.name,
        });
        await lmFetch(
          cfg,
          "PUT",
          `api/lists/${id}`,
          { json: body },
          args._fetch,
        );
        const h = await context.writeResource("listUpsert", "listUpsert", {
          retrievedAt: new Date().toISOString(),
          dryRun: false,
          name: args.name,
          action: "updated",
          listId: Number(existing.id),
          requestBody: body,
          changes: drift!.changes,
        });
        return { dataHandles: [h] };
      }

      const body = buildCreateBody(args);
      context.logger.info('Creating list "{name}"', { name: args.name });
      const created = await lmFetch(
        cfg,
        "POST",
        "api/lists",
        { json: body },
        args._fetch,
      );
      const createdRow = (created.data ?? {}) as Record<string, unknown>;
      const newId = typeof createdRow.id === "number" ? createdRow.id : null;
      const h = await context.writeResource("listUpsert", "listUpsert", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        name: args.name,
        action: "created",
        listId: newId,
        requestBody: body,
      });
      return { dataHandles: [h] };
    },
  },

  deleteList: {
    description:
      "Verify the list exists (GET /api/lists/:id) then DELETE /api/lists/" +
      ":id. This UNLINKS subscribers from the list, it does NOT delete " +
      "the subscribers themselves. Gated by dryRun (default true): a dry " +
      "run verifies existence and writes a would-delete preview with no " +
      "mutating HTTP call.",
    arguments: z.object({
      listId: z.union([z.number(), z.string()]).describe(
        "The list id (positive integer) to delete.",
      ),
    }),
    execute: async (
      args: { listId: number | string; _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.listId, "listId");

      let existed = true;
      try {
        await lmFetch(cfg, "GET", `api/lists/${id}`, {}, args._fetch);
      } catch (e) {
        existed = false;
        context.logger.warning(
          "deleteList: list {id} does not exist (or is unreachable): {err}",
          { id, err: (e as Error).message },
        );
      }

      if (cfg.dryRun) {
        context.logger.warning(
          "deleteList DRY RUN: would DELETE list {id} (existed={existed}); " +
            "no writes",
          { id, existed },
        );
        const h = await context.writeResource("listDelete", "listDelete", {
          retrievedAt: new Date().toISOString(),
          dryRun: true,
          listId: Number(id),
          action: "would-delete",
          existed,
        });
        return { dataHandles: [h] };
      }

      if (!existed) {
        // Already gone: a delete of a nonexistent list is a no-op, not an
        // error, so reruns are idempotent (matches deleteTemplate).
        context.logger.warning(
          "deleteList: list {id} not found — nothing to delete (no-op)",
          { id },
        );
        const h = await context.writeResource("listDelete", "listDelete", {
          retrievedAt: new Date().toISOString(),
          dryRun: false,
          listId: Number(id),
          action: "not-found",
          existed: false,
        });
        return { dataHandles: [h] };
      }

      context.logger.info("Deleting list {id}", { id });
      await lmFetch(cfg, "DELETE", `api/lists/${id}`, {}, args._fetch);
      const h = await context.writeResource("listDelete", "listDelete", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        listId: Number(id),
        action: "deleted",
        existed: true,
      });
      return { dataHandles: [h] };
    },
  },
};
