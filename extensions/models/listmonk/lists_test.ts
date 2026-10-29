/**
 * Unit tests for the @shrug/listmonk lists module.
 *
 * Every test injects a synthetic scripted `_fetch` (the `FetchLike` seam) —
 * no live listmonk instance is ever contacted. Fixtures are depersonalized
 * (generic list/field names, example.com-style data only).
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import type { ExecuteContext, FetchLike, MethodLogger } from "./http.ts";
import {
  buildCreateBody,
  buildUpdateBody,
  computeListDrift,
  findExactListMatch,
  listsMethods,
  summarizeList,
  validateListEnums,
} from "./lists.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  status?: number;
  body: unknown;
}

interface RecordedCall {
  url: string;
  method?: string;
  body?: unknown;
}

/** A sequential scripted fetch — each call consumes the next response. */
function sequentialFetch(
  responses: ScriptedResponse[],
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn: FetchLike = (input, init) => {
    const parsedBody = typeof init?.body === "string"
      ? JSON.parse(init.body)
      : undefined;
    calls.push({ url: input, method: init?.method, body: parsedBody });
    const r = responses[i++];
    if (!r) {
      throw new Error(
        `sequentialFetch: no more scripted responses (call #${i} to ${input})`,
      );
    }
    const status = r.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? "OK" : "Error",
      text: () => Promise.resolve(JSON.stringify(r.body)),
      headers: { get: (_name: string) => null },
    });
  };
  return { fetch: fetchFn, calls };
}

const quietLogger: MethodLogger = {
  debug() {},
  info() {},
  warning() {},
  error() {},
};

interface WrittenResource {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

function makeContext(
  globalArgsOverride: Partial<ExecuteContext["globalArgs"]> = {},
): { context: ExecuteContext; written: WrittenResource[] } {
  const written: WrittenResource[] = [];
  const context: ExecuteContext = {
    globalArgs: {
      baseUrl: "https://listmonk.example.com",
      apiUser: "ops",
      apiToken: "secret-token",
      perPage: 100,
      dryRun: true,
      maxRetries: 0,
      ...globalArgsOverride,
    },
    logger: quietLogger,
    writeResource: (specName, name, data) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

function listRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    uuid: "11111111-1111-1111-1111-111111111111",
    name: "Example List",
    type: "public",
    optin: "single",
    status: "active",
    tags: ["demo"],
    subscriber_count: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("summarizeList — maps snake_case subscriber_count and defaults", () => {
  const s = summarizeList(listRow());
  assertEquals(s, {
    id: 1,
    uuid: "11111111-1111-1111-1111-111111111111",
    name: "Example List",
    type: "public",
    optin: "single",
    status: "active",
    tags: ["demo"],
    subscriberCount: 5,
  });
});

Deno.test("summarizeList — missing/non-numeric subscriber_count -> null, missing tags -> []", () => {
  const s = summarizeList({ id: 2, name: "Bare" });
  assertEquals(s.subscriberCount, null);
  assertEquals(s.tags, []);
});

Deno.test("findExactListMatch — no match returns null", () => {
  const rows = [listRow({ name: "Other" })];
  assertEquals(findExactListMatch(rows, "Example List"), null);
});

Deno.test("findExactListMatch — single exact match returns the row", () => {
  const rows = [listRow({ name: "Other" }), listRow({ id: 2, name: "Target" })];
  const match = findExactListMatch(rows, "Target");
  assertEquals(match?.id, 2);
});

Deno.test("findExactListMatch — ambiguous (>1 same-name) throws", () => {
  const rows = [
    listRow({ id: 1, name: "Dup" }),
    listRow({ id: 2, name: "Dup" }),
  ];
  assertThrows(
    () => findExactListMatch(rows, "Dup"),
    Error,
    "ambiguous list name",
  );
});

Deno.test("validateListEnums — accepts valid lowercase enums", () => {
  validateListEnums({ type: "public", optin: "double", status: "archived" });
  // no throw => pass
});

Deno.test("validateListEnums — rejects bad type/optin/status before any request", () => {
  assertThrows(() => validateListEnums({ type: "PUBLIC" }));
  assertThrows(() => validateListEnums({ optin: "triple" }));
  assertThrows(() => validateListEnums({ status: "deleted" }));
});

Deno.test("buildUpdateBody — tags always included; other fields only when supplied", () => {
  const body = buildUpdateBody({ tags: ["a", "b"] });
  assertEquals(body, { tags: ["a", "b"] });

  const full = buildUpdateBody({
    name: "New Name",
    type: "private",
    optin: "double",
    status: "archived",
    description: "desc",
    tags: [],
  });
  assertEquals(full, {
    tags: [],
    name: "New Name",
    type: "private",
    optin: "double",
    status: "archived",
    description: "desc",
  });
});

Deno.test("buildCreateBody — includes name + tags, optional fields only when supplied", () => {
  const minimal = buildCreateBody({ name: "N", tags: [] });
  assertEquals(minimal, { name: "N", tags: [] });

  const full = buildCreateBody({
    name: "N",
    type: "public",
    optin: "single",
    status: "active",
    description: "d",
    tags: ["x"],
  });
  assertEquals(full, {
    name: "N",
    tags: ["x"],
    type: "public",
    optin: "single",
    status: "active",
    description: "d",
  });
});

// ---------------------------------------------------------------------------
// listLists
// ---------------------------------------------------------------------------

Deno.test("listLists — writes a `lists` resource from a paginated envelope", async () => {
  const { fetch, calls } = sequentialFetch([
    {
      body: {
        data: {
          results: [listRow(), listRow({ id: 2, name: "Second" })],
          total: 2,
        },
      },
    },
  ]);
  const { context, written } = makeContext();
  const res = await listsMethods.listLists.execute({ _fetch: fetch }, context);
  assertEquals(res.dataHandles, [{ name: "lists" }]);
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "lists");
  assertEquals(written[0].data.count, 2);
  assertEquals((written[0].data.lists as unknown[]).length, 2);
  // sanity: minimal=true was requested
  assert(calls[0].url.includes("minimal=true"));
});

Deno.test("listLists — bare empty-array envelope -> zero lists, no error", async () => {
  const { fetch } = sequentialFetch([{ body: { data: [] } }]);
  const { context, written } = makeContext();
  await listsMethods.listLists.execute({ _fetch: fetch }, context);
  assertEquals(written[0].data.count, 0);
  assertEquals(written[0].data.lists, []);
});

// ---------------------------------------------------------------------------
// findListByName
// ---------------------------------------------------------------------------

Deno.test("findListByName — found: writes found:true + the summarized list", async () => {
  const { fetch } = sequentialFetch([
    { body: { data: { results: [listRow({ name: "Target" })], total: 1 } } },
  ]);
  const { context, written } = makeContext();
  await listsMethods.findListByName.execute(
    { name: "Target", _fetch: fetch },
    context,
  );
  assertEquals(written[0].data.found, true);
  assertEquals(
    (written[0].data.list as Record<string, unknown>).name,
    "Target",
  );
});

Deno.test("findListByName — not found: writes found:false, list:null", async () => {
  const { fetch } = sequentialFetch([
    { body: { data: { results: [listRow({ name: "Other" })], total: 1 } } },
  ]);
  const { context, written } = makeContext();
  await listsMethods.findListByName.execute(
    { name: "Missing", _fetch: fetch },
    context,
  );
  assertEquals(written[0].data.found, false);
  assertEquals(written[0].data.list, null);
});

Deno.test("findListByName — ambiguous exact-name match rejects", async () => {
  const { fetch } = sequentialFetch([
    {
      body: {
        data: {
          results: [
            listRow({ id: 1, name: "Dup" }),
            listRow({ id: 2, name: "Dup" }),
          ],
          total: 2,
        },
      },
    },
  ]);
  const { context } = makeContext();
  await assertRejects(
    () =>
      listsMethods.findListByName.execute(
        { name: "Dup", _fetch: fetch },
        context,
      ),
    Error,
    "ambiguous list name",
  );
});

// ---------------------------------------------------------------------------
// getList
// ---------------------------------------------------------------------------

Deno.test("getList — GET /api/lists/:id writes the summarized list", async () => {
  const { fetch, calls } = sequentialFetch([{
    body: { data: listRow({ id: 7 }) },
  }]);
  const { context, written } = makeContext();
  await listsMethods.getList.execute({ listId: 7, _fetch: fetch }, context);
  assertEquals(written[0].data.found, true);
  assertEquals((written[0].data.list as Record<string, unknown>).id, 7);
  assert(calls[0].url.endsWith("/api/lists/7"));
});

Deno.test("getList — invalid id rejects via assertId before any fetch", async () => {
  const { fetch, calls } = sequentialFetch([{ body: { data: listRow() } }]);
  const { context } = makeContext();
  await assertRejects(
    () =>
      listsMethods.getList.execute(
        { listId: "1;drop table", _fetch: fetch },
        context,
      ),
    Error,
    "invalid listId",
  );
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// upsertList — dryRun (default) gate
// ---------------------------------------------------------------------------

Deno.test("upsertList — dryRun true, no existing list: would-create preview, zero mutating calls", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { results: [], total: 0 } } },
  ]);
  const { context, written } = makeContext({ dryRun: true });
  await listsMethods.upsertList.execute(
    { name: "Fresh List", tags: ["a"], _fetch: fetch },
    context,
  );
  assertEquals(written[0].data.action, "would-create");
  assertEquals(written[0].data.listId, null);
  assertEquals(written[0].data.dryRun, true);
  assertEquals(
    written[0].data.requestBody,
    { name: "Fresh List", tags: ["a"] },
  );
  // only the lookup GET happened; no POST/PUT.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
});

Deno.test("upsertList — dryRun true, existing list: would-update preview carries full tags + only changed fields", async () => {
  const { fetch, calls } = sequentialFetch([
    {
      body: {
        data: { results: [listRow({ id: 9, name: "Existing" })], total: 1 },
      },
    },
  ]);
  const { context, written } = makeContext({ dryRun: true });
  await listsMethods.upsertList.execute(
    { name: "Existing", status: "archived", tags: ["new-tag"], _fetch: fetch },
    context,
  );
  assertEquals(written[0].data.action, "would-update");
  assertEquals(written[0].data.listId, 9);
  // `name` is always present here because it is the required lookup key the
  // method's args schema demands (not an "omitted/unchanged" field) — it is
  // harmlessly re-sent as-is alongside the one field actually being changed.
  assertEquals(
    written[0].data.requestBody,
    { tags: ["new-tag"], name: "Existing", status: "archived" },
  );
  assertEquals(calls.length, 1);
});

Deno.test("upsertList — bad enum value rejects before any HTTP call (dryRun or not)", async () => {
  const { fetch, calls } = sequentialFetch([]);
  const { context } = makeContext({ dryRun: true });
  await assertRejects(() =>
    listsMethods.upsertList.execute(
      { name: "X", type: "PUBLIC" as never, tags: [], _fetch: fetch },
      context,
    )
  );
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// upsertList — live path (dryRun:false)
// ---------------------------------------------------------------------------

Deno.test("upsertList — dryRun false, no existing list: POSTs create body, returns new id", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { results: [], total: 0 } } }, // lookup
    { body: { data: listRow({ id: 42, name: "Fresh List" }) } }, // POST response
  ]);
  const { context, written } = makeContext({ dryRun: false });
  await listsMethods.upsertList.execute(
    { name: "Fresh List", type: "public", tags: ["a"], _fetch: fetch },
    context,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, "POST");
  assertEquals(calls[1].body, {
    name: "Fresh List",
    tags: ["a"],
    type: "public",
  });
  assertEquals(written[0].data.action, "created");
  assertEquals(written[0].data.listId, 42);
  assertEquals(written[0].data.dryRun, false);
});

Deno.test("upsertList — dryRun false, existing list: PUTs update body with tags always present, omitted fields excluded", async () => {
  const { fetch, calls } = sequentialFetch([
    {
      body: {
        data: { results: [listRow({ id: 9, name: "Existing" })], total: 1 },
      },
    }, // lookup
    { body: { data: listRow({ id: 9, name: "Existing" }) } }, // PUT response
  ]);
  const { context, written } = makeContext({ dryRun: false });
  await listsMethods.upsertList.execute(
    { name: "Existing", tags: [], _fetch: fetch },
    context,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, "PUT");
  assert(calls[1].url.endsWith("/api/lists/9"));
  // `tags` is always sent; `name` is always sent too (it's the required
  // lookup key, re-affirmed as-is); no other optional field was supplied.
  assertEquals(calls[1].body, { tags: [], name: "Existing" });
  assertEquals(written[0].data.action, "updated");
  assertEquals(written[0].data.listId, 9);
});

// ---------------------------------------------------------------------------
// deleteList
// ---------------------------------------------------------------------------

Deno.test("deleteList — dryRun true, list exists: would-delete preview, no DELETE call", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: listRow({ id: 5 }) } }, // existence GET
  ]);
  const { context, written } = makeContext({ dryRun: true });
  await listsMethods.deleteList.execute({ listId: 5, _fetch: fetch }, context);
  assertEquals(written[0].data.action, "would-delete");
  assertEquals(written[0].data.existed, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
});

Deno.test("deleteList — dryRun true, list absent (404): would-delete with existed:false, no DELETE call", async () => {
  const { fetch, calls } = sequentialFetch([
    { status: 404, body: { message: "list not found" } },
  ]);
  const { context, written } = makeContext({ dryRun: true });
  await listsMethods.deleteList.execute(
    { listId: 999, _fetch: fetch },
    context,
  );
  assertEquals(written[0].data.existed, false);
  assertEquals(written[0].data.action, "would-delete");
  assertEquals(calls.length, 1);
});

Deno.test("deleteList — dryRun false, list exists: GET verify then DELETE", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: listRow({ id: 5 }) } }, // existence GET
    { body: { data: true } }, // DELETE response
  ]);
  const { context, written } = makeContext({ dryRun: false });
  await listsMethods.deleteList.execute({ listId: 5, _fetch: fetch }, context);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, "DELETE");
  assert(calls[1].url.endsWith("/api/lists/5"));
  assertEquals(written[0].data.action, "deleted");
  assertEquals(written[0].data.existed, true);
});

Deno.test("deleteList — dryRun false, list absent: graceful no-op, never attempts DELETE", async () => {
  const { fetch, calls } = sequentialFetch([
    { status: 404, body: { message: "list not found" } }, // existence GET only
  ]);
  const { context, written } = makeContext({ dryRun: false });
  await listsMethods.deleteList.execute(
    { listId: 999, _fetch: fetch },
    context,
  );
  // Already-gone delete is an idempotent no-op: not-found written, no throw.
  assertEquals(written[0].data.action, "not-found");
  assertEquals(written[0].data.existed, false);
  // Only the existence-check GET fired; a second (DELETE) call would have
  // thrown the "no more scripted responses" error from sequentialFetch
  // instead, so this also proves DELETE was never attempted.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
});

Deno.test("deleteList — invalid id rejects via assertId before any fetch", async () => {
  const { fetch, calls } = sequentialFetch([]);
  const { context } = makeContext();
  await assertRejects(
    () =>
      listsMethods.deleteList.execute(
        { listId: "not-an-id", _fetch: fetch },
        context,
      ),
    Error,
    "invalid listId",
  );
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// computeListDrift — pure field-diff
// ---------------------------------------------------------------------------

Deno.test("computeListDrift — all declared fields match: in-sync, no changes", () => {
  const row = listRow({ id: 9, name: "Existing" }); // active/single/public/["demo"]
  const d = computeListDrift(row, {
    name: "Existing",
    type: "public",
    optin: "single",
    status: "active",
    tags: ["demo"],
  });
  assertEquals(d.inSync, true);
  assertEquals(d.changes, []);
});

Deno.test("computeListDrift — a drifting scalar is reported with from/to", () => {
  const row = listRow({ id: 9, name: "Existing" });
  const d = computeListDrift(row, {
    name: "Existing",
    status: "archived",
    tags: ["demo"],
  });
  assertEquals(d.inSync, false);
  assertEquals(d.changes, [{
    field: "status",
    from: "active",
    to: "archived",
  }]);
});

Deno.test("computeListDrift — tags compared as a SET (order-insensitive)", () => {
  const row = listRow({ tags: ["a", "b"] });
  assertEquals(
    computeListDrift(row, { name: "x", tags: ["b", "a"] }).inSync,
    true,
  );
  const drift = computeListDrift(row, { name: "x", tags: ["a"] });
  assertEquals(drift.inSync, false);
  assertEquals(drift.changes[0].field, "tags");
});

Deno.test("computeListDrift — undeclared scalar is not drift (declared-subset)", () => {
  // status differs live (archived) but is NOT declared -> not reported.
  const row = listRow({ status: "archived", tags: ["demo"] });
  const d = computeListDrift(row, {
    name: "x",
    type: "public",
    tags: ["demo"],
  });
  assertEquals(d.inSync, true);
});

Deno.test("computeListDrift — description diffs when the row carries it", () => {
  const row = listRow({ description: "Old blurb", tags: ["demo"] });
  const same = computeListDrift(row, {
    name: "x",
    description: "Old blurb",
    tags: ["demo"],
  });
  assertEquals(same.inSync, true);
  const diff = computeListDrift(row, {
    name: "x",
    description: "New blurb",
    tags: ["demo"],
  });
  assertEquals(diff.inSync, false);
  assertEquals(diff.changes[0].field, "description");
});

// ---------------------------------------------------------------------------
// upsertList — diff-aware in-sync (dry + live skip redundant PUT)
// ---------------------------------------------------------------------------

Deno.test("upsertList — dryRun true, existing list already converged: in-sync, empty changes, no PUT", async () => {
  const { fetch, calls } = sequentialFetch([
    {
      body: {
        data: { results: [listRow({ id: 9, name: "Existing" })], total: 1 },
      },
    },
  ]);
  const { context, written } = makeContext({ dryRun: true });
  await listsMethods.upsertList.execute(
    {
      name: "Existing",
      type: "public",
      optin: "single",
      status: "active",
      tags: ["demo"],
      _fetch: fetch,
    },
    context,
  );
  assertEquals(written[0].data.action, "in-sync");
  assertEquals(written[0].data.changes, []);
  assertEquals(written[0].data.listId, 9);
  assertEquals(calls.length, 1); // lookup only
});

Deno.test("upsertList — dryRun true, existing with drift: would-update carries per-field changes", async () => {
  const { fetch } = sequentialFetch([
    {
      body: {
        data: { results: [listRow({ id: 9, name: "Existing" })], total: 1 },
      },
    },
  ]);
  const { context, written } = makeContext({ dryRun: true });
  await listsMethods.upsertList.execute(
    { name: "Existing", status: "archived", tags: ["demo"], _fetch: fetch },
    context,
  );
  assertEquals(written[0].data.action, "would-update");
  assertEquals(written[0].data.changes, [{
    field: "status",
    from: "active",
    to: "archived",
  }]);
});

Deno.test("upsertList — dryRun false, existing already converged: SKIPS the PUT (no-op), action in-sync", async () => {
  // Only ONE fetch is queued: if the method attempted a PUT, sequentialFetch
  // would run dry and throw — so a passing test proves no second call.
  const { fetch, calls } = sequentialFetch([
    {
      body: {
        data: { results: [listRow({ id: 9, name: "Existing" })], total: 1 },
      },
    },
  ]);
  const { context, written } = makeContext({ dryRun: false });
  await listsMethods.upsertList.execute(
    {
      name: "Existing",
      type: "public",
      optin: "single",
      status: "active",
      tags: ["demo"],
      _fetch: fetch,
    },
    context,
  );
  assertEquals(calls.length, 1); // lookup only — no PUT
  assertEquals(written[0].data.action, "in-sync");
  assertEquals(written[0].data.dryRun, false);
});

Deno.test("upsertList — declared description triggers a full GET to diff it, then in-sync", async () => {
  const { fetch, calls } = sequentialFetch([
    {
      body: {
        data: { results: [listRow({ id: 9, name: "Existing" })], total: 1 },
      },
    }, // minimal lookup
    {
      body: {
        data: listRow({ id: 9, name: "Existing", description: "Hello" }),
      },
    }, // full GET
  ]);
  const { context, written } = makeContext({ dryRun: true });
  await listsMethods.upsertList.execute(
    {
      name: "Existing",
      type: "public",
      optin: "single",
      status: "active",
      description: "Hello",
      tags: ["demo"],
      _fetch: fetch,
    },
    context,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, "GET");
  assert(calls[1].url.endsWith("/api/lists/9"));
  assertEquals(written[0].data.action, "in-sync");
});
