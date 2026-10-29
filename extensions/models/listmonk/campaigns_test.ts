/**
 * Unit tests for the `@shrug/listmonk` campaigns module (Phase 4).
 *
 * Two layers:
 *  - Pure helpers: the status transition matrix, the TIER-2
 *    transmitting-status predicate, header/template-body validation,
 *    RFC3339 future-timestamp checking, preview truncation, and the
 *    camelCase->wire body builder.
 *  - Method paths driven through a mocked `fetch` seam ({@link FetchLike}) —
 *    no network is hit. The critical cases prove sendCampaign/
 *    scheduleCampaign/testCampaign/setCampaignStatus(running|scheduled)
 *    NEVER issue a transmitting HTTP call unless BOTH dryRun=false AND
 *    confirmSend=true.
 *
 * Run with: `deno test -A extensions/models/listmonk/campaigns_test.ts`
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import type { ExecuteContext, FetchLike, GlobalArgs } from "./http.ts";
import {
  buildCampaignBody,
  CAMPAIGN_STATUS_TRANSITIONS,
  campaignsMethods,
  extractRows,
  isFutureRfc3339,
  isTransmittingStatus,
  PREVIEW_MAX_CHARS,
  summarizeCampaign,
  summarizeCampaignStat,
  summarizeTemplate,
  TEMPLATE_CONTENT_MARKER,
  truncatePreviewContent,
  validateCampaignHeaders,
  validateCampaignTemplateBody,
  validateStatusTransition,
} from "./campaigns.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CFG: GlobalArgs = {
  baseUrl: "https://listmonk.example.invalid",
  apiUser: "swamp-ops",
  apiToken: "test-token",
  perPage: 100,
  dryRun: true,
  maxRetries: 0,
};

function cfg(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return { ...BASE_CFG, ...overrides };
}

interface FetchRec {
  method?: string;
  url: string;
  body?: unknown;
}

interface QueuedResponse {
  status?: number;
  statusText?: string;
  json?: unknown;
  raw?: string;
}

/** A fake {@link FetchLike} that serves queued responses in order (the last
 * queued response repeats once exhausted). Records every call made. */
function mockFetch(
  responses: QueuedResponse[],
): { f: FetchLike; calls: FetchRec[] } {
  const calls: FetchRec[] = [];
  let i = 0;
  const f: FetchLike = (url, init) => {
    calls.push({ method: init?.method, url, body: init?.body });
    const resp = responses[Math.min(i, responses.length - 1)] ?? {};
    i++;
    const status = resp.status ?? 200;
    const text = resp.raw !== undefined
      ? resp.raw
      : JSON.stringify(resp.json ?? {});
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: resp.statusText ?? "OK",
      text: () => Promise.resolve(text),
      headers: { get: (_n: string) => null },
    });
  };
  return { f, calls };
}

interface WriteCall {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

function stubContext(globalArgs: GlobalArgs): {
  context: ExecuteContext;
  writes: WriteCall[];
  warnings: Array<{ message: string; data?: Record<string, unknown> }>;
} {
  const writes: WriteCall[] = [];
  const warnings: Array<{ message: string; data?: Record<string, unknown> }> =
    [];
  const noop = (_m: string, _p?: Record<string, unknown>) => {};
  const context: ExecuteContext = {
    globalArgs,
    logger: {
      debug: noop,
      info: noop,
      warning: (m: string, p?: Record<string, unknown>) => {
        warnings.push({ message: m, ...(p !== undefined ? { data: p } : {}) });
      },
      error: noop,
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, writes, warnings };
}

function campaignRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 42,
    uuid: "11111111-1111-1111-1111-111111111111",
    name: "October announce",
    subject: "Hello",
    status: "draft",
    content_type: "richtext",
    tags: ["announce"],
    lists: [{ id: 1, name: "Announce" }],
    template_id: 1,
    send_at: null,
    started_at: null,
    to_send: 0,
    sent: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("CAMPAIGN_STATUS_TRANSITIONS matches the pinned v6.2.0 matrix", () => {
  assertEquals(CAMPAIGN_STATUS_TRANSITIONS.running, ["paused", "draft"]);
  assertEquals(CAMPAIGN_STATUS_TRANSITIONS.scheduled, ["draft", "paused"]);
  assertEquals(CAMPAIGN_STATUS_TRANSITIONS.paused, ["running"]);
  assertEquals(CAMPAIGN_STATUS_TRANSITIONS.cancelled, ["running", "paused"]);
  assertEquals(CAMPAIGN_STATUS_TRANSITIONS.draft, ["scheduled"]);
  assertEquals(CAMPAIGN_STATUS_TRANSITIONS.finished, undefined);
});

Deno.test("isTransmittingStatus: only running|scheduled transmit", () => {
  assertEquals(isTransmittingStatus("running"), true);
  assertEquals(isTransmittingStatus("scheduled"), true);
  assertEquals(isTransmittingStatus("draft"), false);
  assertEquals(isTransmittingStatus("paused"), false);
  assertEquals(isTransmittingStatus("cancelled"), false);
});

Deno.test("validateStatusTransition: legal transitions pass silently", () => {
  validateStatusTransition("running", "draft");
  validateStatusTransition("running", "paused");
  validateStatusTransition("scheduled", "draft");
  validateStatusTransition("paused", "running");
  validateStatusTransition("cancelled", "running");
  validateStatusTransition("cancelled", "paused");
  validateStatusTransition("draft", "scheduled");
});

Deno.test("validateStatusTransition: illegal transition throws a clear error", () => {
  assertThrows(
    () => validateStatusTransition("paused", "draft"),
    Error,
    "illegal campaign status transition",
  );
  assertThrows(
    () => validateStatusTransition("running", "cancelled"),
    Error,
    "illegal campaign status transition",
  );
});

Deno.test("validateStatusTransition: 'finished' is explicitly not settable", () => {
  assertThrows(
    () => validateStatusTransition("finished", "running"),
    Error,
    "not a settable status",
  );
});

Deno.test("validateStatusTransition: unknown target throws", () => {
  assertThrows(
    () => validateStatusTransition("bogus", "draft"),
    Error,
    "unknown target campaign status",
  );
});

Deno.test("validateCampaignHeaders: rejects multi-key and empty-key entries", () => {
  validateCampaignHeaders([{ "X-A": "1" }, { "X-B": "2" }]); // ok
  assertThrows(
    () => validateCampaignHeaders([{ "X-A": "1", "X-B": "2" }]),
    Error,
    "SINGLE-KEY",
  );
  assertThrows(
    () => validateCampaignHeaders([{}]),
    Error,
    "SINGLE-KEY",
  );
});

Deno.test("validateCampaignTemplateBody: campaign type requires the literal marker", () => {
  validateCampaignTemplateBody(
    "campaign",
    `<div>${TEMPLATE_CONTENT_MARKER}</div>`,
  );
  assertThrows(
    () => validateCampaignTemplateBody("campaign", "<div>no marker here</div>"),
    Error,
    TEMPLATE_CONTENT_MARKER,
  );
  // Non-campaign types are not subject to the rule.
  validateCampaignTemplateBody("tx", "<div>no marker needed</div>");
});

Deno.test("isFutureRfc3339: future passes, past/invalid fail", () => {
  const now = new Date("2026-10-28T00:00:00Z");
  assertEquals(isFutureRfc3339("2026-11-01T00:00:00Z", now), true);
  assertEquals(isFutureRfc3339("2026-01-01T00:00:00Z", now), false);
  assertEquals(isFutureRfc3339("not-a-date", now), false);
});

Deno.test("truncatePreviewContent: passes short content through untouched", () => {
  const r = truncatePreviewContent("hello world");
  assertEquals(r, {
    content: "hello world",
    truncated: false,
    contentLength: 11,
  });
});

Deno.test("truncatePreviewContent: truncates past the max and reports the original length", () => {
  const big = "x".repeat(PREVIEW_MAX_CHARS + 500);
  const r = truncatePreviewContent(big);
  assertEquals(r.truncated, true);
  assertEquals(r.contentLength, PREVIEW_MAX_CHARS + 500);
  assertEquals(r.content.length, PREVIEW_MAX_CHARS);
});

Deno.test("buildCampaignBody: only includes fields the caller supplied (merge-friendly)", () => {
  assertEquals(buildCampaignBody({ name: "N" }), { name: "N" });
  assertEquals(
    buildCampaignBody({
      name: "N",
      subject: "S",
      lists: [1, 2],
      contentType: "html",
      templateId: 3,
      tags: ["a"],
      sendAt: "2099-01-01T00:00:00Z",
      media: [9],
      headers: [{ "X-A": "1" }],
    }),
    {
      name: "N",
      subject: "S",
      lists: [1, 2],
      content_type: "html",
      template_id: 3,
      tags: ["a"],
      send_at: "2099-01-01T00:00:00Z",
      media: [9],
      headers: [{ "X-A": "1" }],
    },
  );
});

Deno.test("summarizeCampaign: maps snake_case wire fields to the resource shape", () => {
  const s = summarizeCampaign(campaignRow());
  assertEquals(s.id, 42);
  assertEquals(s.contentType, "richtext");
  assertEquals(s.lists, [{ id: 1, name: "Announce" }]);
  assertEquals(s.templateId, 1);
});

Deno.test("summarizeCampaignStat + summarizeTemplate: map snake_case fields", () => {
  const stat = summarizeCampaignStat({
    id: 5,
    status: "running",
    to_send: 100,
    sent: 40,
  });
  assertEquals(stat, {
    id: 5,
    status: "running",
    toSend: 100,
    sent: 40,
    startedAt: null,
    updatedAt: null,
  });

  const tmpl = summarizeTemplate({
    id: 7,
    name: "Default",
    type: "campaign",
    is_default: true,
  });
  assertEquals(tmpl.isDefault, true);
  assertEquals(tmpl.type, "campaign");
});

Deno.test("extractRows: handles both bare-array and {results} envelope shapes", () => {
  assertEquals(extractRows({ data: [{ id: 1 }] }), [{ id: 1 }]);
  assertEquals(extractRows({ data: { results: [{ id: 2 }] } }), [{ id: 2 }]);
  assertEquals(extractRows({ data: {} }), []);
  assertEquals(extractRows({}), []);
});

// ---------------------------------------------------------------------------
// setCampaignStatus / sendCampaign / scheduleCampaign — THE TIER-2 GATE
// ---------------------------------------------------------------------------

Deno.test("sendCampaign: dryRun=true (default), confirmSend absent -> NO status PUT is issued", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "paused" }) },
  }]);
  const { context, writes, warnings } = stubContext(cfg({ dryRun: true }));
  const result = await campaignsMethods.sendCampaign.execute(
    { campaignId: 42, confirmSend: false, _fetch: f },
    context,
  );
  // Only the GET (read) happened; no PUT .../status call was ever made.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  // `running` is a TRANSMITTING target, so even a plain dryRun (no explicit
  // confirmSend) is recorded as a TIER-2 send-gate block, not a generic
  // "would-transition" dry run.
  assertEquals(writes[0].data.action, "blocked-send-gate");
  assertEquals(writes[0].data.transmitting, true);
  assertEquals(result.dataHandles.length, 1);
  assertEquals(warnings.some((w) => w.message.includes("BLOCKED")), true);
});

Deno.test("sendCampaign: dryRun=false but confirmSend missing -> BLOCKED, no status PUT", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "paused" }) },
  }]);
  const { context, writes, warnings } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.sendCampaign.execute(
    { campaignId: 42, confirmSend: false, _fetch: f },
    context,
  );
  assertEquals(calls.length, 1); // only the GET
  assertEquals(calls[0].method, "GET");
  assertEquals(writes[0].data.action, "blocked-send-gate");
  assertEquals(warnings.some((w) => w.message.includes("BLOCKED")), true);
});

Deno.test("sendCampaign: confirmSend=true but dryRun stays true (default) -> BLOCKED, no status PUT", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "paused" }) },
  }]);
  const { context, writes } = stubContext(cfg({ dryRun: true }));
  await campaignsMethods.sendCampaign.execute(
    { campaignId: 42, confirmSend: true, _fetch: f },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(writes[0].data.action, "blocked-send-gate");
});

Deno.test("sendCampaign: dryRun=false AND confirmSend=true -> the status PUT IS issued", async () => {
  const { f, calls } = mockFetch([
    { json: { data: campaignRow({ status: "paused" }) } }, // GET
    { json: { data: true } }, // PUT .../status
  ]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.sendCampaign.execute(
    { campaignId: 42, confirmSend: true, _fetch: f },
    context,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, "PUT");
  assertEquals(calls[1].url.endsWith("/api/campaigns/42/status"), true);
  assertEquals(JSON.parse(String(calls[1].body)), { status: "running" });
  assertEquals(writes[0].data.action, "transitioned");
});

Deno.test("sendCampaign: illegal transition (already draft->draft target 'running' from 'draft' is legal, but from 'scheduled' it is not) throws before any write call", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "scheduled" }) },
  }]);
  const { context } = stubContext(cfg({ dryRun: false }));
  await assertRejects(
    () =>
      campaignsMethods.sendCampaign.execute(
        { campaignId: 42, confirmSend: true, _fetch: f },
        context,
      ),
    Error,
    "illegal campaign status transition",
  );
  assertEquals(calls.length, 1); // only the GET — the illegal transition is caught before any PUT
});

Deno.test("scheduleCampaign: dryRun=true -> NO status PUT and NO send_at PUT, even though sendAt is supplied", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "draft", send_at: null }) },
  }]);
  const { context, writes } = stubContext(cfg({ dryRun: true }));
  await campaignsMethods.scheduleCampaign.execute(
    {
      campaignId: 42,
      sendAt: "2099-01-01T00:00:00Z",
      confirmSend: true,
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 1); // only the GET
  assertEquals(writes[0].data.action, "blocked-send-gate");
  assertEquals(writes[0].data.sendAt, "2099-01-01T00:00:00Z");
});

Deno.test("scheduleCampaign: gate open, sendAt differs from existing -> PUTs send_at THEN PUTs status", async () => {
  const { f, calls } = mockFetch([
    { json: { data: campaignRow({ status: "draft", send_at: null }) } }, // GET
    { json: { data: true } }, // PUT send_at
    { json: { data: true } }, // PUT status
  ]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.scheduleCampaign.execute(
    {
      campaignId: 42,
      sendAt: "2099-01-01T00:00:00Z",
      confirmSend: true,
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 3);
  assertEquals(calls[1].method, "PUT");
  assertEquals(calls[1].url.endsWith("/api/campaigns/42"), true);
  assertEquals(JSON.parse(String(calls[1].body)), {
    send_at: "2099-01-01T00:00:00Z",
  });
  assertEquals(calls[2].method, "PUT");
  assertEquals(calls[2].url.endsWith("/api/campaigns/42/status"), true);
  assertEquals(writes[0].data.action, "transitioned");
});

Deno.test("scheduleCampaign: a past sendAt throws before any PUT", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "draft" }) },
  }]);
  const { context } = stubContext(cfg({ dryRun: false }));
  await assertRejects(
    () =>
      campaignsMethods.scheduleCampaign.execute(
        {
          campaignId: 42,
          sendAt: "2000-01-01T00:00:00Z",
          confirmSend: true,
          _fetch: f,
        },
        context,
      ),
    Error,
    "FUTURE RFC3339",
  );
  assertEquals(calls.length, 1); // only the GET
});

Deno.test("setCampaignStatus: scheduled with no existing AND no supplied send_at throws needsSendAt, no PUT", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "draft", send_at: null }) },
  }]);
  const { context } = stubContext(cfg({ dryRun: false }));
  await assertRejects(
    () =>
      campaignsMethods.setCampaignStatus.execute(
        { campaignId: 42, status: "scheduled", confirmSend: true, _fetch: f },
        context,
      ),
    Error,
    "needsSendAt",
  );
  assertEquals(calls.length, 1);
});

Deno.test("pauseCampaign (TIER-1): dryRun=true blocks, dryRun=false (no confirmSend needed) performs the PUT", async () => {
  // dryRun=true -> blocked
  {
    const { f, calls } = mockFetch([{
      json: { data: campaignRow({ status: "running" }) },
    }]);
    const { context, writes } = stubContext(cfg({ dryRun: true }));
    await campaignsMethods.pauseCampaign.execute(
      { campaignId: 42, _fetch: f },
      context,
    );
    assertEquals(calls.length, 1);
    assertEquals(writes[0].data.action, "would-transition");
  }
  // dryRun=false -> live, no confirmSend required (not transmitting)
  {
    const { f, calls } = mockFetch([
      { json: { data: campaignRow({ status: "running" }) } },
      { json: { data: true } },
    ]);
    const { context, writes } = stubContext(cfg({ dryRun: false }));
    await campaignsMethods.pauseCampaign.execute(
      { campaignId: 42, _fetch: f },
      context,
    );
    assertEquals(calls.length, 2);
    assertEquals(calls[1].method, "PUT");
    assertEquals(writes[0].data.action, "transitioned");
  }
});

Deno.test("cancelCampaign (TIER-1): illegal source status throws, no PUT", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "draft" }) },
  }]);
  const { context } = stubContext(cfg({ dryRun: false }));
  await assertRejects(
    () =>
      campaignsMethods.cancelCampaign.execute(
        { campaignId: 42, _fetch: f },
        context,
      ),
    Error,
    "illegal campaign status transition",
  );
  assertEquals(calls.length, 1);
});

// ---------------------------------------------------------------------------
// testCampaign — TIER-2 GATE
// ---------------------------------------------------------------------------

Deno.test("testCampaign: dryRun=true (default) -> NO test POST is issued", async () => {
  const { f, calls } = mockFetch([{ json: { data: true } }]);
  const { context, writes } = stubContext(cfg({ dryRun: true }));
  await campaignsMethods.testCampaign.execute(
    {
      campaignId: 42,
      emails: ["a@example.invalid"],
      confirmSend: false,
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 0);
  assertEquals(writes[0].data.action, "blocked-send-gate");
});

Deno.test("testCampaign: dryRun=false but confirmSend missing -> BLOCKED, no POST", async () => {
  const { f, calls } = mockFetch([{ json: { data: true } }]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.testCampaign.execute(
    {
      campaignId: 42,
      emails: ["a@example.invalid"],
      confirmSend: false,
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 0);
  assertEquals(writes[0].data.action, "blocked-send-gate");
});

Deno.test("testCampaign: dryRun=false AND confirmSend=true -> the test POST IS issued", async () => {
  const { f, calls } = mockFetch([{ json: { data: true } }]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.testCampaign.execute(
    {
      campaignId: 42,
      emails: ["a@example.invalid", "b@example.invalid"],
      confirmSend: true,
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url.endsWith("/api/campaigns/42/test"), true);
  assertEquals(JSON.parse(String(calls[0].body)), {
    subscribers: ["a@example.invalid", "b@example.invalid"],
  });
  assertEquals(writes[0].data.action, "tested");
});

// ---------------------------------------------------------------------------
// createCampaign / updateCampaign — TIER-1 GATE
// ---------------------------------------------------------------------------

Deno.test("createCampaign: dryRun=true (default) -> NO POST, a would-create preview", async () => {
  const { f, calls } = mockFetch([]);
  const { context, writes } = stubContext(cfg({ dryRun: true }));
  await campaignsMethods.createCampaign.execute(
    {
      name: "October announce",
      subject: "Hello",
      lists: [1],
      contentType: "richtext",
      tags: [],
      messenger: "email",
      media: [],
      headers: [],
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 0);
  assertEquals(writes[0].data.action, "would-create");
  assertEquals(writes[0].data.campaignId, null);
});

Deno.test("createCampaign: dryRun=false -> POSTs and the campaign ALWAYS comes back draft", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ id: 99, status: "draft" }) },
  }]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.createCampaign.execute(
    {
      name: "October announce",
      subject: "Hello",
      lists: [1],
      contentType: "richtext",
      tags: [],
      messenger: "email",
      media: [],
      headers: [],
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  const campaign = writes[0].data.campaign as { status: string; id: number };
  assertEquals(campaign.status, "draft");
  assertEquals(campaign.id, 99);
});

Deno.test("createCampaign: rejects a malformed single-key headers entry before any POST", async () => {
  const { f, calls } = mockFetch([]);
  const { context } = stubContext(cfg({ dryRun: false }));
  await assertRejects(
    () =>
      campaignsMethods.createCampaign.execute(
        {
          name: "N",
          subject: "S",
          lists: [1],
          contentType: "richtext",
          tags: [],
          messenger: "email",
          media: [],
          headers: [{ "X-A": "1", "X-B": "2" }],
          _fetch: f,
        },
        context,
      ),
    Error,
    "SINGLE-KEY",
  );
  assertEquals(calls.length, 0);
});

Deno.test("updateCampaign: refuses when campaign status is not draft|paused|scheduled", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "running" }) },
  }]);
  const { context } = stubContext(cfg({ dryRun: false }));
  await assertRejects(
    () =>
      campaignsMethods.updateCampaign.execute(
        { campaignId: 42, name: "New name", _fetch: f },
        context,
      ),
    Error,
    "cantUpdate",
  );
  assertEquals(calls.length, 1); // only the GET — no PUT was attempted
});

Deno.test("updateCampaign: dryRun=true -> NO PUT, a would-update preview", async () => {
  const { f, calls } = mockFetch([{
    json: { data: campaignRow({ status: "draft" }) },
  }]);
  const { context, writes } = stubContext(cfg({ dryRun: true }));
  await campaignsMethods.updateCampaign.execute(
    { campaignId: 42, name: "New name", _fetch: f },
    context,
  );
  assertEquals(calls.length, 1); // GET only
  assertEquals(writes[0].data.action, "would-update");
});

Deno.test("updateCampaign: dryRun=false and status draft -> PUTs only the supplied fields", async () => {
  const { f, calls } = mockFetch([
    { json: { data: campaignRow({ status: "draft" }) } },
    { json: { data: true } },
  ]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.updateCampaign.execute(
    { campaignId: 42, name: "New name", _fetch: f },
    context,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, "PUT");
  assertEquals(JSON.parse(String(calls[1].body)), { name: "New name" });
  assertEquals(writes[0].data.action, "updated");
});

// ---------------------------------------------------------------------------
// Reads: listCampaigns / getCampaign / getRunningCampaignStats / previewCampaign
// ---------------------------------------------------------------------------

Deno.test("listCampaigns: paginates via lmFetchAll and writes summaries", async () => {
  const { f } = mockFetch([
    {
      json: {
        data: {
          results: [campaignRow({ id: 1 }), campaignRow({ id: 2 })],
          total: 2,
          page: 1,
          per_page: 100,
        },
      },
    },
  ]);
  const { context, writes } = stubContext(cfg());
  await campaignsMethods.listCampaigns.execute({ _fetch: f }, context);
  assertEquals(writes[0].data.count, 2);
  const campaigns = writes[0].data.campaigns as Array<{ id: number }>;
  assertEquals(campaigns.map((c) => c.id), [1, 2]);
});

Deno.test("getCampaign: found:false/campaign:null when the API returns no data", async () => {
  const { f } = mockFetch([{ json: { data: null } }]);
  const { context, writes } = stubContext(cfg());
  await campaignsMethods.getCampaign.execute(
    { campaignId: 999, _fetch: f },
    context,
  );
  assertEquals(writes[0].data.found, false);
  assertEquals(writes[0].data.campaign, null);
});

Deno.test("getRunningCampaignStats: maps the stats rows", async () => {
  const { f } = mockFetch([{
    json: { data: [{ id: 1, status: "running", to_send: 50, sent: 10 }] },
  }]);
  const { context, writes } = stubContext(cfg());
  await campaignsMethods.getRunningCampaignStats.execute(
    { _fetch: f },
    context,
  );
  const stats = writes[0].data.stats as Array<{ id: number; sent: number }>;
  assertEquals(stats[0].id, 1);
  assertEquals(stats[0].sent, 10);
});

Deno.test("previewCampaign: reads RAW text via opts.raw (not the {data:...} envelope)", async () => {
  const { f, calls } = mockFetch([{ raw: "<html><body>Hi</body></html>" }]);
  const { context, writes } = stubContext(cfg());
  await campaignsMethods.previewCampaign.execute(
    { campaignId: 42, _fetch: f },
    context,
  );
  assertEquals(calls[0].method, "GET");
  assertEquals(writes[0].data.content, "<html><body>Hi</body></html>");
  assertEquals(writes[0].data.truncated, false);
});

Deno.test("previewCampaign: truncates a huge raw preview", async () => {
  const big = "<p>" + "x".repeat(PREVIEW_MAX_CHARS + 1000) + "</p>";
  const { f } = mockFetch([{ raw: big }]);
  const { context, writes } = stubContext(cfg());
  await campaignsMethods.previewCampaign.execute(
    { campaignId: 42, _fetch: f },
    context,
  );
  assertEquals(writes[0].data.truncated, true);
  assertEquals((writes[0].data.content as string).length, PREVIEW_MAX_CHARS);
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

Deno.test("listTemplates / getTemplate: happy path", async () => {
  {
    const { f } = mockFetch([
      { json: { data: [{ id: 1, name: "Default", type: "campaign" }] } },
    ]);
    const { context, writes } = stubContext(cfg());
    await campaignsMethods.listTemplates.execute({ _fetch: f }, context);
    assertEquals(writes[0].data.count, 1);
  }
  {
    const { f } = mockFetch([
      {
        json: {
          data: {
            id: 1,
            name: "Default",
            type: "campaign",
            body: "<html></html>",
          },
        },
      },
    ]);
    const { context, writes } = stubContext(cfg());
    await campaignsMethods.getTemplate.execute(
      { templateId: 1, _fetch: f },
      context,
    );
    assertEquals(writes[0].data.found, true);
    assertEquals(writes[0].data.body, "<html></html>");
  }
});

Deno.test("upsertTemplate: rejects a campaign-type body missing the content marker, no HTTP call", async () => {
  const { f, calls } = mockFetch([]);
  const { context } = stubContext(cfg({ dryRun: false }));
  await assertRejects(
    () =>
      campaignsMethods.upsertTemplate.execute(
        {
          name: "Bad",
          type: "campaign",
          body: "<html>no marker</html>",
          _fetch: f,
        },
        context,
      ),
    Error,
    TEMPLATE_CONTENT_MARKER,
  );
  assertEquals(calls.length, 0);
});

Deno.test("upsertTemplate: dryRun=true -> NO POST, would-create preview", async () => {
  const { f, calls } = mockFetch([]);
  const { context, writes } = stubContext(cfg({ dryRun: true }));
  await campaignsMethods.upsertTemplate.execute(
    {
      name: "Good",
      type: "campaign",
      body: `<html>${TEMPLATE_CONTENT_MARKER}</html>`,
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 0);
  assertEquals(writes[0].data.action, "would-create");
});

Deno.test("upsertTemplate: dryRun=false with templateId -> PUTs an update", async () => {
  const { f, calls } = mockFetch([{ json: { data: { id: 5 } } }]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.upsertTemplate.execute(
    {
      templateId: 5,
      name: "Good",
      type: "tx",
      body: "<html>no marker needed</html>",
      _fetch: f,
    },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "PUT");
  assertEquals(writes[0].data.action, "updated");
  assertEquals(writes[0].data.templateId, 5);
});

Deno.test("deleteTemplate: dryRun=true -> verifies existence (GET) but issues NO DELETE", async () => {
  const { f, calls } = mockFetch([{ json: { data: { id: 5 } } }]);
  const { context, writes } = stubContext(cfg({ dryRun: true }));
  await campaignsMethods.deleteTemplate.execute(
    { templateId: 5, _fetch: f },
    context,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assertEquals(writes[0].data.action, "would-delete");
});

Deno.test("deleteTemplate: dryRun=false -> GET then DELETE", async () => {
  const { f, calls } = mockFetch([
    { json: { data: { id: 5 } } },
    { json: { data: true } },
  ]);
  const { context, writes } = stubContext(cfg({ dryRun: false }));
  await campaignsMethods.deleteTemplate.execute(
    { templateId: 5, _fetch: f },
    context,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, "DELETE");
  assertEquals(writes[0].data.action, "deleted");
});

Deno.test("setDefaultTemplate: dryRun=true blocks, dryRun=false PUTs /default", async () => {
  {
    const { f, calls } = mockFetch([]);
    const { context, writes } = stubContext(cfg({ dryRun: true }));
    await campaignsMethods.setDefaultTemplate.execute({
      templateId: 5,
      _fetch: f,
    }, context);
    assertEquals(calls.length, 0);
    assertEquals(writes[0].data.action, "would-set-default");
  }
  {
    const { f, calls } = mockFetch([{ json: { data: [{ id: 5 }] } }]);
    const { context, writes } = stubContext(cfg({ dryRun: false }));
    await campaignsMethods.setDefaultTemplate.execute({
      templateId: 5,
      _fetch: f,
    }, context);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url.endsWith("/api/templates/5/default"), true);
    assertEquals(writes[0].data.action, "set-default");
  }
});
