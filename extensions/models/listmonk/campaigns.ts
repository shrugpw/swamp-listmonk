/**
 * @shrug/listmonk — Phase 4: campaigns domain (create/update/status/test/
 * preview/stats + template CRUD).
 *
 * ===========================================================================
 * SENDS ARE HARD-GATED. READ THIS BEFORE TOUCHING ANYTHING BELOW.
 * ===========================================================================
 * Two tiers of write gate, enforced in code (not just by convention):
 *
 *   TIER 1 (normal writes — createCampaign, updateCampaign, setCampaignStatus
 *   to a NON-transmitting target [draft|paused|cancelled], pauseCampaign,
 *   cancelCampaign, template create/update/delete/setDefault): gated on
 *   `ctx.globalArgs.dryRun === false`. When dryRun is true (the default),
 *   NO mutating HTTP call is issued — a would-do preview is written instead.
 *
 *   TIER 2 (ANYTHING THAT TRANSMITS EMAIL — sendCampaign, scheduleCampaign,
 *   testCampaign, and setCampaignStatus transitioning to `running` or
 *   `scheduled`): requires BOTH `ctx.globalArgs.dryRun === false` AND an
 *   explicit per-call `confirmSend: true` argument. If either is missing,
 *   NO transmitting HTTP call is issued — not the status PUT, not the test
 *   POST, not even a precursor PUT that sets send_at. A preview is written
 *   instead. This is the hard safety gate referenced by
 *   never-dryRun-false-without-approval; there is exactly ONE code path
 *   (`runSetCampaignStatus`) that performs a transmitting status transition,
 *   and its gate check uses strict `=== false` / `=== true` comparisons so
 *   the condition can't be satisfied by an unrelated truthy/falsy value.
 *
 * Pinned v6.2.0 contract (see design/listmonk-extension.md for the full
 * writeup):
 *   - POST /api/campaigns (campaigns:manage) ALWAYS lands in draft. There is
 *     NO create-and-send. Request field is `lists` (int[]) even though the
 *     model calls it ListIDs; `media` is int[]; lists are silently filtered
 *     to the token's permitted lists. content_type one of
 *     richtext|html|markdown|plain|visual. `headers` is an ARRAY of
 *     single-key objects. `send_at` must be a FUTURE RFC3339 timestamp.
 *   - PUT /api/campaigns/:id (campaigns:manage): merge semantics; editable
 *     ONLY when status is draft|paused|scheduled (else 400 cantUpdate).
 *   - PUT /api/campaigns/:id/status (perm campaigns:SEND — a DISTINCT
 *     permission from campaigns:manage): THE send/transition endpoint.
 *     Allowed transitions: running<-{paused,draft}; scheduled<-{draft,paused}
 *     AND send_at must be set (else 400 needsSendAt); paused<-{running};
 *     cancelled<-{running,paused}; draft<-{scheduled}. 'finished' is NOT
 *     settable via the API.
 *   - POST /api/campaigns/:id/test (campaigns:manage): sends a test to
 *     EXISTING subscriber emails the token can access (unknown emails are
 *     dropped; if ALL are dropped -> 400).
 *   - Preview endpoints return RAW html/text, NOT the `{data:...}` envelope
 *     -> call lmFetch with `opts.raw: true` and read `.raw`.
 *   - Templates: GET|POST /api/templates, PUT /api/templates/:id, PUT
 *     /api/templates/:id/default (returns the templates LIST, not the
 *     template), DELETE /api/templates/:id. A campaign-type template body
 *     MUST contain the literal `{{ template "content" . }}` marker or
 *     POST/PUT 400s — validated client-side before any request.
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

// Exact lowercase enum (v6.2.0). A bad value is rejected client-side before
// any request — listmonk does not cleanly 4xx every bad enum here.
const CONTENT_TYPES = [
  "richtext",
  "html",
  "markdown",
  "plain",
  "visual",
] as const;
const ContentTypeSchema = z.enum(CONTENT_TYPES);

// PUT /api/campaigns/:id only succeeds in these statuses (else 400 cantUpdate).
const UPDATABLE_STATUSES = ["draft", "paused", "scheduled"] as const;

// The literal marker a campaign-type template body must contain, or
// POST/PUT /api/templates 400s server-side.
export const TEMPLATE_CONTENT_MARKER = '{{ template "content" . }}';

// Preview content is truncated past this length before being written to a
// resource — campaign bodies can be large and this is a read-only snapshot.
export const PREVIEW_MAX_CHARS = 20000;

// ---------------------------------------------------------------------------
// The status transition matrix (pinned contract). Keyed by TARGET status;
// value is the set of statuses it may transition FROM. 'finished' is
// deliberately absent — it is not settable via the API.
// ---------------------------------------------------------------------------
export const CAMPAIGN_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  running: ["paused", "draft"],
  scheduled: ["draft", "paused"],
  paused: ["running"],
  cancelled: ["running", "paused"],
  draft: ["scheduled"],
};

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const CampaignListRefSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const CampaignSummarySchema = z.object({
  id: z.number(),
  uuid: z.string().optional(),
  name: z.string(),
  subject: z.string(),
  status: z.string(),
  contentType: z.string(),
  type: z.string().optional(),
  tags: z.array(z.string()),
  lists: z.array(CampaignListRefSchema),
  templateId: z.number().nullable(),
  sendAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  toSend: z.number().nullable(),
  sent: z.number().nullable(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const CampaignsSchema = z.object({
  retrievedAt: z.string(),
  count: z.number(),
  campaigns: z.array(CampaignSummarySchema),
});

const CampaignSchema = z.object({
  retrievedAt: z.string(),
  found: z.boolean(),
  campaign: CampaignSummarySchema.nullable(),
});

const CampaignWriteSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  campaignId: z.number().nullable(),
  action: z.string(), // would-create|created|would-update|updated|would-test|tested|blocked-send-gate
  requestBody: z.record(z.string(), z.unknown()),
  campaign: CampaignSummarySchema.nullable().optional(),
});

const CampaignStatusSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  confirmSend: z.boolean(),
  campaignId: z.number(),
  fromStatus: z.string().nullable(),
  toStatus: z.string(),
  transmitting: z.boolean(),
  action: z.string(), // would-transition|transitioned|blocked-send-gate
  sendAt: z.string().nullable(),
});

const CampaignStatRowSchema = z.object({
  id: z.number(),
  status: z.string(),
  toSend: z.number().nullable(),
  sent: z.number().nullable(),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const CampaignStatsSchema = z.object({
  retrievedAt: z.string(),
  stats: z.array(CampaignStatRowSchema),
});

const CampaignPreviewSchema = z.object({
  retrievedAt: z.string(),
  campaignId: z.number(),
  contentLength: z.number(),
  truncated: z.boolean(),
  content: z.string(),
});

const TemplateSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  subject: z.string().optional(),
  isDefault: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const TemplatesSchema = z.object({
  retrievedAt: z.string(),
  count: z.number(),
  templates: z.array(TemplateSummarySchema),
});

const TemplateSchema = z.object({
  retrievedAt: z.string(),
  found: z.boolean(),
  template: TemplateSummarySchema.nullable(),
  body: z.string().nullable(),
});

const TemplateWriteSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  templateId: z.number().nullable(),
  action: z.string(), // would-create|created|would-update|updated|would-delete|deleted|not-found|would-set-default|set-default
  requestBody: z.record(z.string(), z.unknown()),
});

export const campaignsResources: ResourceMap = {
  campaigns: {
    description: "All campaigns (summaries). Written by listCampaigns.",
    schema: CampaignsSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  campaign: {
    description: "A single campaign lookup (by id via getCampaign). " +
      "found:false/campaign:null means no match.",
    schema: CampaignSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  campaignWrite: {
    description:
      "Audit of a createCampaign/updateCampaign/testCampaign run: the " +
      "resolved would-do preview or the live result. Never carries secrets.",
    schema: CampaignWriteSchema,
    lifetime: "infinite",
    garbageCollection: 30,
  },
  campaignStatus: {
    description:
      "Audit of a campaign status transition (setCampaignStatus and its " +
      "convenience wrappers sendCampaign/scheduleCampaign/pauseCampaign/" +
      "cancelCampaign). `transmitting:true` + `action:blocked-send-gate` " +
      "records a TIER-2-blocked attempt — no email was sent.",
    schema: CampaignStatusSchema,
    lifetime: "infinite",
    garbageCollection: 30,
  },
  campaignStats: {
    description:
      "Live counters for in-flight campaigns (getRunningCampaignStats).",
    schema: CampaignStatsSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  campaignPreview: {
    description: "Rendered campaign preview (raw html/text, truncated past " +
      `${PREVIEW_MAX_CHARS} chars). Written by previewCampaign.`,
    schema: CampaignPreviewSchema,
    lifetime: "infinite",
    garbageCollection: 5,
  },
  templates: {
    description: "All templates (summaries). Written by listTemplates.",
    schema: TemplatesSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  template: {
    description:
      "A single template lookup (by id via getTemplate), including its body.",
    schema: TemplateSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  templateWrite: {
    description:
      "Audit of an upsertTemplate/deleteTemplate/setDefaultTemplate run.",
    schema: TemplateWriteSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Shape a raw listmonk campaign row into the resource's summary fields. */
export function summarizeCampaign(raw: Record<string, unknown>) {
  const listsRaw = Array.isArray(raw.lists)
    ? raw.lists as Array<Record<string, unknown>>
    : [];
  return {
    id: Number(raw.id),
    uuid: typeof raw.uuid === "string" ? raw.uuid : undefined,
    name: String(raw.name ?? ""),
    subject: String(raw.subject ?? ""),
    status: String(raw.status ?? ""),
    contentType: String(raw.content_type ?? ""),
    type: typeof raw.type === "string" ? raw.type : undefined,
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : [],
    lists: listsRaw.map((l) => ({
      id: Number(l.id),
      name: String(l.name ?? ""),
    })),
    templateId: typeof raw.template_id === "number" ? raw.template_id : null,
    sendAt: typeof raw.send_at === "string" ? raw.send_at : null,
    startedAt: typeof raw.started_at === "string" ? raw.started_at : null,
    toSend: typeof raw.to_send === "number" ? raw.to_send : null,
    sent: typeof raw.sent === "number" ? raw.sent : null,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
  };
}

/** Shape a raw listmonk running-stats row into the resource's row fields. */
export function summarizeCampaignStat(raw: Record<string, unknown>) {
  return {
    id: Number(raw.id),
    status: String(raw.status ?? ""),
    toSend: typeof raw.to_send === "number" ? raw.to_send : null,
    sent: typeof raw.sent === "number" ? raw.sent : null,
    startedAt: typeof raw.started_at === "string" ? raw.started_at : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

/** Shape a raw listmonk template row into the resource's summary fields. */
export function summarizeTemplate(raw: Record<string, unknown>) {
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ""),
    type: String(raw.type ?? ""),
    subject: typeof raw.subject === "string" ? raw.subject : undefined,
    isDefault: typeof raw.is_default === "boolean" ? raw.is_default : undefined,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
  };
}

/**
 * Pull the row array out of a listmonk list response that may come back as
 * a bare array (`{data: [...]}`) OR a PageResults-style envelope
 * (`{data: {results: [...]}}`). Templates in particular are not paginated,
 * so this is a defensive both-shapes reader rather than full pagination.
 */
export function extractRows(
  json: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const data = json.data;
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const env = (data ?? {}) as Record<string, unknown>;
  return Array.isArray(env.results)
    ? env.results as Array<Record<string, unknown>>
    : [];
}

/** True iff `value` parses as a date strictly after `now`. */
export function isFutureRfc3339(
  value: string,
  now: Date = new Date(),
): boolean {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  return t > now.getTime();
}

/** True iff transitioning TO `status` transmits email (running|scheduled). */
export function isTransmittingStatus(status: string): boolean {
  return status === "running" || status === "scheduled";
}

/**
 * Validate a campaign status transition against the pinned matrix. Throws
 * with a clear message on an illegal transition, an unknown target, or the
 * explicitly-unsettable 'finished' target. Called UNCONDITIONALLY (dry run
 * or not) — this is a client-side correctness check, not part of the write
 * gate.
 */
export function validateStatusTransition(
  target: string,
  current: string | null,
): void {
  if (target === "finished") {
    throw new Error(
      "'finished' is not a settable status via the API — listmonk sets it " +
        "automatically when a running send completes",
    );
  }
  const allowedFrom = CAMPAIGN_STATUS_TRANSITIONS[target];
  if (!allowedFrom) {
    throw new Error(`unknown target campaign status "${target}"`);
  }
  if (current === null || !allowedFrom.includes(current)) {
    throw new Error(
      `illegal campaign status transition: ${current ?? "(unknown)"} -> ` +
        `${target}; allowed sources for "${target}" are [${
          allowedFrom.join(", ")
        }]`,
    );
  }
}

/**
 * Validate the `headers` field shape: an ARRAY of single-key objects (the
 * pinned request shape). Throws on any entry with zero or >1 keys.
 */
export function validateCampaignHeaders(
  headers: Array<Record<string, string>>,
): void {
  for (const h of headers) {
    const keys = Object.keys(h);
    if (keys.length !== 1) {
      throw new Error(
        `campaign headers must be an array of SINGLE-KEY objects; got an ` +
          `entry with ${keys.length} keys [${keys.join(", ")}]`,
      );
    }
  }
}

/**
 * Validate the campaign-type-template content rule client-side: a
 * `type: "campaign"` template body MUST contain the literal
 * `{{ template "content" . }}` marker, or listmonk 400s the create/update.
 * Other template types (e.g. tx) are not subject to this rule.
 */
export function validateCampaignTemplateBody(type: string, body: string): void {
  if (type === "campaign" && !body.includes(TEMPLATE_CONTENT_MARKER)) {
    throw new Error(
      `campaign-type template body must contain the literal ` +
        `${TEMPLATE_CONTENT_MARKER} marker, or listmonk 400s create/update`,
    );
  }
}

/** Truncate preview content past PREVIEW_MAX_CHARS, reporting the original length. */
export function truncatePreviewContent(
  text: string,
  max: number = PREVIEW_MAX_CHARS,
): { content: string; truncated: boolean; contentLength: number } {
  const contentLength = text.length;
  if (contentLength <= max) {
    return { content: text, truncated: false, contentLength };
  }
  return { content: text.slice(0, max), truncated: true, contentLength };
}

/**
 * Build the campaign create/update request body (camelCase args -> the
 * listmonk snake_case wire shape). Shared by createCampaign and
 * updateCampaign: a field is included iff the caller supplied it, so a
 * sparse updateCampaign call relies on the server's own merge/PATCH
 * semantics for everything it omits.
 */
export function buildCampaignBody(args: {
  name?: string;
  subject?: string;
  lists?: number[];
  contentType?: string;
  fromEmail?: string;
  body?: string;
  altbody?: string;
  templateId?: number;
  tags?: string[];
  messenger?: string;
  sendAt?: string;
  media?: number[];
  headers?: Array<Record<string, string>>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.name !== undefined) out.name = args.name;
  if (args.subject !== undefined) out.subject = args.subject;
  if (args.lists !== undefined) out.lists = args.lists;
  if (args.contentType !== undefined) out.content_type = args.contentType;
  if (args.fromEmail !== undefined) out.from_email = args.fromEmail;
  if (args.body !== undefined) out.body = args.body;
  if (args.altbody !== undefined) out.altbody = args.altbody;
  if (args.templateId !== undefined) out.template_id = args.templateId;
  if (args.tags !== undefined) out.tags = args.tags;
  if (args.messenger !== undefined) out.messenger = args.messenger;
  if (args.sendAt !== undefined) out.send_at = args.sendAt;
  if (args.media !== undefined) out.media = args.media;
  if (args.headers !== undefined) out.headers = args.headers;
  return out;
}

// ---------------------------------------------------------------------------
// The TIER-2 send gate — ONE code path for every transmitting/non-
// transmitting status transition. sendCampaign/scheduleCampaign/
// pauseCampaign/cancelCampaign/setCampaignStatus all funnel through this.
// ---------------------------------------------------------------------------

interface StatusTransitionArgs {
  campaignId: number | string;
  status: "draft" | "running" | "paused" | "scheduled" | "cancelled";
  sendAt?: string;
  confirmSend: boolean;
  _fetch?: FetchLike;
}

async function runSetCampaignStatus(
  context: ExecuteContext,
  args: StatusTransitionArgs,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const doFetch = args._fetch;
  const id = assertId(args.campaignId, "campaignId");

  // A read — always performed, dry run or not. It's needed to know the
  // current status (for the transition-matrix check) and the existing
  // send_at (for the scheduled precondition).
  const json = await lmFetch(cfg, "GET", `api/campaigns/${id}`, {}, doFetch);
  const raw = (json.data ?? null) as Record<string, unknown> | null;
  if (!raw) {
    throw new Error(`campaign ${id} not found — cannot transition status`);
  }
  const fromStatus = typeof raw.status === "string" ? raw.status : null;
  const existingSendAt = typeof raw.send_at === "string" ? raw.send_at : null;

  // Client-side transition-matrix validation — ALWAYS enforced.
  validateStatusTransition(args.status, fromStatus);

  const transmitting = isTransmittingStatus(args.status);

  let effectiveSendAt: string | null = existingSendAt;
  if (args.status === "scheduled") {
    if (args.sendAt !== undefined) effectiveSendAt = args.sendAt;
    if (!effectiveSendAt) {
      throw new Error(
        `scheduled requires send_at to be set (needsSendAt) — supply ` +
          "sendAt, or updateCampaign it onto the campaign first",
      );
    }
    if (!isFutureRfc3339(effectiveSendAt)) {
      throw new Error(
        `send_at must be a FUTURE RFC3339 timestamp, got "${effectiveSendAt}"`,
      );
    }
  }

  // =========================================================================
  // THE HARD SAFETY GATE.
  //   TIER 2 (transmitting: running|scheduled) requires BOTH
  //     cfg.dryRun === false AND args.confirmSend === true.
  //   TIER 1 (everything else: draft|paused|cancelled) requires only
  //     cfg.dryRun === false.
  // If the applicable gate is not open, NO mutating HTTP call is issued —
  // not the send_at PUT, not the status PUT — and a preview is written.
  // =========================================================================
  const tier2Open = cfg.dryRun === false && args.confirmSend === true;
  const tier1Open = cfg.dryRun === false;
  const gateOpen = transmitting ? tier2Open : tier1Open;

  if (!gateOpen) {
    if (transmitting) {
      context.logger.warning(
        "setCampaignStatus BLOCKED by the TIER-2 send gate: {from} -> {to} " +
          "on campaign {id} requires dryRun=false AND confirmSend=true " +
          "(got dryRun={dryRun}, confirmSend={confirmSend}). NO email will " +
          "be sent.",
        {
          from: fromStatus,
          to: args.status,
          id,
          dryRun: cfg.dryRun,
          confirmSend: args.confirmSend,
        },
      );
    } else {
      context.logger.warning(
        "setCampaignStatus DRY RUN: {from} -> {to} on campaign {id}; no writes",
        { from: fromStatus, to: args.status, id },
      );
    }
    const h = await context.writeResource("campaignStatus", "campaignStatus", {
      retrievedAt: new Date().toISOString(),
      dryRun: cfg.dryRun,
      confirmSend: args.confirmSend,
      campaignId: Number(id),
      fromStatus,
      toStatus: args.status,
      transmitting,
      action: transmitting ? "blocked-send-gate" : "would-transition",
      sendAt: effectiveSendAt,
    });
    return { dataHandles: [h] };
  }

  // --- live path: the applicable gate is open. ---
  if (
    args.status === "scheduled" &&
    args.sendAt !== undefined &&
    args.sendAt !== existingSendAt
  ) {
    context.logger.info(
      "Setting send_at={sendAt} on campaign {id} before scheduling",
      { sendAt: args.sendAt, id },
    );
    await lmFetch(
      cfg,
      "PUT",
      `api/campaigns/${id}`,
      { json: { send_at: args.sendAt } },
      doFetch,
    );
  }

  if (transmitting) {
    context.logger.warning(
      "setCampaignStatus TRANSMITTING: {from} -> {to} on campaign {id}",
      { from: fromStatus, to: args.status, id },
    );
  } else {
    context.logger.info(
      "setCampaignStatus: {from} -> {to} on campaign {id}",
      { from: fromStatus, to: args.status, id },
    );
  }
  await lmFetch(
    cfg,
    "PUT",
    `api/campaigns/${id}/status`,
    { json: { status: args.status } },
    doFetch,
  );

  const h = await context.writeResource("campaignStatus", "campaignStatus", {
    retrievedAt: new Date().toISOString(),
    dryRun: cfg.dryRun,
    confirmSend: args.confirmSend,
    campaignId: Number(id),
    fromStatus,
    toStatus: args.status,
    transmitting,
    action: "transitioned",
    sendAt: effectiveSendAt,
  });
  return { dataHandles: [h] };
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const listCampaignsArgs = z.object({});

const getCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]).describe(
    "The campaign id (positive integer).",
  ),
});

const getRunningCampaignStatsArgs = z.object({});

const createCampaignArgs = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  lists: z.array(z.number().int().positive()).min(1).describe(
    "Target list ids. Request field name is `lists` (the model calls it " +
      "ListIDs); lists are silently filtered to the token's permitted lists.",
  ),
  contentType: ContentTypeSchema.default("richtext").describe(
    "richtext | html | markdown | plain | visual.",
  ),
  fromEmail: z.string().optional(),
  body: z.string().optional(),
  altbody: z.string().optional(),
  templateId: z.number().int().positive().optional(),
  tags: z.array(z.string()).default([]),
  messenger: z.string().default("email"),
  sendAt: z.string().optional().describe(
    "Optional FUTURE RFC3339 send_at to pre-set. Does NOT schedule the " +
      "send — a created campaign ALWAYS lands in draft; use " +
      "scheduleCampaign/setCampaignStatus to transition it.",
  ),
  media: z.array(z.number().int().positive()).default([]),
  headers: z.array(z.record(z.string(), z.string())).default([]).describe(
    'ARRAY of single-key objects, e.g. [{"X-Custom":"v"}].',
  ),
});

const updateCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  subject: z.string().optional(),
  lists: z.array(z.number().int().positive()).optional(),
  contentType: ContentTypeSchema.optional(),
  fromEmail: z.string().optional(),
  body: z.string().optional(),
  altbody: z.string().optional(),
  templateId: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  messenger: z.string().optional(),
  sendAt: z.string().optional().describe(
    "FUTURE RFC3339 timestamp, if supplied.",
  ),
  media: z.array(z.number().int().positive()).optional(),
  headers: z.array(z.record(z.string(), z.string())).optional(),
});

const setCampaignStatusArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
  status: z.enum(["draft", "running", "paused", "scheduled", "cancelled"])
    .describe(
      "'finished' is excluded — not settable via the API. running/scheduled " +
        "are TIER-2 (require confirmSend); draft/paused/cancelled are TIER-1.",
    ),
  sendAt: z.string().optional().describe(
    "Only used when status='scheduled'. If the campaign has no existing " +
      "send_at (or you want to change it), supply a FUTURE RFC3339 " +
      "timestamp here — it is PUT to the campaign BEFORE the status " +
      "transition, as part of the same gated operation.",
  ),
  confirmSend: z.boolean().default(false).describe(
    "Required true (together with global dryRun=false) when status is " +
      "'running' or 'scheduled' — those TRANSMIT EMAIL. Ignored for " +
      "non-transmitting targets.",
  ),
});

const sendCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
  confirmSend: z.boolean().default(false).describe(
    "TIER-2 HARD GATE: must be true, together with global dryRun=false, " +
      "or NO email is sent.",
  ),
});

const scheduleCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
  sendAt: z.string().min(1).describe(
    "FUTURE RFC3339 timestamp to schedule the send for.",
  ),
  confirmSend: z.boolean().default(false).describe(
    "TIER-2 HARD GATE: must be true, together with global dryRun=false, " +
      "or NO email is sent (and send_at is not even PUT to the campaign).",
  ),
});

const pauseCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
});

const cancelCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
});

const testCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
  emails: z.array(z.string().min(3)).min(1).describe(
    "EXISTING subscriber emails the token can access. Unknown emails are " +
      "dropped server-side; if ALL are dropped the request 400s.",
  ),
  confirmSend: z.boolean().default(false).describe(
    "TIER-2 HARD GATE: must be true, together with global dryRun=false, " +
      "or NO test email is sent.",
  ),
});

const previewCampaignArgs = z.object({
  campaignId: z.union([z.number(), z.string()]),
});

const listTemplatesArgs = z.object({});

const getTemplateArgs = z.object({
  templateId: z.union([z.number(), z.string()]),
});

const upsertTemplateArgs = z.object({
  templateId: z.union([z.number(), z.string()]).optional().describe(
    "Omit to create a new template; provide to update an existing one.",
  ),
  name: z.string().min(1),
  type: z.string().min(1).default("campaign").describe(
    'Template type (e.g. campaign|campaign_visual|tx). A "campaign" type ' +
      'body MUST contain the literal `{{ template "content" . }}` marker ' +
      "or listmonk 400s — validated client-side below.",
  ),
  subject: z.string().optional(),
  body: z.string().min(1),
});

const deleteTemplateArgs = z.object({
  templateId: z.union([z.number(), z.string()]),
});

const setDefaultTemplateArgs = z.object({
  templateId: z.union([z.number(), z.string()]),
});

export const campaignsMethods: MethodMap = {
  listCampaigns: {
    description:
      "GET /api/campaigns (paginated via lmFetchAll) — every campaign as a " +
      "summary. Writes the `campaigns` resource.",
    arguments: listCampaignsArgs,
    execute: async (
      args: z.infer<typeof listCampaignsArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      context.logger.info("Listing all campaigns (GET /api/campaigns)");
      const rows = await lmFetchAll(
        cfg,
        "api/campaigns",
        [],
        args._fetch,
        context.logger,
      );
      const campaigns = rows.map(summarizeCampaign);
      const handle = await context.writeResource("campaigns", "campaigns", {
        retrievedAt: new Date().toISOString(),
        count: campaigns.length,
        campaigns,
      });
      return { dataHandles: [handle] };
    },
  },

  getCampaign: {
    description: "GET /api/campaigns/:id. Writes a `campaign` resource.",
    arguments: getCampaignArgs,
    execute: async (
      args: z.infer<typeof getCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.campaignId, "campaignId");
      context.logger.info("Getting campaign {id}", { id });
      const json = await lmFetch(
        cfg,
        "GET",
        `api/campaigns/${id}`,
        {},
        args._fetch,
      );
      const raw = (json.data ?? null) as Record<string, unknown> | null;
      const handle = await context.writeResource("campaign", "campaign", {
        retrievedAt: new Date().toISOString(),
        found: raw !== null,
        campaign: raw ? summarizeCampaign(raw) : null,
      });
      return { dataHandles: [handle] };
    },
  },

  getRunningCampaignStats: {
    description:
      "GET /api/campaigns/running/stats — live to_send/sent counters for " +
      "in-flight campaigns. Writes the `campaignStats` resource.",
    arguments: getRunningCampaignStatsArgs,
    execute: async (
      args: z.infer<typeof getRunningCampaignStatsArgs> & {
        _fetch?: FetchLike;
      },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      context.logger.info("Getting running campaign stats");
      const json = await lmFetch(
        cfg,
        "GET",
        "api/campaigns/running/stats",
        {},
        args._fetch,
      );
      const rows = extractRows(json);
      const stats = rows.map(summarizeCampaignStat);
      const handle = await context.writeResource(
        "campaignStats",
        "campaignStats",
        {
          retrievedAt: new Date().toISOString(),
          stats,
        },
      );
      return { dataHandles: [handle] };
    },
  },

  createCampaign: {
    description:
      "POST /api/campaigns — ALWAYS lands in draft (there is NO create-and-" +
      "send). content_type and the headers shape are validated client-side " +
      "before any request. TIER-1 gated by dryRun (default true): a dry " +
      "run resolves the request body and writes a preview with NO mutating " +
      "HTTP call.",
    arguments: createCampaignArgs,
    execute: async (
      args: z.infer<typeof createCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      validateCampaignHeaders(args.headers);
      if (args.sendAt !== undefined && !isFutureRfc3339(args.sendAt)) {
        throw new Error(
          `sendAt must be a FUTURE RFC3339 timestamp, got "${args.sendAt}"`,
        );
      }
      const requestBody = buildCampaignBody(args);

      if (cfg.dryRun) {
        context.logger.warning(
          'createCampaign DRY RUN: "{name}"; no writes',
          { name: args.name },
        );
        const h = await context.writeResource(
          "campaignWrite",
          "campaignWrite",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            campaignId: null,
            action: "would-create",
            requestBody,
          },
        );
        return { dataHandles: [h] };
      }

      context.logger.info('Creating campaign "{name}" (lands in draft)', {
        name: args.name,
      });
      const created = await lmFetch(cfg, "POST", "api/campaigns", {
        json: requestBody,
      }, args._fetch);
      const raw = (created.data ?? {}) as Record<string, unknown>;
      const h = await context.writeResource("campaignWrite", "campaignWrite", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        campaignId: typeof raw.id === "number" ? raw.id : null,
        action: "created",
        requestBody,
        campaign: summarizeCampaign(raw),
      });
      return { dataHandles: [h] };
    },
  },

  updateCampaign: {
    description:
      "PUT /api/campaigns/:id — merge semantics; only sends fields the " +
      "caller supplied. Refuses client-side (clear error) when the " +
      "campaign's current status is not draft|paused|scheduled — the API " +
      "would 400 cantUpdate otherwise. TIER-1 gated by dryRun (default " +
      "true): a dry run resolves the plan and writes a preview with NO " +
      "mutating HTTP call.",
    arguments: updateCampaignArgs,
    execute: async (
      args: z.infer<typeof updateCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.campaignId, "campaignId");
      if (args.headers !== undefined) validateCampaignHeaders(args.headers);
      if (args.sendAt !== undefined && !isFutureRfc3339(args.sendAt)) {
        throw new Error(
          `sendAt must be a FUTURE RFC3339 timestamp, got "${args.sendAt}"`,
        );
      }

      const json = await lmFetch(
        cfg,
        "GET",
        `api/campaigns/${id}`,
        {},
        args._fetch,
      );
      const raw = (json.data ?? null) as Record<string, unknown> | null;
      if (!raw) throw new Error(`campaign ${id} not found — cannot update`);
      const currentStatus = typeof raw.status === "string" ? raw.status : "";
      if (!(UPDATABLE_STATUSES as readonly string[]).includes(currentStatus)) {
        throw new Error(
          `campaign ${id} has status "${currentStatus}" — PUT /api/` +
            "campaigns/:id only allows updates when draft|paused|scheduled " +
            "(cantUpdate otherwise)",
        );
      }

      const requestBody = buildCampaignBody(args);

      if (cfg.dryRun) {
        context.logger.warning(
          "updateCampaign DRY RUN: campaign {id}; no writes",
          { id },
        );
        const h = await context.writeResource(
          "campaignWrite",
          "campaignWrite",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            campaignId: Number(id),
            action: "would-update",
            requestBody,
          },
        );
        return { dataHandles: [h] };
      }

      context.logger.info("Updating campaign {id}", { id });
      await lmFetch(
        cfg,
        "PUT",
        `api/campaigns/${id}`,
        { json: requestBody },
        args._fetch,
      );
      const h = await context.writeResource("campaignWrite", "campaignWrite", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        campaignId: Number(id),
        action: "updated",
        requestBody,
      });
      return { dataHandles: [h] };
    },
  },

  setCampaignStatus: {
    description:
      "PUT /api/campaigns/:id/status — THE primitive send/transition " +
      "endpoint (perm campaigns:SEND, distinct from campaigns:manage). " +
      "Validates the pinned transition matrix client-side and refuses an " +
      "illegal transition with a clear error. running/scheduled are " +
      "TIER-2 (TRANSMIT EMAIL — require dryRun=false AND confirmSend=true); " +
      "draft/paused/cancelled are TIER-1 (dryRun=false only). For " +
      "'scheduled', requires an existing or supplied FUTURE send_at.",
    arguments: setCampaignStatusArgs,
    execute: (
      args: z.infer<typeof setCampaignStatusArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> =>
      runSetCampaignStatus(context, {
        campaignId: args.campaignId,
        status: args.status,
        sendAt: args.sendAt,
        confirmSend: args.confirmSend,
        _fetch: args._fetch,
      }),
  },

  sendCampaign: {
    description:
      "Convenience = setCampaignStatus to 'running'. TRANSMITS EMAIL — " +
      "TIER-2 HARD GATED: requires BOTH global dryRun=false AND " +
      "confirmSend=true, or NO status-transition call is made.",
    arguments: sendCampaignArgs,
    execute: (
      args: z.infer<typeof sendCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> =>
      runSetCampaignStatus(context, {
        campaignId: args.campaignId,
        status: "running",
        confirmSend: args.confirmSend,
        _fetch: args._fetch,
      }),
  },

  scheduleCampaign: {
    description:
      "Convenience = setCampaignStatus to 'scheduled' with the given " +
      "sendAt (must be a FUTURE RFC3339 timestamp). TRANSMITS EMAIL (at " +
      "the scheduled time) — TIER-2 HARD GATED: requires BOTH global " +
      "dryRun=false AND confirmSend=true, or NO status-transition call is " +
      "made (and send_at is not even PUT to the campaign).",
    arguments: scheduleCampaignArgs,
    execute: (
      args: z.infer<typeof scheduleCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> =>
      runSetCampaignStatus(context, {
        campaignId: args.campaignId,
        status: "scheduled",
        sendAt: args.sendAt,
        confirmSend: args.confirmSend,
        _fetch: args._fetch,
      }),
  },

  pauseCampaign: {
    description:
      "Convenience = setCampaignStatus to 'paused' (only legal from " +
      "'running'). TIER-1 gated by dryRun (default true): does NOT " +
      "transmit email, so confirmSend is not required.",
    arguments: pauseCampaignArgs,
    execute: (
      args: z.infer<typeof pauseCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> =>
      runSetCampaignStatus(context, {
        campaignId: args.campaignId,
        status: "paused",
        confirmSend: false,
        _fetch: args._fetch,
      }),
  },

  cancelCampaign: {
    description:
      "Convenience = setCampaignStatus to 'cancelled' (only legal from " +
      "'running' or 'paused'). TIER-1 gated by dryRun (default true): " +
      "does NOT transmit email, so confirmSend is not required.",
    arguments: cancelCampaignArgs,
    execute: (
      args: z.infer<typeof cancelCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> =>
      runSetCampaignStatus(context, {
        campaignId: args.campaignId,
        status: "cancelled",
        confirmSend: false,
        _fetch: args._fetch,
      }),
  },

  testCampaign: {
    description:
      "POST /api/campaigns/:id/test — sends a TEST email to EXISTING " +
      "subscriber addresses the token can access. TRANSMITS EMAIL — " +
      "TIER-2 HARD GATED: requires BOTH global dryRun=false AND " +
      "confirmSend=true, or NO test POST is made.",
    arguments: testCampaignArgs,
    execute: async (
      args: z.infer<typeof testCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.campaignId, "campaignId");
      const requestBody = { subscribers: args.emails };

      // THE HARD SAFETY GATE for testCampaign: BOTH conditions, or nothing
      // is transmitted.
      const gateOpen = cfg.dryRun === false && args.confirmSend === true;
      if (!gateOpen) {
        context.logger.warning(
          "testCampaign BLOCKED by the TIER-2 send gate: campaign {id} to " +
            "{n} email(s) requires dryRun=false AND confirmSend=true (got " +
            "dryRun={dryRun}, confirmSend={confirmSend}). NO test email " +
            "will be sent.",
          {
            id,
            n: args.emails.length,
            dryRun: cfg.dryRun,
            confirmSend: args.confirmSend,
          },
        );
        const h = await context.writeResource(
          "campaignWrite",
          "campaignWrite",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: cfg.dryRun,
            campaignId: Number(id),
            action: "blocked-send-gate",
            requestBody,
          },
        );
        return { dataHandles: [h] };
      }

      context.logger.warning(
        "testCampaign TRANSMITTING: campaign {id} to {n} email(s)",
        { id, n: args.emails.length },
      );
      await lmFetch(cfg, "POST", `api/campaigns/${id}/test`, {
        json: requestBody,
      }, args._fetch);
      const h = await context.writeResource("campaignWrite", "campaignWrite", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        campaignId: Number(id),
        action: "tested",
        requestBody,
      });
      return { dataHandles: [h] };
    },
  },

  previewCampaign: {
    description:
      "GET /api/campaigns/:id/preview — returns RAW html/text (NOT the " +
      "{data:...} envelope); read via lmFetch opts.raw. Content is " +
      `truncated past ${PREVIEW_MAX_CHARS} chars. Writes the ` +
      "`campaignPreview` resource.",
    arguments: previewCampaignArgs,
    execute: async (
      args: z.infer<typeof previewCampaignArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.campaignId, "campaignId");
      context.logger.info("Rendering preview for campaign {id}", { id });
      const resp = await lmFetch(cfg, "GET", `api/campaigns/${id}/preview`, {
        raw: true,
      }, args._fetch);
      const text = typeof resp.raw === "string" ? resp.raw : "";
      const { content, truncated, contentLength } = truncatePreviewContent(
        text,
      );
      const h = await context.writeResource(
        "campaignPreview",
        "campaignPreview",
        {
          retrievedAt: new Date().toISOString(),
          campaignId: Number(id),
          contentLength,
          truncated,
          content,
        },
      );
      return { dataHandles: [h] };
    },
  },

  listTemplates: {
    description:
      "GET /api/templates — all templates. Writes the `templates` resource.",
    arguments: listTemplatesArgs,
    execute: async (
      args: z.infer<typeof listTemplatesArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      context.logger.info("Listing all templates (GET /api/templates)");
      const json = await lmFetch(cfg, "GET", "api/templates", {}, args._fetch);
      const rows = extractRows(json);
      const templates = rows.map(summarizeTemplate);
      const h = await context.writeResource("templates", "templates", {
        retrievedAt: new Date().toISOString(),
        count: templates.length,
        templates,
      });
      return { dataHandles: [h] };
    },
  },

  getTemplate: {
    description:
      "GET /api/templates/:id. Writes a `template` resource (includes body).",
    arguments: getTemplateArgs,
    execute: async (
      args: z.infer<typeof getTemplateArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.templateId, "templateId");
      context.logger.info("Getting template {id}", { id });
      const json = await lmFetch(
        cfg,
        "GET",
        `api/templates/${id}`,
        {},
        args._fetch,
      );
      const raw = (json.data ?? null) as Record<string, unknown> | null;
      const h = await context.writeResource("template", "template", {
        retrievedAt: new Date().toISOString(),
        found: raw !== null,
        template: raw ? summarizeTemplate(raw) : null,
        body: raw && typeof raw.body === "string" ? raw.body : null,
      });
      return { dataHandles: [h] };
    },
  },

  upsertTemplate: {
    description:
      "POST /api/templates (no templateId) or PUT /api/templates/:id " +
      '(templateId given). A "campaign" type template body MUST contain ' +
      'the literal `{{ template "content" . }}` marker — validated ' +
      "client-side BEFORE any request, with a clear error on failure. " +
      "TIER-1 gated by dryRun (default true): a dry run writes a preview " +
      "with NO mutating HTTP call.",
    arguments: upsertTemplateArgs,
    execute: async (
      args: z.infer<typeof upsertTemplateArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      validateCampaignTemplateBody(args.type, args.body);
      const requestBody: Record<string, unknown> = {
        name: args.name,
        type: args.type,
        body: args.body,
      };
      if (args.subject !== undefined) requestBody.subject = args.subject;

      const willUpdate = args.templateId !== undefined;
      const existingId = willUpdate
        ? assertId(args.templateId!, "templateId")
        : null;

      if (cfg.dryRun) {
        context.logger.warning(
          'upsertTemplate DRY RUN: {action} "{name}"; no writes',
          {
            action: willUpdate ? "would-update" : "would-create",
            name: args.name,
          },
        );
        const h = await context.writeResource(
          "templateWrite",
          "templateWrite",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            templateId: existingId !== null ? Number(existingId) : null,
            action: willUpdate ? "would-update" : "would-create",
            requestBody,
          },
        );
        return { dataHandles: [h] };
      }

      if (willUpdate && existingId !== null) {
        context.logger.info('Updating template {id} "{name}"', {
          id: existingId,
          name: args.name,
        });
        await lmFetch(cfg, "PUT", `api/templates/${existingId}`, {
          json: requestBody,
        }, args._fetch);
        const h = await context.writeResource(
          "templateWrite",
          "templateWrite",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: false,
            templateId: Number(existingId),
            action: "updated",
            requestBody,
          },
        );
        return { dataHandles: [h] };
      }

      context.logger.info('Creating template "{name}"', { name: args.name });
      const created = await lmFetch(cfg, "POST", "api/templates", {
        json: requestBody,
      }, args._fetch);
      const row = (created.data ?? {}) as Record<string, unknown>;
      const h = await context.writeResource("templateWrite", "templateWrite", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        templateId: typeof row.id === "number" ? row.id : null,
        action: "created",
        requestBody,
      });
      return { dataHandles: [h] };
    },
  },

  deleteTemplate: {
    description:
      "DELETE /api/templates/:id. Verifies the template exists (GET) " +
      "before deleting — rule 5. TIER-1 gated by dryRun (default true): a " +
      "dry run writes a preview with NO mutating HTTP call.",
    arguments: deleteTemplateArgs,
    execute: async (
      args: z.infer<typeof deleteTemplateArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.templateId, "templateId");
      const json = await lmFetch(
        cfg,
        "GET",
        `api/templates/${id}`,
        {},
        args._fetch,
      );
      const existed = (json.data ?? null) !== null;

      if (cfg.dryRun) {
        context.logger.warning(
          "deleteTemplate DRY RUN: template {id}; no writes",
          { id },
        );
        const h = await context.writeResource(
          "templateWrite",
          "templateWrite",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            templateId: Number(id),
            action: "would-delete",
            requestBody: {},
          },
        );
        return { dataHandles: [h] };
      }

      if (existed) {
        context.logger.info("Deleting template {id}", { id });
        await lmFetch(cfg, "DELETE", `api/templates/${id}`, {}, args._fetch);
      } else {
        context.logger.warning("Template {id} not found — nothing to delete", {
          id,
        });
      }
      const h = await context.writeResource("templateWrite", "templateWrite", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        templateId: Number(id),
        action: existed ? "deleted" : "not-found",
        requestBody: {},
      });
      return { dataHandles: [h] };
    },
  },

  setDefaultTemplate: {
    description:
      "PUT /api/templates/:id/default. The listmonk response is the FULL " +
      "templates LIST, not the template itself — this method records the " +
      "action only (call listTemplates separately to refresh the list). " +
      "TIER-1 gated by dryRun (default true): a dry run writes a preview " +
      "with NO mutating HTTP call.",
    arguments: setDefaultTemplateArgs,
    execute: async (
      args: z.infer<typeof setDefaultTemplateArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const id = assertId(args.templateId, "templateId");

      if (cfg.dryRun) {
        context.logger.warning(
          "setDefaultTemplate DRY RUN: template {id}; no writes",
          { id },
        );
        const h = await context.writeResource(
          "templateWrite",
          "templateWrite",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            templateId: Number(id),
            action: "would-set-default",
            requestBody: {},
          },
        );
        return { dataHandles: [h] };
      }

      context.logger.info("Setting template {id} as default", { id });
      await lmFetch(cfg, "PUT", `api/templates/${id}/default`, {}, args._fetch);
      const h = await context.writeResource("templateWrite", "templateWrite", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        templateId: Number(id),
        action: "set-default",
        requestBody: {},
      });
      return { dataHandles: [h] };
    },
  },
};
