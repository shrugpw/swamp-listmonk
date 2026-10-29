/**
 * Unit tests for the @shrug/listmonk core module (health probe + aggregate
 * sync).
 *
 * Every test injects a synthetic scripted `_fetch` (the `FetchLike` seam) —
 * no live listmonk instance is ever contacted. Fixtures are depersonalized
 * (generic host/user names, example.com-style data only).
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { ExecuteContext, FetchLike, MethodLogger } from "./http.ts";
import { coreMethods, envelopeTotal, summarizeList } from "./core.ts";

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
      baseUrl: "http://listmonk.test",
      apiUser: "swamp-ops",
      apiToken: "test-token",
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

Deno.test("summarizeList — missing fields default (uuid/name/type/optin/status '', tags [], subscriberCount null)", () => {
  const s = summarizeList({ id: 2 });
  assertEquals(s, {
    id: 2,
    uuid: "",
    name: "",
    type: "",
    optin: "",
    status: "",
    tags: [],
    subscriberCount: null,
  });
});

Deno.test("envelopeTotal — PageResults envelope {data:{total}} returns total", () => {
  assertEquals(envelopeTotal({ data: { total: 42 } }), 42);
});

Deno.test("envelopeTotal — non-numeric/missing total on a non-array envelope returns null", () => {
  assertEquals(envelopeTotal({ data: {} }), null);
  assertEquals(envelopeTotal({ data: { total: "42" } }), null);
  assertEquals(envelopeTotal({}), null);
});

Deno.test("envelopeTotal — bare array envelope {data:[]} returns the array length", () => {
  assertEquals(envelopeTotal({ data: [] }), 0);
  assertEquals(envelopeTotal({ data: [{ id: 1 }, { id: 2 }] }), 2);
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

Deno.test("health — GET /api/profile 200 writes a health resource with ok:true + profile fields", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { id: 9, username: "ops-user" } } },
  ]);
  const { context, written } = makeContext();
  const res = await coreMethods.health.execute({ _fetch: fetch }, context);
  assertEquals(res.dataHandles, [{ name: "health" }]);
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "health");
  assertEquals(written[0].name, "health");
  assertEquals(written[0].data.ok, true);
  assertEquals(written[0].data.profileUserId, 9);
  assertEquals(written[0].data.profileUsername, "ops-user");
  assert(calls[0].url.endsWith("/api/profile"));
  assertEquals(calls[0].method, "GET");
});

Deno.test("health — profile response missing id/username fields -> null, null", async () => {
  const { fetch } = sequentialFetch([{ body: { data: {} } }]);
  const { context, written } = makeContext();
  await coreMethods.health.execute({ _fetch: fetch }, context);
  assertEquals(written[0].data.profileUserId, null);
  assertEquals(written[0].data.profileUsername, null);
});

Deno.test("health — 403 (invalid token) rejects, writes nothing", async () => {
  const { fetch } = sequentialFetch([
    { status: 403, body: { message: "invalid API credentials" } },
  ]);
  const { context, written } = makeContext();
  await assertRejects(
    () => coreMethods.health.execute({ _fetch: fetch }, context),
    Error,
    "HTTP 403",
  );
  assertEquals(written.length, 0);
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

Deno.test("sync — all five sections succeed: sections all true, errors {}, fields populated", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { id: 9, username: "ops-user" } } }, // profile
    { body: { data: [listRow()] } }, // lists (bare-array page, stops after 1 call)
    { body: { data: { smtp_enabled: true } } }, // settings
    { body: { data: { total: 42 } } }, // subscribers count probe
    { body: { data: { total: 7 } } }, // campaigns count probe
  ]);
  const { context, written } = makeContext();
  const res = await coreMethods.sync.execute({ _fetch: fetch }, context);
  assertEquals(res.dataHandles, [{ name: "snapshot" }]);
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "snapshot");
  const data = written[0].data;
  assertEquals(data.sections, {
    profile: true,
    lists: true,
    settings: true,
    subscribers: true,
    campaigns: true,
  });
  assertEquals(data.errors, {});
  assertEquals((data.lists as unknown[]).length, 1);
  assertEquals(data.settings, { smtp_enabled: true });
  assertEquals(data.subscriberCount, 42);
  assertEquals(data.campaignCount, 7);
  assertEquals(data.profileUsername, "ops-user");
  assertEquals(data.baseUrl, "http://listmonk.test");
  assertEquals(calls.length, 5);
});

Deno.test("sync — settings fetch 403s: sections.settings false + errors.settings set, other sections still populated, method does NOT throw", async () => {
  const { fetch } = sequentialFetch([
    { body: { data: { id: 9, username: "ops-user" } } }, // profile
    { body: { data: [listRow()] } }, // lists
    { status: 403, body: { message: "missing settings:get" } }, // settings 403
    { body: { data: { total: 42 } } }, // subscribers
    { body: { data: { total: 7 } } }, // campaigns
  ]);
  const { context, written } = makeContext();
  const res = await coreMethods.sync.execute({ _fetch: fetch }, context);
  assertEquals(res.dataHandles, [{ name: "snapshot" }]);
  const data = written[0].data;
  assertEquals(data.sections, {
    profile: true,
    lists: true,
    settings: false,
    subscribers: true,
    campaigns: true,
  });
  const errors = data.errors as Record<string, string>;
  assert(errors.settings.includes("HTTP 403"));
  assert(errors.settings.includes("missing settings:get"));
  assertEquals(Object.keys(errors), ["settings"]);
  // other sections still fully populated despite the settings failure
  assertEquals(data.settings, null);
  assertEquals((data.lists as unknown[]).length, 1);
  assertEquals(data.subscriberCount, 42);
  assertEquals(data.campaignCount, 7);
  assertEquals(data.profileUsername, "ops-user");
});
