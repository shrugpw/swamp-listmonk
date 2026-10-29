/**
 * @shrug/listmonk — Phase 0: read-only health + aggregate sync.
 *
 * `health` is the cheapest token-valid probe (GET /api/profile, which is NOT
 * permission-gated, so it answers 200 for any valid token regardless of role).
 * `sync` aggregates a safe, secret-free snapshot of the deployment: profile,
 * lists, masked settings, and subscriber/campaign counts. Each section is
 * independently fault-tolerant — a scoped token that lacks settings:get still
 * produces a useful sync, recording which sections it could not read rather
 * than failing the whole call.
 */
import { z } from "npm:zod@4";
import {
  type ExecuteContext,
  type ExecuteResult,
  type FetchLike,
  lmFetch,
  lmFetchAll,
  type MethodMap,
  type ResourceMap,
} from "./http.ts";

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const HealthSchema = z.object({
  ok: z.boolean(),
  retrievedAt: z.string(),
  profileUserId: z.number().nullable(),
  profileUsername: z.string().nullable(),
});

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

const SnapshotSchema = z.object({
  retrievedAt: z.string(),
  baseUrl: z.string(),
  sections: z.object({
    profile: z.boolean(),
    lists: z.boolean(),
    settings: z.boolean(),
    subscribers: z.boolean(),
    campaigns: z.boolean(),
  }),
  errors: z.record(z.string(), z.string()),
  lists: z.array(ListSummarySchema),
  settings: z.record(z.string(), z.unknown()).nullable(),
  subscriberCount: z.number().nullable(),
  campaignCount: z.number().nullable(),
  profileUsername: z.string().nullable(),
});

export const coreResources: ResourceMap = {
  health: {
    description: "Token-valid probe result (GET /api/profile).",
    schema: HealthSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
  snapshot: {
    description:
      "Aggregate deployment snapshot: profile, lists, masked settings, " +
      "subscriber/campaign counts. Secret-free (settings already masked by GET).",
    schema: SnapshotSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

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

/** Read the `total` out of a listmonk list envelope (per_page=1 count probe). */
export function envelopeTotal(json: Record<string, unknown>): number | null {
  const data = json.data;
  if (Array.isArray(data)) return data.length;
  const env = (data ?? {}) as Record<string, unknown>;
  return typeof env.total === "number" ? env.total : null;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const coreMethods: MethodMap = {
  health: {
    description:
      "GET /api/profile — the cheapest token-valid probe (not permission-" +
      "gated). 200 => the token is valid; 403 => invalid/garbage token.",
    arguments: z.object({}),
    execute: async (
      args: { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      context.logger.info("Probing GET /api/profile");
      const json = await lmFetch(cfg, "GET", "api/profile", {}, args._fetch);
      const user = (json.data ?? {}) as Record<string, unknown>;
      const handle = await context.writeResource("health", "health", {
        ok: true,
        retrievedAt: new Date().toISOString(),
        profileUserId: typeof user.id === "number" ? user.id : null,
        profileUsername: typeof user.username === "string"
          ? user.username
          : null,
      });
      return { dataHandles: [handle] };
    },
  },

  sync: {
    description:
      "Aggregate a secret-free deployment snapshot (profile, lists, masked " +
      "settings, subscriber/campaign counts). Each section is fault-tolerant: " +
      "a scoped token lacking a permission records the error for that section " +
      "and continues.",
    arguments: z.object({}),
    execute: async (
      args: { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const doFetch = args._fetch;
      const errors: Record<string, string> = {};
      const sections = {
        profile: false,
        lists: false,
        settings: false,
        subscribers: false,
        campaigns: false,
      };

      let profileUser: Record<string, unknown> | null = null;
      try {
        const j = await lmFetch(cfg, "GET", "api/profile", {}, doFetch);
        profileUser = (j.data ?? {}) as Record<string, unknown>;
        sections.profile = true;
      } catch (e) {
        errors.profile = (e as Error).message;
      }

      let lists: Array<ReturnType<typeof summarizeList>> = [];
      try {
        const rows = await lmFetchAll(
          cfg,
          "api/lists",
          [["minimal", "true"]],
          doFetch,
          context.logger,
        );
        lists = rows.map(summarizeList);
        sections.lists = true;
      } catch (e) {
        errors.lists = (e as Error).message;
      }

      let settings: Record<string, unknown> | null = null;
      try {
        const j = await lmFetch(cfg, "GET", "api/settings", {}, doFetch);
        settings = (j.data ?? {}) as Record<string, unknown>;
        sections.settings = true;
      } catch (e) {
        errors.settings = (e as Error).message;
      }

      let subscriberCount: number | null = null;
      try {
        const j = await lmFetch(
          cfg,
          "GET",
          "api/subscribers",
          { query: [["page", "1"], ["per_page", "1"]] },
          doFetch,
        );
        subscriberCount = envelopeTotal(j);
        sections.subscribers = true;
      } catch (e) {
        errors.subscribers = (e as Error).message;
      }

      let campaignCount: number | null = null;
      try {
        const j = await lmFetch(
          cfg,
          "GET",
          "api/campaigns",
          { query: [["page", "1"], ["per_page", "1"]] },
          doFetch,
        );
        campaignCount = envelopeTotal(j);
        sections.campaigns = true;
      } catch (e) {
        errors.campaigns = (e as Error).message;
      }

      context.logger.info(
        "sync: {lists} lists, {subs} subscribers, {camps} campaigns",
        {
          lists: lists.length,
          subs: subscriberCount,
          camps: campaignCount,
        },
      );

      const handle = await context.writeResource("snapshot", "snapshot", {
        retrievedAt: new Date().toISOString(),
        baseUrl: cfg.baseUrl,
        sections,
        errors,
        lists,
        settings,
        subscriberCount,
        campaignCount,
        profileUsername: profileUser && typeof profileUser.username === "string"
          ? profileUser.username
          : null,
      });
      return { dataHandles: [handle] };
    },
  },
};
