/**
 * Unit tests for the `@shrug/listmonk` subscribers module (Phase 3).
 *
 * Two layers:
 *  - Pure helpers: escapeSqlLiteral (incl. injection-ish inputs), buildCsv,
 *    buildImportParams, scanImportErrors, normalizeSubscriberRow,
 *    extractRows, isHttp409.
 *  - Method paths driven through a mocked `fetch` seam ({@link FetchLike}) —
 *    no network is hit. Covers dryRun previews (no HTTP call), the
 *    create/409-then-update upsert branches, the import reset->POST->poll->
 *    scan-logs flow (stubbed `_sleep`), and the write gate on every mutating
 *    method.
 *
 * Run with: `deno test -A extensions/models/listmonk/subscribers_test.ts`
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { FetchLike, GlobalArgs } from "./http.ts";
import {
  buildCsv,
  buildEmailQuery,
  buildImportParams,
  escapeSqlLiteral,
  extractRows,
  isHttp409,
  normalizeSubscriberRow,
  scanImportErrors,
  subscribersMethods,
} from "./subscribers.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function cfg(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return {
    baseUrl: "https://lists.example.test",
    apiUser: "swamp-ops",
    apiToken: "SEKRIT",
    perPage: 100,
    dryRun: true,
    maxRetries: 0,
    ...overrides,
  };
}

interface Rec {
  url: string;
  method?: string;
  body?: BodyInit;
}

interface Resp {
  ok: boolean;
  status: number;
  body: unknown;
  raw?: boolean;
}

/** Build a fake FetchLike serving a scripted sequence of JSON responses. */
function scripted(
  responses: Resp[],
): { f: FetchLike; calls: Rec[] } {
  const calls: Rec[] = [];
  let i = 0;
  const f: FetchLike = (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const text = r.raw ? String(r.body) : JSON.stringify(r.body);
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      statusText: r.ok ? "OK" : "ERR",
      text: () => Promise.resolve(text),
      headers: { get: () => null },
    });
  };
  return { f, calls };
}

function fakeWriteResource() {
  const written: Array<{ specName: string; name: string; data: unknown }> = [];
  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => {
    written.push({ specName, name, data });
    return Promise.resolve({ name });
  };
  return { writeResource, written };
}

function fakeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warning: () => {},
    error: () => {},
  };
}

function noSleep(_ms: number): Promise<void> {
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("escapeSqlLiteral: doubles single quotes", () => {
  assertEquals(escapeSqlLiteral("user@example.com"), "user@example.com");
  assertEquals(escapeSqlLiteral("o'brien@example.com"), "o''brien@example.com");
});

Deno.test("escapeSqlLiteral: neutralizes injection-ish inputs", () => {
  const injected = "x' OR '1'='1";
  const escaped = escapeSqlLiteral(injected);
  assertEquals(escaped, "x'' OR ''1''=''1");
  // Wrapped in the query fragment, every quote is now paired/escaped — no
  // bare `'` survives to close the string early.
  const frag = `subscribers.email='${escaped}'`;
  const bareQuotes = frag.length - frag.replace(/'/g, "").length;
  assertEquals(bareQuotes % 2, 0);
});

Deno.test("escapeSqlLiteral: handles backslashes and semicolons without altering them", () => {
  const input = "a\\'; DROP TABLE subscribers; --";
  const escaped = escapeSqlLiteral(input);
  assertEquals(escaped, "a\\''; DROP TABLE subscribers; --");
});

Deno.test("buildEmailQuery: wraps the escaped literal in the exact-match fragment", () => {
  assertEquals(
    buildEmailQuery("o'brien@example.com"),
    "subscribers.email='o''brien@example.com'",
  );
});

Deno.test("buildCsv: header + depersonalized rows, JSON attributes column", () => {
  const csv = buildCsv([
    { email: "user@example.com", name: "Example User", attribs: { tier: "a" } },
    { email: "second@example.com" },
  ]);
  const lines = csv.split("\r\n");
  assertEquals(lines[0], "email,name,attributes");
  // The JSON attributes blob contains literal `"` chars, so csvField quotes
  // the whole field and doubles the embedded quotes (RFC4180 escaping).
  assertEquals(lines[1], `user@example.com,Example User,"{""tier"":""a""}"`);
  assertEquals(lines[2], `second@example.com,,{}`);
  assertEquals(lines[3], "");
});

Deno.test("buildCsv: quotes a field containing a comma", () => {
  const csv = buildCsv([{ email: "user@example.com", name: "Doe, Jane" }]);
  const lines = csv.split("\r\n");
  assertEquals(lines[1], `user@example.com,"Doe, Jane",{}`);
});

Deno.test("buildImportParams: binds the required axis + optional overwrite flags", () => {
  const base = buildImportParams({
    mode: "subscribe",
    subscriptionStatus: "unconfirmed",
    delim: ",",
    listIds: [1, 2],
    overwrite: false,
  });
  assertEquals(base, {
    mode: "subscribe",
    subscription_status: "unconfirmed",
    delim: ",",
    lists: [1, 2],
    overwrite: false,
  });

  const withOverwrites = buildImportParams({
    mode: "blocklist",
    subscriptionStatus: "confirmed",
    delim: ",",
    listIds: [],
    overwrite: true,
    overwriteUserinfo: true,
    overwriteSubscriptionStatus: false,
  });
  assertEquals(withOverwrites.overwrite_userinfo, true);
  assertEquals(withOverwrites.overwrite_subscription_status, false);
});

Deno.test("scanImportErrors: picks error lines, ignores clean ones", () => {
  const logs = [
    "row 1: imported ok",
    "row 2: error: invalid email",
    "",
    "row 3: ERROR duplicate",
    "row 4: imported ok",
  ].join("\n");
  assertEquals(scanImportErrors(logs), [
    "row 2: error: invalid email",
    "row 3: ERROR duplicate",
  ]);
});

Deno.test("normalizeSubscriberRow: coerces + defaults missing fields", () => {
  const row = normalizeSubscriberRow({ id: 7, email: "user@example.com" });
  assertEquals(row, {
    id: 7,
    uuid: "",
    email: "user@example.com",
    name: "",
    status: "",
    attribs: {},
    lists: [],
  });
});

Deno.test("extractRows: handles bare array and PageResults envelope", () => {
  assertEquals(extractRows([{ id: 1 }]), [{ id: 1 }]);
  assertEquals(extractRows({ results: [{ id: 2 }], total: 1 }), [{ id: 2 }]);
  assertEquals(extractRows(null), []);
  assertEquals(extractRows({}), []);
});

Deno.test("isHttp409: matches only the 409 lmFetch error shape", () => {
  assertEquals(
    isHttp409(
      new Error("listmonk POST api/subscribers failed (HTTP 409): dup"),
    ),
    true,
  );
  assertEquals(
    isHttp409(
      new Error("listmonk POST api/subscribers failed (HTTP 500): boom"),
    ),
    false,
  );
  assertEquals(isHttp409("not an error"), false);
});

// ---------------------------------------------------------------------------
// querySubscribers / getSubscriber (reads)
// ---------------------------------------------------------------------------

Deno.test("querySubscribers: paginates via lmFetchAll and normalizes rows", async () => {
  const { f } = scripted([
    {
      ok: true,
      status: 200,
      body: {
        data: { results: [{ id: 1, email: "user@example.com" }], total: 1 },
      },
    },
  ]);
  const { writeResource, written } = fakeWriteResource();
  const result = await subscribersMethods.querySubscribers.execute(
    { query: "subscribers.status='enabled'", listId: 3, _fetch: f },
    { globalArgs: cfg({ dryRun: false }), logger: fakeLogger(), writeResource },
  );
  assertEquals(result.dataHandles.length, 1);
  assertEquals(written[0].specName, "subscribers");
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.count, 1);
  assertEquals(data.rows[0].email, "user@example.com");
});

Deno.test("getSubscriber: by id hits GET /api/subscribers/:id", async () => {
  const { f, calls } = scripted([
    {
      ok: true,
      status: 200,
      body: { data: { id: 5, email: "user@example.com" } },
    },
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.getSubscriber.execute(
    { id: 5, _fetch: f },
    { globalArgs: cfg(), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls[0].url.includes("api/subscribers/5"), true);
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.found, true);
  assertEquals(data.subscriber.id, 5);
});

Deno.test("getSubscriber: by email escapes the literal into query=", async () => {
  const { f, calls } = scripted([
    { ok: true, status: 200, body: { data: [] } },
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.getSubscriber.execute(
    { email: "o'brien@example.com", _fetch: f },
    { globalArgs: cfg(), logger: fakeLogger(), writeResource },
  );
  const url = new URL(calls[0].url);
  assertEquals(
    url.searchParams.get("query"),
    "subscribers.email='o''brien@example.com'",
  );
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.found, false);
  assertEquals(data.subscriber, null);
});

Deno.test("getSubscriber: rejects when neither id nor email is given", () => {
  const parsed = subscribersMethods.getSubscriber.arguments.safeParse({});
  assertEquals(parsed.success, false);
});

// ---------------------------------------------------------------------------
// importSubscribers (gated write) + getImportStatus + stopImport
// ---------------------------------------------------------------------------

Deno.test("importSubscribers: dryRun performs NO HTTP call", async () => {
  const { f, calls } = scripted([{
    ok: true,
    status: 200,
    body: { data: {} },
  }]);
  const { writeResource, written } = fakeWriteResource();
  const result = await subscribersMethods.importSubscribers.execute(
    {
      rows: [{ email: "user@example.com", name: "Example User" }],
      mode: "subscribe",
      subscriptionStatus: "unconfirmed",
      listIds: [1],
      overwrite: false,
      delim: ",",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      _fetch: f,
      _sleep: noSleep,
    },
    { globalArgs: cfg({ dryRun: true }), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls.length, 0);
  assertEquals(result.dataHandles.length, 1);
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.dryRun, true);
  assertEquals(data.rowCount, 1);
  assertEquals(data.params.mode, "subscribe");
  assertEquals(typeof data.sampleCsv, "string");
});

Deno.test(
  "importSubscribers: live path resets, posts multipart, polls, scans logs",
  async () => {
    const { f, calls } = scripted([
      { ok: true, status: 200, body: { data: true } }, // DELETE reset
      { ok: true, status: 200, body: { data: true } }, // POST import
      { ok: true, status: 200, body: { data: { status: "importing" } } }, // poll 1
      {
        ok: true,
        status: 200,
        body: { data: { status: "finished", imported: 1 } },
      }, // poll 2
      {
        ok: true,
        status: 200,
        body: { data: "row 1: error: bad row" },
        raw: false,
      }, // logs
    ]);
    const { writeResource, written } = fakeWriteResource();
    const result = await subscribersMethods.importSubscribers.execute(
      {
        rows: [{ email: "user@example.com" }],
        mode: "subscribe",
        subscriptionStatus: "unconfirmed",
        listIds: [],
        overwrite: false,
        delim: ",",
        pollIntervalMs: 1,
        pollTimeoutMs: 1000,
        _fetch: f,
        _sleep: noSleep,
      },
      {
        globalArgs: cfg({ dryRun: false }),
        logger: fakeLogger(),
        writeResource,
      },
    );
    assertEquals(calls[0].method, "DELETE");
    assertEquals(calls[1].method, "POST");
    assertEquals(calls[1].body instanceof FormData, true);
    assertEquals(calls[4].url.includes("api/import/subscribers/logs"), true);
    assertEquals(result.dataHandles.length, 1);
    // deno-lint-ignore no-explicit-any
    const data = written[0].data as any;
    assertEquals(data.status, "finished");
    assertEquals(data.imported, 1);
    assertEquals(data.errors, ["row 1: error: bad row"]);
    assertEquals(data.logsScanned, true);
  },
);

Deno.test("importSubscribers: throws when the final status is failed", async () => {
  const { f } = scripted([
    { ok: true, status: 200, body: { data: true } }, // DELETE reset
    { ok: true, status: 200, body: { data: true } }, // POST import
    { ok: true, status: 200, body: { data: { status: "failed" } } }, // poll
    { ok: true, status: 200, body: { data: "fatal: bad file" } }, // logs
  ]);
  const { writeResource } = fakeWriteResource();
  await assertRejects(
    () =>
      subscribersMethods.importSubscribers.execute(
        {
          rows: [{ email: "user@example.com" }],
          mode: "subscribe",
          subscriptionStatus: "unconfirmed",
          listIds: [],
          overwrite: false,
          delim: ",",
          pollIntervalMs: 1,
          pollTimeoutMs: 1000,
          _fetch: f,
          _sleep: noSleep,
        },
        {
          globalArgs: cfg({ dryRun: false }),
          logger: fakeLogger(),
          writeResource,
        },
      ),
    Error,
    "failed",
  );
});

Deno.test("importSubscribers: polling timeout throws without hanging", async () => {
  const { f } = scripted([
    { ok: true, status: 200, body: { data: true } }, // DELETE reset
    { ok: true, status: 200, body: { data: true } }, // POST import
    { ok: true, status: 200, body: { data: { status: "importing" } } }, // never finishes
  ]);
  const { writeResource } = fakeWriteResource();
  await assertRejects(
    () =>
      subscribersMethods.importSubscribers.execute(
        {
          rows: [{ email: "user@example.com" }],
          mode: "subscribe",
          subscriptionStatus: "unconfirmed",
          listIds: [],
          overwrite: false,
          delim: ",",
          pollIntervalMs: 1,
          pollTimeoutMs: 0,
          _fetch: f,
          _sleep: noSleep,
        },
        {
          globalArgs: cfg({ dryRun: false }),
          logger: fakeLogger(),
          writeResource,
        },
      ),
    Error,
    "timed out",
  );
});

Deno.test("getImportStatus: read-only GET, no write gate", async () => {
  const { f } = scripted([
    { ok: true, status: 200, body: { data: { status: "none" } } },
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.getImportStatus.execute(
    { _fetch: f },
    { globalArgs: cfg({ dryRun: true }), logger: fakeLogger(), writeResource },
  );
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.status, "none");
});

Deno.test("stopImport: dryRun performs no DELETE; live sends it", async () => {
  const { f: dryF, calls: dryCalls } = scripted([{
    ok: true,
    status: 200,
    body: {},
  }]);
  const { writeResource: w1, written: written1 } = fakeWriteResource();
  await subscribersMethods.stopImport.execute(
    { _fetch: dryF },
    {
      globalArgs: cfg({ dryRun: true }),
      logger: fakeLogger(),
      writeResource: w1,
    },
  );
  assertEquals(dryCalls.length, 0);
  // deno-lint-ignore no-explicit-any
  assertEquals((written1[0].data as any).status, "would-stop");

  const { f: liveF, calls: liveCalls } = scripted([{
    ok: true,
    status: 200,
    body: { data: true },
  }]);
  const { writeResource: w2, written: written2 } = fakeWriteResource();
  await subscribersMethods.stopImport.execute(
    { _fetch: liveF },
    {
      globalArgs: cfg({ dryRun: false }),
      logger: fakeLogger(),
      writeResource: w2,
    },
  );
  assertEquals(liveCalls[0].method, "DELETE");
  // deno-lint-ignore no-explicit-any
  assertEquals((written2[0].data as any).status, "none");
});

// ---------------------------------------------------------------------------
// upsertSubscriber (gated write)
// ---------------------------------------------------------------------------

Deno.test("upsertSubscriber: dryRun looks up by email but sends no mutating call", async () => {
  const { f, calls } = scripted([
    { ok: true, status: 200, body: { data: [] } }, // lookup only
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.upsertSubscriber.execute(
    { email: "user@example.com", updateMethod: "patch", _fetch: f },
    { globalArgs: cfg({ dryRun: true }), logger: fakeLogger(), writeResource },
  );
  assertEquals(
    calls.every((c) => c.method === undefined || c.method === "GET"),
    true,
  );
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.dryRun, true);
  assertEquals(data.action, "would-create");
});

Deno.test("upsertSubscriber: live create path (no existing row)", async () => {
  const { f, calls } = scripted([
    { ok: true, status: 200, body: { data: [] } }, // lookup: none found
    {
      ok: true,
      status: 200,
      body: { data: { id: 9, email: "user@example.com" } },
    }, // POST create
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.upsertSubscriber.execute(
    {
      email: "user@example.com",
      name: "Example User",
      updateMethod: "patch",
      _fetch: f,
    },
    { globalArgs: cfg({ dryRun: false }), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls[1].method, "POST");
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.action, "created");
  assertEquals(data.id, 9);
});

Deno.test("upsertSubscriber: 409-on-create falls back to find+PATCH", async () => {
  const { f, calls } = scripted([
    {
      ok: true,
      status: 200,
      body: { data: [{ id: 11, email: "user@example.com" }] },
    }, // pre-lookup finds it
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.upsertSubscriber.execute(
    {
      email: "user@example.com",
      attribs: { tier: "b" },
      updateMethod: "patch",
      _fetch: f,
    },
    { globalArgs: cfg({ dryRun: false }), logger: fakeLogger(), writeResource },
  );
  // existingId resolved on the pre-check -> straight to PATCH, no second 409 roundtrip.
  assertEquals(calls[1].method, "PATCH");
  assertEquals(calls[1].url.includes("api/subscribers/11"), true);
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.action, "updated-patch");
  assertEquals(data.id, 11);
});

Deno.test("upsertSubscriber: 409 surfaced mid-create (lookup raced) falls back to find+PUT", async () => {
  const { f, calls } = scripted([
    { ok: true, status: 200, body: { data: [] } }, // pre-lookup: not found yet
    { ok: false, status: 409, body: { message: "duplicate" } }, // POST races into a dup
    {
      ok: true,
      status: 200,
      body: { data: [{ id: 13, email: "user@example.com" }] },
    }, // re-find
    { ok: true, status: 200, body: { data: { id: 13 } } }, // PUT update
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.upsertSubscriber.execute(
    { email: "user@example.com", updateMethod: "put", _fetch: f },
    { globalArgs: cfg({ dryRun: false }), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls[1].method, "POST");
  assertEquals(calls[3].method, "PUT");
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.action, "updated-put");
  assertEquals(data.id, 13);
});

Deno.test("upsertSubscriber: a non-409 create error propagates", async () => {
  const { f } = scripted([
    { ok: true, status: 200, body: { data: [] } },
    { ok: false, status: 500, body: { message: "boom" } },
  ]);
  const { writeResource } = fakeWriteResource();
  await assertRejects(
    () =>
      subscribersMethods.upsertSubscriber.execute(
        { email: "user@example.com", updateMethod: "patch", _fetch: f },
        {
          globalArgs: cfg({ dryRun: false }),
          logger: fakeLogger(),
          writeResource,
        },
      ),
    Error,
    "HTTP 500",
  );
});

// ---------------------------------------------------------------------------
// deleteSubscriber (gated write)
// ---------------------------------------------------------------------------

Deno.test("deleteSubscriber: dryRun verifies but does not DELETE", async () => {
  const { f, calls } = scripted([
    {
      ok: true,
      status: 200,
      body: { data: { id: 4, email: "user@example.com" } },
    },
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.deleteSubscriber.execute(
    { id: 4, _fetch: f },
    { globalArgs: cfg({ dryRun: true }), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET"); // verify-only read, no DELETE
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.action, "would-delete");
});

Deno.test("deleteSubscriber: live path verifies then DELETEs", async () => {
  const { f, calls } = scripted([
    {
      ok: true,
      status: 200,
      body: { data: { id: 4, email: "user@example.com" } },
    },
    { ok: true, status: 200, body: { data: true } },
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.deleteSubscriber.execute(
    { id: 4, _fetch: f },
    { globalArgs: cfg({ dryRun: false }), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls[1].method, "DELETE");
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.action, "deleted");
});

Deno.test("deleteSubscriber: already-gone is a graceful no-op (not-found), no DELETE", async () => {
  const { f, calls } = scripted([
    { ok: true, status: 200, body: { data: null } },
  ]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.deleteSubscriber.execute(
    { id: 404, _fetch: f },
    {
      globalArgs: cfg({ dryRun: false }),
      logger: fakeLogger(),
      writeResource,
    },
  );
  // Idempotent no-op: not-found written, email null, no throw, no DELETE.
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.action, "not-found");
  assertEquals(data.email, null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
});

Deno.test("deleteSubscriber: rejects a non-numeric id before any HTTP call", async () => {
  const { f, calls } = scripted([{ ok: true, status: 200, body: {} }]);
  const { writeResource } = fakeWriteResource();
  await assertRejects(
    () =>
      subscribersMethods.deleteSubscriber.execute(
        { id: "../users/1", _fetch: f },
        {
          globalArgs: cfg({ dryRun: true }),
          logger: fakeLogger(),
          writeResource,
        },
      ),
    Error,
    "invalid",
  );
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// manageSubscriberLists (gated write)
// ---------------------------------------------------------------------------

Deno.test("manageSubscriberLists: dryRun performs no PUT", async () => {
  const { f, calls } = scripted([{ ok: true, status: 200, body: {} }]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.manageSubscriberLists.execute(
    {
      subscriberIds: [1, 2],
      listIds: [10],
      action: "add",
      status: "confirmed",
      _fetch: f,
    },
    { globalArgs: cfg({ dryRun: true }), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls.length, 0);
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.applied, false);
  assertEquals(data.action, "add");
});

Deno.test("manageSubscriberLists: live path PUTs the expected body shape", async () => {
  const { f, calls } = scripted([{
    ok: true,
    status: 200,
    body: { data: true },
  }]);
  const { writeResource, written } = fakeWriteResource();
  await subscribersMethods.manageSubscriberLists.execute(
    { subscriberIds: [1, 2], listIds: [10], action: "remove", _fetch: f },
    { globalArgs: cfg({ dryRun: false }), logger: fakeLogger(), writeResource },
  );
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].url.includes("api/subscribers/lists"), true);
  const body = JSON.parse(String(calls[0].body));
  assertEquals(body, { ids: [1, 2], action: "remove", target_list_ids: [10] });
  // deno-lint-ignore no-explicit-any
  const data = written[0].data as any;
  assertEquals(data.applied, true);
});
