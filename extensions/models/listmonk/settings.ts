/**
 * @shrug/listmonk — Phase 1: settings (GET/PUT /api/settings + SMTP helpers).
 *
 * listmonk's settings object is a FLAT bag of DOTTED top-level keys
 * (`app.site_name`, `bounce.enabled`, ...) with three exceptions that are
 * arrays of nested objects: `smtp[]`, `messengers[]`, `bounce.mailboxes[]`.
 * `GET /api/settings` masks every stored secret with bullet characters;
 * `PUT /api/settings` REPLACES THE WHOLE OBJECT, so every write here is
 * GET -> merge the caller's overlay on top -> PUT the full merged object.
 *
 * The one sharp edge is SMTP password preservation: a block the caller is
 * NOT changing must be PUT back with `password: ""` (listmonk's `omitempty`
 * drops it, and the server then keeps the previously stored secret) AND its
 * original `uuid`. PUTting the masked bullet string back would overwrite the
 * real secret with literal bullets. `mergeSmtpBlocks` below is the one place
 * that rule lives; every write method routes through it.
 */
import { z } from "npm:zod@4";
import {
  type ExecuteContext,
  type ExecuteResult,
  type FetchLike,
  type GlobalArgs,
  lmFetch,
  type MethodLogger,
  type MethodMap,
  type ResourceMap,
} from "./http.ts";

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const SettingsSchema = z.object({
  retrievedAt: z.string(),
  // The live GET /api/settings object, as-is. Already secret-free: listmonk
  // masks every stored secret (smtp[].password, bounce.mailboxes[].password,
  // ...) with bullet characters before returning it.
  settings: z.record(z.string(), z.unknown()),
}).passthrough();

const SettingsApplySchema = z.object({
  retrievedAt: z.string(),
  action: z.enum(["applySettings", "setSmtpServers", "reloadApp"]),
  dryRun: z.boolean(),
  applied: z.boolean(),
  // Top-level dotted keys the overlay touched (excludes `smtp`, tracked
  // separately below). Empty for reloadApp (no overlay).
  overlayKeys: z.array(z.string()),
  smtpCount: z.number().nullable(),
  hasEnabledSmtp: z.boolean().nullable(),
  // Echoes PUT /api/settings's `data.needs_restart` (set when campaigns are
  // running and a full reload was deferred). Null for a dry run or reloadApp.
  needsRestart: z.boolean().nullable(),
  // The full merged object the live path WOULD PUT (or DID PUT), with every
  // secret-shaped field redacted — NEVER the overlay's cleartext password.
  // Null on a live (non-dry-run) write, since the object has already shipped.
  preview: z.record(z.string(), z.unknown()).nullable(),
}).passthrough();

const SmtpTestSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  ran: z.boolean(),
  host: z.string().nullable(),
  port: z.number().nullable(),
  success: z.boolean().nullable(),
  message: z.string().nullable(),
}).passthrough();

const DriftRowSchema = z.object({
  // The drifted key: a listmonk dotted settings key (e.g. "app.root_url") or a
  // synthetic smtp block key "smtp[<uuid-or-host|user>]".
  key: z.string(),
  status: z.enum(["in-sync", "would-change"]),
  // Live value for the DECLARED keys only (secrets redacted). null when the key
  // (or smtp block) does not exist live yet.
  from: z.unknown(),
  // Declared desired value (secrets redacted).
  to: z.unknown(),
  // True for an smtp block carrying a non-empty cleartext password: that secret
  // is INVISIBLE in a GET (listmonk masks it), so it is never diffed — but it
  // WILL be written through if this block is PUT for any (non-secret) reason.
  // Rotate an SMTP secret with setSmtpServers, which always writes it through.
  secretWriteThrough: z.boolean().optional(),
}).passthrough();

const SettingsReconcileSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  // Whether a live PUT actually happened (false on a dry run, and on a live run
  // that found nothing to change).
  applied: z.boolean(),
  wouldChangeCount: z.number(),
  drift: z.object({
    rows: z.array(DriftRowSchema),
    wouldChangeCount: z.number(),
  }),
  needsRestart: z.boolean().nullable(),
  // Secret-redacted full merged object that WOULD be PUT (dry run) — null once a
  // live write has shipped.
  preview: z.record(z.string(), z.unknown()).nullable(),
}).passthrough();

export const settingsResources: ResourceMap = {
  settings: {
    description:
      "The live GET /api/settings object (secret-free: listmonk masks every " +
      "stored secret before returning it).",
    schema: SettingsSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  settingsApply: {
    description:
      "Audit of an applySettings / setSmtpServers / reloadApp run: what the " +
      "overlay touched, whether it was a dry run, and (dry run only) a " +
      "secret-redacted preview of the object that would be PUT.",
    schema: SettingsApplySchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  smtpTest: {
    description:
      "Result of a POST /api/settings/smtp/test probe (never carries the " +
      "cleartext password that was sent).",
    schema: SmtpTestSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
  settingsReconcile: {
    description:
      "Audit of a reconcileSettings run: the structured per-key drift of the " +
      "DECLARED desired settings against the live object (status in-sync / " +
      "would-change, secrets redacted), whether a live PUT happened, and (dry " +
      "run only) a secret-redacted preview of the merged object that would be " +
      "PUT. SMTP passwords are invisible in a GET so are never diffed (see the " +
      "secretWriteThrough flag on a drift row).",
    schema: SettingsReconcileSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Merge a desired `smtp[]` overlay onto the live `smtp[]` array, enforcing
 * the password-preservation rule:
 *  - `overlay === undefined` (caller isn't touching smtp at all): every live
 *    block passes through with `password` cleared (never re-send the masked
 *    bullet string), uuid kept — a no-op from listmonk's point of view.
 *  - An overlay block matched to a live block by `uuid` with NO (or empty)
 *    `password` is an in-place edit that is not rotating the secret: fields
 *    merge over the live block, `password` is forced to `""`, `uuid` is kept.
 *  - An overlay block (matched or not) WITH a non-empty `password` IS
 *    changing the secret: it is sent through with that cleartext password.
 *  - A brand-new overlay block (no `uuid` match) with no password is passed
 *    through with `password: ""` — listmonk will 400 on this itself; it is
 *    not this module's job to silently invent a secret.
 *  - Any live block the overlay never references (by uuid) is preserved
 *    untouched (password cleared) rather than dropped, since the overlay is
 *    a PARTIAL set of changes, not a full replacement list.
 *
 * Assumes every live block carries a `uuid` (true for anything that has ever
 * round-tripped through listmonk); a live block without one can't be matched
 * and is always treated as "not referenced" (preserved, never deduped).
 */
export function mergeSmtpBlocks(
  live: Array<Record<string, unknown>>,
  overlay?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (overlay === undefined) {
    return live.map((b) => ({ ...b, password: "" }));
  }

  const liveByUuid = new Map<string, Record<string, unknown>>();
  for (const b of live) {
    if (typeof b.uuid === "string") liveByUuid.set(b.uuid, b);
  }

  const touchedUuids = new Set<string>();
  const result: Array<Record<string, unknown>> = [];

  for (const ob of overlay) {
    const uuid = typeof ob.uuid === "string" ? ob.uuid : undefined;
    const overlayPassword = typeof ob.password === "string" ? ob.password : "";
    if (uuid) touchedUuids.add(uuid);
    const liveMatch = uuid ? liveByUuid.get(uuid) : undefined;

    if (overlayPassword !== "") {
      // Secret is actually rotating: send the real cleartext password.
      result.push({ ...(liveMatch ?? {}), ...ob, password: overlayPassword });
    } else if (liveMatch) {
      // Known block, no new secret: merge fields, preserve the stored one.
      result.push({ ...liveMatch, ...ob, password: "", uuid: liveMatch.uuid });
    } else {
      // New block, no secret supplied — let listmonk reject it server-side.
      result.push({ ...ob, password: "" });
    }
  }

  for (const b of live) {
    const uuid = typeof b.uuid === "string" ? b.uuid : undefined;
    if (uuid && touchedUuids.has(uuid)) continue;
    result.push({ ...b, password: "" });
  }

  return result;
}

/** True when at least one smtp block is `enabled: true` (listmonk requires this). */
export function hasEnabledSmtpBlock(
  smtp: Array<Record<string, unknown>>,
): boolean {
  return smtp.some((b) => b.enabled === true);
}

// Any key whose name suggests a secret. listmonk settings carry several
// non-"password" secrets (SMTP/messenger password, OIDC client_secret, S3
// aws_secret_access_key, captcha secret, API keys), so redaction must be
// broader than /password/. Over-redacting a DRY-RUN PREVIEW is the safe
// direction — the preview is informational, never PUT back — so this errs wide.
const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;

// A listmonk-masked secret: a string of only bullet chars (U+2022) / whitespace.
const BULLET_MASK_RE = /^[•·*\s]+$/;

/**
 * Recursively redact any secret-looking key holding a non-empty string. Used to
 * build a dry-run preview of the object we WOULD PUT without ever persisting a
 * cleartext secret into a data resource. Errs toward over-redaction (see
 * {@link SECRET_KEY_RE}).
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && typeof v === "string" && v !== "") {
        out[k] = "•••redacted•••";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Recursively replace any listmonk bullet-MASK string (what GET /api/settings
 * returns for a stored secret) with "" so a subsequent PUT does NOT write the
 * literal mask back over the real secret — listmonk's omitempty then preserves
 * the stored value. This generalizes the SMTP password-preserve rule to EVERY
 * secret-bearing array/object (messengers[], bounce.mailboxes[], oidc, ...),
 * so a GET-merge-PUT that doesn't touch those blocks can never corrupt them.
 */
export function stripBulletMasks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBulletMasks);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripBulletMasks(v);
    }
    return out;
  }
  if (typeof value === "string" && value !== "" && BULLET_MASK_RE.test(value)) {
    return "";
  }
  return value;
}

// ---------------------------------------------------------------------------
// Declarative drift (reconcileSettings)
// ---------------------------------------------------------------------------

export interface DriftRow {
  key: string;
  status: "in-sync" | "would-change";
  from: unknown;
  to: unknown;
  secretWriteThrough?: boolean;
}

export interface SettingsDrift {
  rows: DriftRow[];
  wouldChangeCount: number;
}

/** Recursively sort object keys so two structurally-equal values stringify identically. */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Deep structural equality (order-insensitive for object keys). */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** Strip the one secret field from an smtp block before diffing. */
function stripSmtpSecret(
  b: Record<string, unknown>,
): Record<string, unknown> {
  const { password: _password, ...rest } = b;
  return rest;
}

/**
 * Compute the per-key drift of a DECLARED desired-settings record against the
 * live GET /api/settings object. DECLARED-SUBSET semantics: only keys present
 * in `desired` are examined (a key/smtp-block that exists live but is not
 * declared is left to be preserved by the PUT merge, NOT reported as drift) —
 * so reconcile is convergent-on-declared, never a full replace.
 *
 *  - Flat dotted keys (`app.root_url`, ...): the whole value is compared; a
 *    difference is `would-change`, with live `from` / desired `to` (redacted).
 *  - `smtp[]`: each declared block is matched to a live block by `uuid`, else by
 *    `host|username`. Only the NON-SECRET sub-keys the block declares are
 *    compared (the live block carries many more fields we aren't asserting, and
 *    its `password` is masked). A declared block with no live match is
 *    `would-change` (new). `password` is never diffed; a non-empty one sets
 *    `secretWriteThrough` (it WILL be written through if the block is PUT, but a
 *    secret alone never flips status — rotate via setSmtpServers).
 */
export function computeSettingsDrift(
  live: Record<string, unknown>,
  desired: Record<string, unknown>,
): SettingsDrift {
  const rows: DriftRow[] = [];
  const { smtp: desiredSmtpRaw, ...flat } = desired;

  // Redact a flat key's VALUE when the KEY name looks secret (listmonk has
  // secret-valued dotted keys like `upload.s3.aws_secret_access_key`).
  // redactSecrets keys off the name inside an object, so wrap-and-unwrap it.
  const redactByKey = (key: string, value: unknown): unknown =>
    (redactSecrets({ [key]: value }) as Record<string, unknown>)[key];

  for (const [key, want] of Object.entries(flat)) {
    const have = live[key];
    rows.push({
      key,
      status: deepEqual(have, want) ? "in-sync" : "would-change",
      from: have === undefined ? null : redactByKey(key, have),
      to: redactByKey(key, want),
    });
  }

  if (Array.isArray(desiredSmtpRaw)) {
    const desiredSmtp = desiredSmtpRaw as Array<Record<string, unknown>>;
    const liveSmtp = Array.isArray(live.smtp)
      ? live.smtp as Array<Record<string, unknown>>
      : [];
    const liveByUuid = new Map<string, Record<string, unknown>>();
    const liveByHostUser = new Map<string, Record<string, unknown>>();
    for (const b of liveSmtp) {
      if (typeof b.uuid === "string") liveByUuid.set(b.uuid, b);
      liveByHostUser.set(`${b.host ?? ""}|${b.username ?? ""}`, b);
    }

    desiredSmtp.forEach((db) => {
      const uuid = typeof db.uuid === "string" ? db.uuid : undefined;
      const hostUser = `${db.host ?? ""}|${db.username ?? ""}`;
      const match = (uuid ? liveByUuid.get(uuid) : undefined) ??
        liveByHostUser.get(hostUser);
      const hasSecret = typeof db.password === "string" && db.password !== "";
      const key = `smtp[${uuid ?? hostUser}]`;
      const declaredKeys = Object.keys(db).filter((k) => k !== "password");

      if (!match) {
        rows.push({
          key,
          status: "would-change",
          from: null,
          to: redactSecrets(stripSmtpSecret(db)),
          secretWriteThrough: hasSecret,
        });
        return;
      }

      const diffs = declaredKeys.filter((k) => !deepEqual(match[k], db[k]));
      const fromSubset: Record<string, unknown> = {};
      for (const k of declaredKeys) fromSubset[k] = match[k];
      rows.push({
        key,
        status: diffs.length === 0 ? "in-sync" : "would-change",
        from: redactSecrets(fromSubset),
        to: redactSecrets(stripSmtpSecret(db)),
        secretWriteThrough: hasSecret,
      });
    });
  }

  return {
    rows,
    wouldChangeCount: rows.filter((r) => r.status === "would-change").length,
  };
}

/**
 * Overlay a desired-settings record onto the live GET /api/settings object.
 * All top-level keys EXCEPT `smtp` are listmonk's flat dotted keys, so they
 * shallow-overwrite verbatim; `smtp` routes through {@link mergeSmtpBlocks}.
 */
export function buildMergedSettings(
  live: Record<string, unknown>,
  overlay: Record<string, unknown>,
): {
  merged: Record<string, unknown>;
  overlayKeys: string[];
  smtp: Array<Record<string, unknown>>;
} {
  const { smtp: overlaySmtpRaw, ...rest } = overlay;
  const liveSmtp = Array.isArray(live.smtp)
    ? live.smtp as Array<Record<string, unknown>>
    : [];
  const overlaySmtp = Array.isArray(overlaySmtpRaw)
    ? overlaySmtpRaw as Array<Record<string, unknown>>
    : undefined;
  const smtp = mergeSmtpBlocks(liveSmtp, overlaySmtp);
  const merged: Record<string, unknown> = { ...live, ...rest, smtp };
  return { merged, overlayKeys: Object.keys(rest), smtp };
}

// ---------------------------------------------------------------------------
// Internal (non-pure) shared write path — used by applySettings + setSmtpServers.
// ---------------------------------------------------------------------------

interface ApplyResult {
  dryRun: boolean;
  applied: boolean;
  overlayKeys: string[];
  smtpCount: number;
  hasEnabledSmtp: boolean;
  needsRestart: boolean | null;
  preview: Record<string, unknown> | null;
}

/** GET -> merge overlay -> (dryRun: preview) | (live: PUT). Shared by the write methods. */
async function getMergeApply(
  action: "applySettings" | "setSmtpServers" | "reconcileSettings",
  overlay: Record<string, unknown>,
  cfg: GlobalArgs,
  doFetch: FetchLike | undefined,
  logger: MethodLogger,
): Promise<ApplyResult> {
  const getJson = await lmFetch(cfg, "GET", "api/settings", {}, doFetch);
  const live = (getJson.data ?? {}) as Record<string, unknown>;
  const { merged, overlayKeys, smtp } = buildMergedSettings(live, overlay);
  const hasEnabledSmtp = hasEnabledSmtpBlock(smtp);

  if (cfg.dryRun) {
    logger.warning(
      "{action} DRY RUN: would PUT /api/settings ({keys} top-level keys, " +
        "{n} smtp blocks); no write",
      { action, keys: overlayKeys.length, n: smtp.length },
    );
    return {
      dryRun: true,
      applied: false,
      overlayKeys,
      smtpCount: smtp.length,
      hasEnabledSmtp,
      needsRestart: null,
      preview: redactSecrets(merged) as Record<string, unknown>,
    };
  }

  if (!hasEnabledSmtp) {
    throw new Error(
      `${action}: merged smtp[] has no enabled=true block — PUT /api/settings ` +
        "would 400; refusing to send it",
    );
  }

  // Never PUT a bullet-mask back over a stored secret (contract: a mask stored
  // literally breaks that credential). The SMTP path already cleared its own
  // masks; this catches every OTHER secret-bearing block (messengers[],
  // bounce.mailboxes[], oidc, ...) the overlay didn't touch.
  const safe = stripBulletMasks(merged) as Record<string, unknown>;
  const putJson = await lmFetch(
    cfg,
    "PUT",
    "api/settings",
    { json: safe },
    doFetch,
  );
  const putData = (putJson.data ?? {}) as Record<string, unknown>;
  const needsRestart = typeof putData.needs_restart === "boolean"
    ? putData.needs_restart
    : null;

  return {
    dryRun: false,
    applied: true,
    overlayKeys,
    smtpCount: smtp.length,
    hasEnabledSmtp,
    needsRestart,
    preview: null,
  };
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const applySettingsArgs = z.object({
  overlay: z.record(z.string(), z.unknown()).default({}).describe(
    "Partial desired-settings overlay. Top-level keys are listmonk's DOTTED " +
      "setting keys (e.g. 'app.site_name', 'app.from_email') set verbatim. An " +
      "optional `smtp` array holds blocks to add or change — match an " +
      "existing block by its `uuid` to edit it (include a new cleartext " +
      "`password` only when actually rotating it; omit/empty it to keep the " +
      "stored secret). Live smtp blocks the overlay doesn't mention are left " +
      "untouched (their stored password is preserved, never re-sent).",
  ),
  _fetch: z.any().optional(),
});

const setSmtpServersArgs = z.object({
  smtp: z.array(z.record(z.string(), z.unknown())).min(1).describe(
    "SMTP blocks to add or change, matched by `uuid` (see applySettings for " +
      "the match/preserve rule). Convenience wrapper that only ever touches " +
      "smtp[]; every other settings key is left exactly as-is. Still a full " +
      "GET-merge-PUT under the hood (listmonk's PUT replaces the whole " +
      "object, and requires >=1 enabled block).",
  ),
  _fetch: z.any().optional(),
});

const reconcileSettingsArgs = z.object({
  desired: z.record(z.string(), z.unknown()).describe(
    "The DECLARED desired settings (the YAML source-of-truth): listmonk DOTTED " +
      "keys (e.g. 'app.root_url', 'app.from_email') set verbatim, plus an " +
      "optional `smtp` array of blocks (matched to live by `uuid` else " +
      "`host|username`). reconcileSettings DIFFS these declared keys against " +
      "the live object (convergent-on-declared: live keys/blocks you don't " +
      "declare are preserved, not reported) and, on a live run, PUTs the merge " +
      "only when something would change. SMTP passwords are masked in a GET so " +
      "are never diffed — rotate a secret with setSmtpServers.",
  ),
  _fetch: z.any().optional(),
});

const smtpTestArgs = z.object({
  smtp: z.record(z.string(), z.unknown()).describe(
    "A single SMTP block with a CLEARTEXT password — e.g. {host, port, " +
      "auth_protocol, tls_type, username, password, from_email, ...} — sent " +
      "verbatim to POST /api/settings/smtp/test, which sends a real test " +
      "email through that server.",
  ),
  _fetch: z.any().optional(),
});

export const settingsMethods: MethodMap = {
  getSettings: {
    description:
      "GET /api/settings — the live settings object. Already secret-free " +
      "(listmonk masks every stored secret before returning it). Read-only, " +
      "not gated by dryRun.",
    arguments: z.object({ _fetch: z.any().optional() }),
    execute: async (
      args: { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      context.logger.info("Fetching GET /api/settings");
      const json = await lmFetch(cfg, "GET", "api/settings", {}, args._fetch);
      const settings = (json.data ?? {}) as Record<string, unknown>;
      const handle = await context.writeResource("settings", "settings", {
        retrievedAt: new Date().toISOString(),
        settings,
      });
      return { dataHandles: [handle] };
    },
  },

  applySettings: {
    description:
      "GET /api/settings, overlay the desired dotted-key fields (plus an " +
      "optional smtp[] edit) on top, and PUT the merged whole object. Gated " +
      "by dryRun (default true): a dry run performs the GET + merge and " +
      "writes a secret-redacted preview of what WOULD be PUT, with no write. " +
      "SMTP blocks the overlay doesn't touch keep their stored password " +
      "(password:'' + original uuid) so the live secret is never clobbered.",
    arguments: applySettingsArgs,
    execute: async (
      args: z.infer<typeof applySettingsArgs>,
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const result = await getMergeApply(
        "applySettings",
        args.overlay,
        cfg,
        args._fetch,
        context.logger,
      );
      const handle = await context.writeResource(
        "settingsApply",
        "settingsApply",
        {
          retrievedAt: new Date().toISOString(),
          action: "applySettings",
          ...result,
        },
      );
      return { dataHandles: [handle] };
    },
  },

  setSmtpServers: {
    description:
      "Convenience wrapper around applySettings that replaces only smtp[] " +
      "(still a full GET-merge-PUT, since listmonk's PUT replaces the whole " +
      "settings object and requires >=1 enabled block). Same dryRun gate + " +
      "password-preservation/redaction discipline as applySettings.",
    arguments: setSmtpServersArgs,
    execute: async (
      args: z.infer<typeof setSmtpServersArgs>,
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const result = await getMergeApply(
        "setSmtpServers",
        { smtp: args.smtp },
        cfg,
        args._fetch,
        context.logger,
      );
      const handle = await context.writeResource(
        "settingsApply",
        "settingsApply",
        {
          retrievedAt: new Date().toISOString(),
          action: "setSmtpServers",
          ...result,
        },
      );
      return { dataHandles: [handle] };
    },
  },

  testSmtp: {
    description:
      "POST /api/settings/smtp/test — sends a real test email through the " +
      "given SMTP block (cleartext password, not persisted). Gated by " +
      "dryRun (default true): a dry run reports what WOULD be tested and " +
      "sends nothing. A live run never throws on a failed test — the " +
      "failure is recorded in the smtpTest resource (success:false + " +
      "message) so the method completes either way.",
    arguments: smtpTestArgs,
    execute: async (
      args: z.infer<typeof smtpTestArgs>,
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const host = typeof args.smtp.host === "string" ? args.smtp.host : null;
      const port = typeof args.smtp.port === "number" ? args.smtp.port : null;

      if (cfg.dryRun) {
        context.logger.warning(
          "testSmtp DRY RUN: would POST api/settings/smtp/test to {host}:{port}; " +
            "no email sent",
          { host, port },
        );
        const handle = await context.writeResource("smtpTest", "smtpTest", {
          retrievedAt: new Date().toISOString(),
          dryRun: true,
          ran: false,
          host,
          port,
          success: null,
          message: "dryRun: no test email sent",
        });
        return { dataHandles: [handle] };
      }

      let success = true;
      let message: string | null = null;
      try {
        await lmFetch(
          cfg,
          "POST",
          "api/settings/smtp/test",
          { json: args.smtp },
          args._fetch,
        );
      } catch (e) {
        success = false;
        message = (e as Error).message;
        context.logger.error("testSmtp failed: {message}", { message });
      }

      const handle = await context.writeResource("smtpTest", "smtpTest", {
        retrievedAt: new Date().toISOString(),
        dryRun: false,
        ran: true,
        host,
        port,
        success,
        message,
      });
      return { dataHandles: [handle] };
    },
  },

  reloadApp: {
    description:
      "POST /api/admin/reload — force the running app to reload its config " +
      "(this also happens automatically ~500ms after a settings PUT, unless " +
      "campaigns are running). Gated by dryRun (default true).",
    arguments: z.object({ _fetch: z.any().optional() }),
    execute: async (
      args: { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const base = {
        retrievedAt: new Date().toISOString(),
        action: "reloadApp" as const,
        overlayKeys: [] as string[],
        smtpCount: null,
        hasEnabledSmtp: null,
        needsRestart: null,
        preview: null,
      };

      if (cfg.dryRun) {
        context.logger.warning(
          "reloadApp DRY RUN: would POST api/admin/reload; no write",
        );
        const handle = await context.writeResource(
          "settingsApply",
          "settingsApply",
          {
            ...base,
            dryRun: true,
            applied: false,
          },
        );
        return { dataHandles: [handle] };
      }

      await lmFetch(cfg, "POST", "api/admin/reload", {}, args._fetch);
      const handle = await context.writeResource(
        "settingsApply",
        "settingsApply",
        {
          ...base,
          dryRun: false,
          applied: true,
        },
      );
      return { dataHandles: [handle] };
    },
  },

  reconcileSettings: {
    description:
      "Declarative settings reconcile: GET /api/settings, DIFF the DECLARED " +
      "desired keys against it (structured per-key drift: in-sync / " +
      "would-change, secrets redacted), and — on a live run (dryRun=false) with " +
      "at least one would-change — PUT the merged object via the same " +
      "password-preserving write path as applySettings. Convergent-on-declared: " +
      "live keys/smtp blocks you don't declare are preserved, never reported or " +
      "removed. Gated by dryRun (default true): a dry run writes the drift + a " +
      "secret-redacted preview and performs NO write. A live run with zero " +
      "would-change rows is a no-op (applied:false). SMTP passwords are masked " +
      "in a GET so are never diffed (see a drift row's secretWriteThrough); " +
      "rotate an SMTP secret with setSmtpServers.",
    arguments: reconcileSettingsArgs,
    execute: async (
      args: z.infer<typeof reconcileSettingsArgs>,
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const getJson = await lmFetch(
        cfg,
        "GET",
        "api/settings",
        {},
        args._fetch,
      );
      const live = (getJson.data ?? {}) as Record<string, unknown>;
      const drift = computeSettingsDrift(live, args.desired);

      // Dry run, OR a live run with nothing to change: write the audit, no PUT.
      if (cfg.dryRun || drift.wouldChangeCount === 0) {
        if (cfg.dryRun) {
          context.logger.warning(
            "reconcileSettings DRY RUN: {n} would-change of {t} declared keys; " +
              "no write",
            { n: drift.wouldChangeCount, t: drift.rows.length },
          );
        } else {
          context.logger.info(
            "reconcileSettings: 0 would-change — settings already converged, " +
              "no write",
          );
        }
        const { merged } = buildMergedSettings(live, args.desired);
        const handle = await context.writeResource(
          "settingsReconcile",
          "settingsReconcile",
          {
            retrievedAt: new Date().toISOString(),
            dryRun: cfg.dryRun,
            applied: false,
            wouldChangeCount: drift.wouldChangeCount,
            drift,
            needsRestart: null,
            preview: cfg.dryRun
              ? redactSecrets(merged) as Record<string, unknown>
              : null,
          },
        );
        return { dataHandles: [handle] };
      }

      // Live run with drift: route the write through the shared, password-
      // preserving GET-merge-PUT path (one place owns that discipline).
      const result = await getMergeApply(
        "reconcileSettings",
        args.desired,
        cfg,
        args._fetch,
        context.logger,
      );
      const handle = await context.writeResource(
        "settingsReconcile",
        "settingsReconcile",
        {
          retrievedAt: new Date().toISOString(),
          dryRun: false,
          applied: result.applied,
          wouldChangeCount: drift.wouldChangeCount,
          drift,
          needsRestart: result.needsRestart,
          preview: null,
        },
      );
      return { dataHandles: [handle] };
    },
  },
};
