/**
 * Unit tests for the @shrug/listmonk auth module (API-user provisioning +
 * the minted-token secret-write path).
 *
 * Every test injects a synthetic scripted `_fetch` (the `FetchLike` seam) —
 * no live listmonk instance is ever contacted and no real bootstrap/vault
 * secret is used. Fixtures are depersonalized (generic host/user names,
 * example.com-style data only).
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { ExecuteContext, FetchLike, MethodLogger } from "./http.ts";
import {
  authMethods,
  bootstrapCfg,
  findRoleByName,
  findUserByName,
  permissionsDiffer,
} from "./auth.ts";

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

const BOOT_USER = "bootstrap-admin";
const BOOT_TOKEN = "bootstrap-secret";
const OPS_USERNAME = "swamp-ops-test";
const OPS_ROLE = "ops-role-test";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("bootstrapCfg — builds an LmConfig from baseUrl + bootstrap user/token", () => {
  assertEquals(
    bootstrapCfg("http://listmonk.test", BOOT_USER, BOOT_TOKEN, 50),
    {
      baseUrl: "http://listmonk.test",
      apiUser: BOOT_USER,
      apiToken: BOOT_TOKEN,
      perPage: 50,
    },
  );
});

Deno.test("bootstrapCfg — perPage is optional", () => {
  const cfg = bootstrapCfg("http://listmonk.test", BOOT_USER, BOOT_TOKEN);
  assertEquals(cfg.baseUrl, "http://listmonk.test");
  assertEquals(cfg.apiUser, BOOT_USER);
  assertEquals(cfg.apiToken, BOOT_TOKEN);
  assertEquals(cfg.perPage, undefined);
});

Deno.test("findRoleByName — exact match returns {id,name,permissions}", () => {
  const json = {
    data: [
      { id: 5, name: OPS_ROLE, permissions: ["lists:get_all"] },
      { id: 6, name: "other" },
    ],
  };
  assertEquals(findRoleByName(json, OPS_ROLE), {
    id: 5,
    name: OPS_ROLE,
    permissions: ["lists:get_all"],
  });
});

Deno.test("findRoleByName — match without permissions defaults to []", () => {
  const json = { data: [{ id: 5, name: OPS_ROLE }] };
  assertEquals(findRoleByName(json, OPS_ROLE), {
    id: 5,
    name: OPS_ROLE,
    permissions: [],
  });
});

Deno.test("findRoleByName — no match returns null", () => {
  const json = { data: [{ id: 6, name: "other" }] };
  assertEquals(findRoleByName(json, OPS_ROLE), null);
});

Deno.test("findRoleByName — matching name with a non-numeric id is skipped", () => {
  const json = { data: [{ id: "5", name: OPS_ROLE }] };
  assertEquals(findRoleByName(json, OPS_ROLE), null);
});

Deno.test("permissionsDiffer — order-insensitive set comparison", () => {
  assertEquals(permissionsDiffer(["a", "b"], ["b", "a"]), false);
  assertEquals(permissionsDiffer(["a"], ["a", "b"]), true); // missing one
  assertEquals(permissionsDiffer(["a", "b"], ["a"]), true); // extra one
  assertEquals(permissionsDiffer([], []), false);
  assertEquals(permissionsDiffer(["campaigns:send"], ["lists:get_all"]), true);
});

Deno.test("findUserByName — array-form response, exact match", () => {
  const json = {
    data: [{ id: 9, username: OPS_USERNAME }, { id: 1, username: "x" }],
  };
  assertEquals(findUserByName(json, OPS_USERNAME), {
    id: 9,
    username: OPS_USERNAME,
  });
});

Deno.test("findUserByName — {results:[...]} envelope form, exact match", () => {
  const json = {
    data: { results: [{ id: 9, username: OPS_USERNAME }], total: 1 },
  };
  assertEquals(findUserByName(json, OPS_USERNAME), {
    id: 9,
    username: OPS_USERNAME,
  });
});

Deno.test("findUserByName — neither array nor {results} shape -> null", () => {
  assertEquals(findUserByName({ data: {} }, OPS_USERNAME), null);
  assertEquals(
    findUserByName({ data: [{ id: 1, username: "other" }] }, OPS_USERNAME),
    null,
  );
});

// ---------------------------------------------------------------------------
// provisionApiUser — DRY RUN
// ---------------------------------------------------------------------------

Deno.test("provisionApiUser — dryRun true: authenticates, inspects, writes would-* provisionRun, no POST", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { id: 1, username: BOOT_USER } } }, // GET /api/profile
    { body: { data: [] } }, // GET /api/roles/users — role absent
    { body: { data: [] } }, // GET /api/users — user absent
  ]);
  const { context, written } = makeContext({ dryRun: true });
  const res = await authMethods.provisionApiUser.execute(
    {
      bootstrapUser: BOOT_USER,
      bootstrapToken: BOOT_TOKEN,
      username: OPS_USERNAME,
      roleName: OPS_ROLE,
      permissions: ["lists:get_all"],
      _fetch: fetch,
    },
    context,
  );
  assertEquals(res.dataHandles, [{ name: `provisionRun-${OPS_USERNAME}` }]);
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "provisionRun");
  assertEquals(written[0].name, `provisionRun-${OPS_USERNAME}`);
  assertEquals(written[0].data.dryRun, true);
  assertEquals(written[0].data.roleAction, "would-create");
  assertEquals(written[0].data.userAction, "would-create");
  assertEquals(written[0].data.tokenMinted, false);
  assertEquals(written[0].data.roleId, null);
  // exactly the 3 read-only lookups fired; no mutating call was attempted
  // (sequentialFetch would also throw on an unscripted 4th call).
  assertEquals(calls.length, 3);
  assert(calls.every((c) => c.method === "GET"));
});

// ---------------------------------------------------------------------------
// provisionApiUser — LIVE, role absent + user absent
// ---------------------------------------------------------------------------

Deno.test("provisionApiUser — live, role+user absent: creates role, mints user+token, writes apiCredential + provisionRun", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { id: 1, username: BOOT_USER } } }, // GET /api/profile
    { body: { data: [] } }, // GET /api/roles/users — absent
    { body: { data: [] } }, // GET /api/users — absent
    { body: { data: { id: 5 } } }, // POST /api/roles/users
    { body: { data: { password: "minted-token-abc" } } }, // POST /api/users
  ]);
  const { context, written } = makeContext({ dryRun: false });
  const res = await authMethods.provisionApiUser.execute(
    {
      bootstrapUser: BOOT_USER,
      bootstrapToken: BOOT_TOKEN,
      username: OPS_USERNAME,
      roleName: OPS_ROLE,
      permissions: ["lists:get_all"],
      _fetch: fetch,
    },
    context,
  );

  assertEquals(calls[3].method, "POST");
  assert(calls[3].url.endsWith("/api/roles/users"));
  assertEquals(calls[3].body, {
    name: OPS_ROLE,
    permissions: ["lists:get_all"],
  });

  assertEquals(calls[4].method, "POST");
  assert(calls[4].url.endsWith("/api/users"));
  assertEquals(calls[4].body, {
    username: OPS_USERNAME,
    type: "api",
    user_role_id: 5,
    email: `${OPS_USERNAME}@api.invalid`,
    status: "enabled",
  });

  assertEquals(written.length, 2);
  assertEquals(written[0].specName, "apiCredential");
  assertEquals(written[0].name, `apiCredential-${OPS_USERNAME}`);
  assertEquals(written[0].data.apiUser, OPS_USERNAME);
  assertEquals(written[0].data.apiToken, "minted-token-abc");
  assertEquals(written[0].data.roleId, 5);
  assertEquals(written[0].data.roleName, OPS_ROLE);

  assertEquals(written[1].specName, "provisionRun");
  assertEquals(written[1].name, `provisionRun-${OPS_USERNAME}`);
  assertEquals(written[1].data.dryRun, false);
  assertEquals(written[1].data.roleAction, "created");
  assertEquals(written[1].data.userAction, "created");
  assertEquals(written[1].data.tokenMinted, true);
  assertEquals(written[1].data.roleId, 5);

  assertEquals(res.dataHandles, [
    { name: `apiCredential-${OPS_USERNAME}` },
    { name: `provisionRun-${OPS_USERNAME}` },
  ]);
});

// ---------------------------------------------------------------------------
// provisionApiUser — LIVE, user already exists
// ---------------------------------------------------------------------------

Deno.test("provisionApiUser — live, user already exists: no POST /api/users, tokenMinted false, no apiCredential written", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { id: 1, username: BOOT_USER } } }, // GET /api/profile
    // role found WITH matching perms -> reused, no reconcile PUT
    {
      body: {
        data: [{ id: 5, name: OPS_ROLE, permissions: ["lists:get_all"] }],
      },
    }, // GET /api/roles/users
    { body: { data: [{ id: 9, username: OPS_USERNAME }] } }, // GET /api/users — found
  ]);
  const { context, written } = makeContext({ dryRun: false });
  const res = await authMethods.provisionApiUser.execute(
    {
      bootstrapUser: BOOT_USER,
      bootstrapToken: BOOT_TOKEN,
      username: OPS_USERNAME,
      roleName: OPS_ROLE,
      permissions: ["lists:get_all"],
      _fetch: fetch,
    },
    context,
  );

  // only the 3 read-only lookups fired — no POST for an already-existing user.
  assertEquals(calls.length, 3);
  assert(calls.every((c) => c.method === "GET"));

  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "provisionRun");
  assertEquals(written[0].data.roleAction, "reused");
  assertEquals(written[0].data.userAction, "exists");
  assertEquals(written[0].data.tokenMinted, false);
  assertEquals(res.dataHandles, [{ name: `provisionRun-${OPS_USERNAME}` }]);
});

// ---------------------------------------------------------------------------
// provisionApiUser — LIVE, role reuse with permission DRIFT -> reconcile
// ---------------------------------------------------------------------------

Deno.test("provisionApiUser — live, existing over-privileged role is reconciled to the requested perms", async () => {
  const { fetch, calls } = sequentialFetch([
    { body: { data: { id: 1, username: BOOT_USER } } }, // GET /api/profile
    // role exists but carries an EXTRA privilege (campaigns:send) -> drift
    {
      body: {
        data: [{
          id: 5,
          name: OPS_ROLE,
          permissions: ["lists:get_all", "campaigns:send"],
        }],
      },
    }, // GET /api/roles/users
    { body: { data: [] } }, // GET /api/users — absent
    { body: { data: { id: 5, name: OPS_ROLE } } }, // PUT /api/roles/users/5 (reconcile)
    { body: { data: { id: 9, username: OPS_USERNAME, password: "tok" } } }, // POST /api/users
  ]);
  const { context, written } = makeContext({ dryRun: false });
  await authMethods.provisionApiUser.execute(
    {
      bootstrapUser: BOOT_USER,
      bootstrapToken: BOOT_TOKEN,
      username: OPS_USERNAME,
      roleName: OPS_ROLE,
      permissions: ["lists:get_all"], // narrower than the existing role
      _fetch: fetch,
    },
    context,
  );
  // The reconcile PUT fired against the role id, dropping campaigns:send.
  assertEquals(calls[3].method, "PUT");
  assert(calls[3].url.endsWith("/api/roles/users/5"));
  assertEquals(calls[3].body, {
    name: OPS_ROLE,
    permissions: ["lists:get_all"],
  });
  const run = written.find((w) => w.specName === "provisionRun")!;
  assertEquals(run.data.roleAction, "reconciled");
});

// ---------------------------------------------------------------------------
// provisionApiUser — user create returns no token
// ---------------------------------------------------------------------------

Deno.test("provisionApiUser — user create response missing data.password throws", async () => {
  const { fetch } = sequentialFetch([
    { body: { data: { id: 1, username: BOOT_USER } } }, // GET /api/profile
    // role found WITH matching perms -> reused, no reconcile PUT, no create
    {
      body: {
        data: [{ id: 5, name: OPS_ROLE, permissions: ["lists:get_all"] }],
      },
    }, // GET /api/roles/users
    { body: { data: [] } }, // GET /api/users — absent
    { body: { data: {} } }, // POST /api/users — no password field
  ]);
  const { context } = makeContext({ dryRun: false });
  await assertRejects(
    () =>
      authMethods.provisionApiUser.execute(
        {
          bootstrapUser: BOOT_USER,
          bootstrapToken: BOOT_TOKEN,
          username: OPS_USERNAME,
          roleName: OPS_ROLE,
          permissions: ["lists:get_all"],
          _fetch: fetch,
        },
        context,
      ),
    Error,
    "did not return a token",
  );
});
