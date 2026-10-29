/**
 * Unit tests for the `@shrug/listmonk` settings module.
 *
 * Two layers:
 *  - Pure helpers: `mergeSmtpBlocks`' password-preservation rule (no overlay,
 *    in-place edit, secret rotation, brand-new block, untouched-block
 *    survival), `hasEnabledSmtpBlock`, `redactSecrets`, and `buildMergedSettings`.
 *  - Method paths (`getSettings`, `applySettings`, `setSmtpServers`, `testSmtp`,
 *    `reloadApp`) driven through an injected `FetchLike` mock and a fake
 *    execute context, so no network is hit: asserting the dryRun gate (GET
 *    only, no PUT/POST, redacted preview), the live PUT body carries the
 *    preserved/rotated passwords correctly, the >=1-enabled-smtp guard, and
 *    that a failed testSmtp records the failure rather than throwing.
 *
 * Run with: `~/.swamp/deno/deno test extensions/models/listmonk/settings_test.ts`
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { FetchLike, GlobalArgs } from "./http.ts";
import {
  buildMergedSettings,
  computeSettingsDrift,
  hasEnabledSmtpBlock,
  mergeSmtpBlocks,
  redactSecrets,
  settingsMethods,
  settingsResources,
  stripBulletMasks,
} from "./settings.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function mkCfg(over: Partial<GlobalArgs> = {}): GlobalArgs {
  return {
    baseUrl: "https://lists.example.org",
    apiUser: "swamp-ops",
    apiToken: "test-token",
    perPage: 100,
    dryRun: true,
    maxRetries: 0,
    ...over,
  };
}

interface Captured {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

function fakeContext(cfg: GlobalArgs) {
  const written: Captured[] = [];
  const context = {
    globalArgs: cfg,
    logger: {
      debug: () => {},
      info: () => {},
      warning: () => {},
      error: () => {},
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

/** A recorded fetch call. */
interface FetchRec {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Build a {@link FetchLike} that routes on HTTP method, returning whatever
 * `handler` says. Good enough to serve a GET-then-PUT (or GET-only / POST-only)
 * sequence without needing a stateful queue.
 */
function routedFetcher(
  handler: (
    method: string,
    url: URL,
    body: string | undefined,
  ) => { body: unknown; ok?: boolean; status?: number; statusText?: string },
): { f: FetchLike; calls: FetchRec[] } {
  const calls: FetchRec[] = [];
  const f: FetchLike = (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body, headers: init?.headers });
    const r = handler(method, new URL(url), body);
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? "OK",
      text: () => Promise.resolve(JSON.stringify(r.body)),
      headers: { get: () => null },
    });
  };
  return { f, calls };
}

/** A fixed-response fetcher — every call gets the same body/status. */
function fixedFetcher(
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
): { f: FetchLike; calls: FetchRec[] } {
  return routedFetcher(() => ({ body, ...opts }));
}

/** A live settings object with one enabled block and one disabled block. */
function liveSettingsFixture(): Record<string, unknown> {
  return {
    "app.site_name": "Example List Co",
    "app.root_url": "https://lists.example.org",
    "app.from_email": "news@example.org",
    smtp: [
      {
        uuid: "uuid-primary",
        name: "email-primary",
        enabled: true,
        host: "smtp.example.org",
        port: 587,
        auth_protocol: "login",
        tls_type: "STARTTLS",
        username: "news@example.org",
        password: "••••••••", // masked
      },
      {
        uuid: "uuid-backup",
        name: "email-backup",
        enabled: false,
        host: "smtp-backup.example.org",
        port: 2525,
        auth_protocol: "plain",
        tls_type: "TLS",
        username: "backup@example.org",
        password: "••••",
      },
    ],
    messengers: [],
  };
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

Deno.test("mergeSmtpBlocks: no overlay clears every password, keeps uuid", () => {
  const live = liveSettingsFixture().smtp as Array<Record<string, unknown>>;
  const out = mergeSmtpBlocks(live, undefined);
  assertEquals(out.length, 2);
  for (const b of out) assertEquals(b.password, "");
  assertEquals(out[0].uuid, "uuid-primary");
  assertEquals(out[1].uuid, "uuid-backup");
  // Non-secret fields pass through untouched.
  assertEquals(out[0].host, "smtp.example.org");
});

Deno.test("mergeSmtpBlocks: overlay edit (no password) preserves the stored secret", () => {
  const live = liveSettingsFixture().smtp as Array<Record<string, unknown>>;
  const out = mergeSmtpBlocks(live, [
    { uuid: "uuid-primary", port: 465, tls_type: "TLS" },
  ]);
  const primary = out.find((b) => b.uuid === "uuid-primary")!;
  assertEquals(primary.password, "");
  assertEquals(primary.uuid, "uuid-primary");
  assertEquals(primary.port, 465); // edited field applied
  assertEquals(primary.tls_type, "TLS");
  assertEquals(primary.host, "smtp.example.org"); // untouched field kept
});

Deno.test("mergeSmtpBlocks: overlay with a cleartext password rotates the secret", () => {
  const live = liveSettingsFixture().smtp as Array<Record<string, unknown>>;
  const out = mergeSmtpBlocks(live, [
    { uuid: "uuid-primary", password: "new-cleartext-secret" },
  ]);
  const primary = out.find((b) => b.uuid === "uuid-primary")!;
  assertEquals(primary.password, "new-cleartext-secret");
  assertEquals(primary.uuid, "uuid-primary");
});

Deno.test("mergeSmtpBlocks: a brand-new block (no uuid match) passes through", () => {
  const live = liveSettingsFixture().smtp as Array<Record<string, unknown>>;
  const out = mergeSmtpBlocks(live, [
    {
      name: "new-relay",
      enabled: true,
      host: "smtp3.example.org",
      port: 587,
      password: "fresh-secret",
    },
  ]);
  const created = out.find((b) => b.host === "smtp3.example.org")!;
  assertEquals(created.password, "fresh-secret");
  // Both pre-existing live blocks survive, untouched (preserved, not dropped).
  assertEquals(out.some((b) => b.uuid === "uuid-primary"), true);
  assertEquals(out.some((b) => b.uuid === "uuid-backup"), true);
  assertEquals(out.length, 3);
});

Deno.test("mergeSmtpBlocks: a live block the overlay never mentions is preserved, not dropped", () => {
  const live = liveSettingsFixture().smtp as Array<Record<string, unknown>>;
  const out = mergeSmtpBlocks(live, [
    { uuid: "uuid-primary", password: "rotated" },
  ]);
  const backup = out.find((b) => b.uuid === "uuid-backup");
  assertEquals(backup !== undefined, true);
  assertEquals(backup!.password, "");
  assertEquals(backup!.enabled, false);
});

Deno.test("hasEnabledSmtpBlock: true/false", () => {
  assertEquals(
    hasEnabledSmtpBlock([{ enabled: false }, { enabled: true }]),
    true,
  );
  assertEquals(hasEnabledSmtpBlock([{ enabled: false }]), false);
  assertEquals(hasEnabledSmtpBlock([]), false);
});

Deno.test("redactSecrets: redacts non-empty password fields, deeply, leaves the rest", () => {
  const input = {
    "app.site_name": "Example List Co",
    smtp: [
      { uuid: "a", password: "sekrit", host: "smtp.example.org" },
      { uuid: "b", password: "", host: "smtp2.example.org" },
    ],
    bounce: { mailboxes: [{ uuid: "c", Password: "ALSO-SEKRIT" }] },
  };
  const out = redactSecrets(input) as typeof input;
  assertEquals(out["app.site_name"], "Example List Co");
  assertEquals(out.smtp[0].password, "•••redacted•••");
  assertEquals(out.smtp[0].host, "smtp.example.org");
  assertEquals(out.smtp[1].password, ""); // empty password left alone
  assertEquals(
    (out.bounce.mailboxes[0] as Record<string, unknown>).Password,
    "•••redacted•••",
  );
  // The original is untouched (pure function, no mutation).
  assertEquals(input.smtp[0].password, "sekrit");
});

Deno.test("redactSecrets: redacts NON-password secrets too (oidc/s3/captcha/api keys)", () => {
  const input = {
    "security.oidc.client_secret": "oidc-cleartext",
    "upload.s3.aws_secret_access_key": "AKIA-cleartext",
    "security.captcha.secret": "captcha-cleartext",
    "bounce.mailboxes": [{ api_key: "mailgun-cleartext" }],
    "app.site_name": "Example List Co", // not a secret — preserved
  };
  const out = redactSecrets(input) as Record<string, unknown>;
  assertEquals(out["security.oidc.client_secret"], "•••redacted•••");
  assertEquals(out["upload.s3.aws_secret_access_key"], "•••redacted•••");
  assertEquals(out["security.captcha.secret"], "•••redacted•••");
  assertEquals(
    (out["bounce.mailboxes"] as Array<Record<string, unknown>>)[0].api_key,
    "•••redacted•••",
  );
  assertEquals(out["app.site_name"], "Example List Co");
});

Deno.test("stripBulletMasks: a bullet-mask string -> '' so a PUT preserves the stored secret", () => {
  const input = {
    messengers: [
      { uuid: "m1", password: "••••••••••" }, // masked -> cleared
      { uuid: "m2", password: "real-new-secret" }, // real -> kept
    ],
    bounce: { mailboxes: [{ uuid: "c", password: "••••" }] },
    "app.site_name": "Example List Co",
    "app.from_email": "noreply@example.org",
  };
  const out = stripBulletMasks(input) as typeof input;
  assertEquals(out.messengers[0].password, ""); // mask cleared (omitempty preserves)
  assertEquals(out.messengers[1].password, "real-new-secret"); // untouched
  assertEquals(out.bounce.mailboxes[0].password, "");
  assertEquals(out["app.site_name"], "Example List Co"); // normal value untouched
  // original not mutated
  assertEquals(input.messengers[0].password, "••••••••••");
});

Deno.test("buildMergedSettings: shallow-overlays dotted keys, routes smtp through the merge rule", () => {
  const live = liveSettingsFixture();
  const { merged, overlayKeys, smtp } = buildMergedSettings(live, {
    "app.site_name": "New Name Co",
    smtp: [{ uuid: "uuid-primary", password: "rotated-secret" }],
  });
  assertEquals(merged["app.site_name"], "New Name Co");
  assertEquals(merged["app.root_url"], "https://lists.example.org"); // untouched key survives
  assertEquals(overlayKeys, ["app.site_name"]); // smtp excluded from overlayKeys
  assertEquals(smtp.length, 2);
  const primary = smtp.find((b) => b.uuid === "uuid-primary")!;
  assertEquals(primary.password, "rotated-secret");
  const backup = smtp.find((b) => b.uuid === "uuid-backup")!;
  assertEquals(backup.password, "");
});

// ---------------------------------------------------------------------------
// Resource map sanity.
// ---------------------------------------------------------------------------

Deno.test("settingsResources exports settings / settingsApply / smtpTest / settingsReconcile", () => {
  assertEquals(Object.keys(settingsResources).sort(), [
    "settings",
    "settingsApply",
    "settingsReconcile",
    "smtpTest",
  ]);
});

Deno.test("settingsMethods exports the settings methods (incl. reconcileSettings)", () => {
  assertEquals(Object.keys(settingsMethods).sort(), [
    "applySettings",
    "getSettings",
    "reconcileSettings",
    "reloadApp",
    "setSmtpServers",
    "testSmtp",
  ]);
});

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------

Deno.test("getSettings: GETs once, writes the settings resource verbatim", async () => {
  const cfg = mkCfg();
  const { context, written } = fakeContext(cfg);
  const live = liveSettingsFixture();
  const { f, calls } = fixedFetcher({ data: live });

  const result = await settingsMethods.getSettings.execute(
    { _fetch: f },
    context,
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assertEquals(result.dataHandles, [{ name: "settings" }]);
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "settings");
  assertEquals(
    (written[0].data.settings as Record<string, unknown>)["app.site_name"],
    "Example List Co",
  );
});

// ---------------------------------------------------------------------------
// applySettings
// ---------------------------------------------------------------------------

Deno.test("applySettings: dryRun performs GET only, no PUT, and redacts the preview", async () => {
  const cfg = mkCfg({ dryRun: true });
  const { context, written } = fakeContext(cfg);
  const live = liveSettingsFixture();
  const { f, calls } = fixedFetcher({ data: live });

  const result = await settingsMethods.applySettings.execute(
    {
      overlay: {
        "app.site_name": "New Name Co",
        smtp: [{ uuid: "uuid-primary", password: "would-be-rotated" }],
      },
      _fetch: f,
    },
    context,
  );

  assertEquals(calls.length, 1); // GET only — no PUT under dryRun.
  assertEquals(calls[0].method, "GET");
  assertEquals(result.dataHandles, [{ name: "settingsApply" }]);
  const rec = written[0];
  assertEquals(rec.spec, "settingsApply");
  assertEquals(rec.data.dryRun, true);
  assertEquals(rec.data.applied, false);
  assertEquals(rec.data.action, "applySettings");
  assertEquals(rec.data.overlayKeys, ["app.site_name"]);
  assertEquals(rec.data.hasEnabledSmtp, true);
  const preview = rec.data.preview as Record<string, unknown>;
  assertEquals(preview["app.site_name"], "New Name Co");
  const previewSmtp = preview.smtp as Array<Record<string, unknown>>;
  const previewPrimary = previewSmtp.find((b) => b.uuid === "uuid-primary")!;
  // The cleartext overlay password must NEVER reach the persisted preview.
  assertEquals(previewPrimary.password, "•••redacted•••");
});

Deno.test("applySettings: live write PUTs the merged object with secrets preserved/rotated correctly", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context, written } = fakeContext(cfg);
  const live = liveSettingsFixture();
  const { f, calls } = routedFetcher((method) => {
    if (method === "GET") return { body: { data: live } };
    return { body: { data: { needs_restart: false } } };
  });

  const result = await settingsMethods.applySettings.execute(
    {
      overlay: {
        "app.site_name": "New Name Co",
        smtp: [{ uuid: "uuid-primary", password: "rotated-secret" }],
      },
      _fetch: f,
    },
    context,
  );

  assertEquals(calls.length, 2);
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[1].method, "PUT");
  const putBody = JSON.parse(calls[1].body!) as Record<string, unknown>;
  assertEquals(putBody["app.site_name"], "New Name Co");
  const putSmtp = putBody.smtp as Array<Record<string, unknown>>;
  const putPrimary = putSmtp.find((b) => b.uuid === "uuid-primary")!;
  assertEquals(putPrimary.password, "rotated-secret"); // real cleartext on the wire
  const putBackup = putSmtp.find((b) => b.uuid === "uuid-backup")!;
  assertEquals(putBackup.password, ""); // untouched block: stored secret preserved
  assertEquals(putBackup.uuid, "uuid-backup");

  assertEquals(result.dataHandles, [{ name: "settingsApply" }]);
  const rec = written[0];
  assertEquals(rec.data.applied, true);
  assertEquals(rec.data.dryRun, false);
  assertEquals(rec.data.needsRestart, false);
  assertEquals(rec.data.preview, null);
});

Deno.test("applySettings: live write refuses to PUT when the merge leaves no enabled smtp block", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context } = fakeContext(cfg);
  const live = liveSettingsFixture();
  const { f, calls } = routedFetcher((method) => {
    if (method === "GET") return { body: { data: live } };
    return { body: { data: { needs_restart: false } } };
  });

  await assertRejects(
    () =>
      settingsMethods.applySettings.execute(
        {
          // Disables the only enabled block, enables nothing else.
          overlay: { smtp: [{ uuid: "uuid-primary", enabled: false }] },
          _fetch: f,
        },
        context,
      ),
    Error,
    "no enabled=true block",
  );
  // The guard fires BEFORE the PUT: only the GET went out.
  assertEquals(calls.length, 1);
});

// ---------------------------------------------------------------------------
// setSmtpServers
// ---------------------------------------------------------------------------

Deno.test("setSmtpServers: dryRun only touches smtp[], leaves other keys alone in the preview", async () => {
  const cfg = mkCfg({ dryRun: true });
  const { context, written } = fakeContext(cfg);
  const live = liveSettingsFixture();
  const { f, calls } = fixedFetcher({ data: live });

  await settingsMethods.setSmtpServers.execute(
    { smtp: [{ uuid: "uuid-backup", enabled: true }], _fetch: f },
    context,
  );

  assertEquals(calls.length, 1);
  const rec = written[0];
  assertEquals(rec.data.action, "setSmtpServers");
  assertEquals(rec.data.overlayKeys, []); // no non-smtp keys touched
  const preview = rec.data.preview as Record<string, unknown>;
  assertEquals(preview["app.site_name"], "Example List Co"); // untouched
  const previewSmtp = preview.smtp as Array<Record<string, unknown>>;
  const backup = previewSmtp.find((b) => b.uuid === "uuid-backup")!;
  assertEquals(backup.enabled, true);
});

Deno.test("setSmtpServers: live write PUTs with both blocks enabled, passwords preserved", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context } = fakeContext(cfg);
  const live = liveSettingsFixture();
  const { f, calls } = routedFetcher((method) => {
    if (method === "GET") return { body: { data: live } };
    return { body: { data: { needs_restart: true } } };
  });

  await settingsMethods.setSmtpServers.execute(
    { smtp: [{ uuid: "uuid-backup", enabled: true }], _fetch: f },
    context,
  );

  const putBody = JSON.parse(calls[1].body!) as Record<string, unknown>;
  const putSmtp = putBody.smtp as Array<Record<string, unknown>>;
  assertEquals(putSmtp.length, 2);
  for (const b of putSmtp) assertEquals(b.password, "");
});

// ---------------------------------------------------------------------------
// testSmtp
// ---------------------------------------------------------------------------

Deno.test("testSmtp: dryRun sends no request at all", async () => {
  const cfg = mkCfg({ dryRun: true });
  const { context, written } = fakeContext(cfg);
  const { f, calls } = fixedFetcher({ data: true });

  await settingsMethods.testSmtp.execute(
    {
      smtp: { host: "smtp.example.org", port: 587, password: "sekrit" },
      _fetch: f,
    },
    context,
  );

  assertEquals(calls.length, 0);
  const rec = written[0];
  assertEquals(rec.data.ran, false);
  assertEquals(rec.data.success, null);
  assertEquals(rec.data.host, "smtp.example.org");
});

Deno.test("testSmtp: live success records success:true without echoing the password", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context, written } = fakeContext(cfg);
  const { f, calls } = fixedFetcher({ data: true });

  await settingsMethods.testSmtp.execute(
    {
      smtp: { host: "smtp.example.org", port: 587, password: "sekrit" },
      _fetch: f,
    },
    context,
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  const rec = written[0];
  assertEquals(rec.data.ran, true);
  assertEquals(rec.data.success, true);
  assertEquals(Object.keys(rec.data).includes("password"), false);
});

Deno.test("testSmtp: live failure records success:false + message, does NOT throw", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context, written } = fakeContext(cfg);
  const { f } = fixedFetcher({ message: "dial tcp: connection refused" }, {
    ok: false,
    status: 400,
    statusText: "Bad Request",
  });

  const result = await settingsMethods.testSmtp.execute(
    { smtp: { host: "smtp.example.org", port: 587 }, _fetch: f },
    context,
  );

  assertEquals(result.dataHandles, [{ name: "smtpTest" }]);
  const rec = written[0];
  assertEquals(rec.data.ran, true);
  assertEquals(rec.data.success, false);
  assertEquals(
    (rec.data.message as string).includes("connection refused"),
    true,
  );
});

// ---------------------------------------------------------------------------
// reloadApp
// ---------------------------------------------------------------------------

Deno.test("reloadApp: dryRun sends no request", async () => {
  const cfg = mkCfg({ dryRun: true });
  const { context, written } = fakeContext(cfg);
  const { f, calls } = fixedFetcher({ data: true });

  await settingsMethods.reloadApp.execute({ _fetch: f }, context);

  assertEquals(calls.length, 0);
  assertEquals(written[0].data.applied, false);
  assertEquals(written[0].data.action, "reloadApp");
});

Deno.test("reloadApp: live run POSTs once and records applied:true", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context, written } = fakeContext(cfg);
  const { f, calls } = fixedFetcher({ data: true });

  await settingsMethods.reloadApp.execute({ _fetch: f }, context);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url.endsWith("api/admin/reload"), true);
  assertEquals(written[0].data.applied, true);
});

// ---------------------------------------------------------------------------
// reconcileSettings — pure drift (computeSettingsDrift)
// ---------------------------------------------------------------------------

Deno.test("computeSettingsDrift: flat key in-sync vs would-change", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    "app.root_url": "https://lists.example.org", // matches
    "app.from_email": "announce@example.org", // differs
  });
  const byKey = Object.fromEntries(d.rows.map((r) => [r.key, r]));
  assertEquals(byKey["app.root_url"].status, "in-sync");
  assertEquals(byKey["app.from_email"].status, "would-change");
  assertEquals(byKey["app.from_email"].from, "news@example.org");
  assertEquals(byKey["app.from_email"].to, "announce@example.org");
  assertEquals(d.wouldChangeCount, 1);
});

Deno.test("computeSettingsDrift: declared-subset — undeclared live keys are not reported", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    "app.root_url": "https://lists.example.org",
  });
  // Only the one declared flat key, not app.site_name/app.from_email/etc.
  assertEquals(d.rows.length, 1);
  assertEquals(d.rows[0].key, "app.root_url");
});

Deno.test("computeSettingsDrift: a declared key absent live is would-change with from:null", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, { "privacy.allow_export": true });
  assertEquals(d.rows[0].status, "would-change");
  assertEquals(d.rows[0].from, null);
  assertEquals(d.rows[0].to, true);
});

Deno.test("computeSettingsDrift: a secret-looking declared value is redacted in the row", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    "upload.s3.aws_secret_access_key": "super-secret-value",
  });
  assertEquals(d.rows[0].to, "•••redacted•••");
});

Deno.test("computeSettingsDrift: smtp matched by uuid — non-secret drift, declared-subset", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    smtp: [{ uuid: "uuid-primary", port: 2587 }],
  });
  const row = d.rows[0];
  assertEquals(row.key, "smtp[uuid-primary]");
  assertEquals(row.status, "would-change");
  // Only the declared keys appear in `from` (port), not host/tls/etc.
  assertEquals(row.from, { uuid: "uuid-primary", port: 587 });
  assertEquals(row.to, { uuid: "uuid-primary", port: 2587 });
});

Deno.test("computeSettingsDrift: smtp matched by uuid — all declared fields equal is in-sync", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    smtp: [{ uuid: "uuid-primary", host: "smtp.example.org", port: 587 }],
  });
  assertEquals(d.rows[0].status, "in-sync");
  assertEquals(d.wouldChangeCount, 0);
});

Deno.test("computeSettingsDrift: smtp password never diffed, sets secretWriteThrough", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    smtp: [{
      uuid: "uuid-primary",
      host: "smtp.example.org",
      port: 587,
      password: "a-real-cleartext-secret",
    }],
  });
  const row = d.rows[0];
  // Non-secret fields match -> in-sync even though a cleartext password is set.
  assertEquals(row.status, "in-sync");
  assertEquals(row.secretWriteThrough, true);
  // The password must NOT appear anywhere in the diff row.
  assertEquals(JSON.stringify(row).includes("a-real-cleartext-secret"), false);
});

Deno.test("computeSettingsDrift: smtp matched by host|username when no uuid declared", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    smtp: [{
      host: "smtp.example.org",
      username: "news@example.org",
      port: 587,
    }],
  });
  assertEquals(d.rows[0].status, "in-sync");
});

Deno.test("computeSettingsDrift: a brand-new smtp block is would-change with from:null", () => {
  const live = liveSettingsFixture();
  const d = computeSettingsDrift(live, {
    smtp: [{ host: "smtp.newprovider.org", username: "x@new.org", port: 465 }],
  });
  assertEquals(d.rows[0].status, "would-change");
  assertEquals(d.rows[0].from, null);
  assertEquals(d.wouldChangeCount, 1);
});

// ---------------------------------------------------------------------------
// reconcileSettings — method paths
// ---------------------------------------------------------------------------

Deno.test("reconcileSettings: dryRun GETs only, writes drift + preview, applied:false", async () => {
  const cfg = mkCfg({ dryRun: true });
  const { context, written } = fakeContext(cfg);
  const { f, calls } = routedFetcher((method) => {
    if (method === "GET") return { body: { data: liveSettingsFixture() } };
    return { body: { data: { needs_restart: false } } };
  });

  const result = await settingsMethods.reconcileSettings.execute(
    { desired: { "app.from_email": "announce@example.org" }, _fetch: f },
    context,
  );

  // GET only — no PUT on a dry run.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assertEquals(result.dataHandles, [{ name: "settingsReconcile" }]);
  const rec = written[0];
  assertEquals(rec.spec, "settingsReconcile");
  assertEquals(rec.data.dryRun, true);
  assertEquals(rec.data.applied, false);
  assertEquals(rec.data.wouldChangeCount, 1);
  // Dry run carries a redacted preview of the merged object.
  assertEquals(rec.data.preview !== null, true);
});

Deno.test("reconcileSettings: live run with zero drift is a no-op (no PUT, applied:false)", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context, written } = fakeContext(cfg);
  const { f, calls } = routedFetcher((method) => {
    if (method === "GET") return { body: { data: liveSettingsFixture() } };
    return { body: { data: { needs_restart: false } } };
  });

  await settingsMethods.reconcileSettings.execute(
    { desired: { "app.root_url": "https://lists.example.org" }, _fetch: f },
    context,
  );

  // Already converged: GET to diff, then NO PUT.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assertEquals(written[0].data.applied, false);
  assertEquals(written[0].data.wouldChangeCount, 0);
  assertEquals(written[0].data.preview, null);
});

Deno.test("reconcileSettings: live run with drift PUTs and records applied:true", async () => {
  const cfg = mkCfg({ dryRun: false });
  const { context, written } = fakeContext(cfg);
  const { f, calls } = routedFetcher((method) => {
    if (method === "GET") return { body: { data: liveSettingsFixture() } };
    return { body: { data: { needs_restart: false } } };
  });

  await settingsMethods.reconcileSettings.execute(
    { desired: { "app.from_email": "announce@example.org" }, _fetch: f },
    context,
  );

  // GET (diff) + GET (shared write path) + PUT. At least one PUT must fire.
  const puts = calls.filter((c) => c.method === "PUT");
  assertEquals(puts.length, 1);
  assertEquals(puts[0].url.endsWith("api/settings"), true);
  const rec = written[0];
  assertEquals(rec.data.dryRun, false);
  assertEquals(rec.data.applied, true);
  assertEquals(rec.data.wouldChangeCount, 1);
  assertEquals(rec.data.preview, null);
});
