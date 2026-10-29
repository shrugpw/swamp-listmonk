/**
 * @shrug/listmonk — Phase 0.5: API-user provisioning + the minted-token
 * secret-write path.
 *
 * The chicken-and-egg: to mint a scoped operational token you must first
 * authenticate as a Super Admin. So the BOOTSTRAP superadmin credential is
 * supplied as METHOD ARGUMENTS (resolved at call time from the vault via a
 * workflow step's `${{ vault.get(...) }}` input), NEVER stored in the instance's
 * global args. The instance's persistent global apiUser/apiToken are the SCOPED
 * operational credential this method mints.
 *
 * The novel bit (design open-question #1): how does execute() write the minted
 * token to a vault without a vault-put in the method context and without the
 * secret hitting swamp data or the terminal? Resolved natively: write it to a
 * resource whose token field is marked `z.meta({ sensitive: true })`. swamp
 * stores that field's value in the instance's default vault and persists only a
 * vault REFERENCE in the data — the plaintext never lands in a data file or log.
 * The instance then reads it back via a vault-resolving CEL expression. (The
 * exact read-back wiring is verified empirically against a live v6.2.0 before
 * any production use — see design/listmonk-extension.md open-question #1.)
 *
 * listmonk auth facts (v6.2.0): user_role_id=1 is Super Admin (bypasses perms);
 * least privilege => a NON-1 role with an explicit permission set. A minted
 * token is returned exactly ONCE (POST /api/users -> data.password); it is
 * stored only as a SHA-256 and can never be read back. Rotation = DELETE +
 * recreate. There is NO GET /api/roles (404); user roles live at
 * GET|POST /api/roles/users.
 */
import { z } from "npm:zod@4";
import {
  assertId,
  type ExecuteContext,
  type ExecuteResult,
  type FetchLike,
  type LmConfig,
  lmFetch,
  type MethodMap,
  type ResourceMap,
} from "./http.ts";

// listmonk username charset (v6.2.0): ^[a-zA-Z0-9_\-\.@]+$, length 3-2000.
const USERNAME_RE = /^[a-zA-Z0-9_\-.@]+$/;

// A functional-but-scoped default permission set for the operational token.
// DELIBERATELY EXCLUDES: campaigns:send (sends must be a separate explicit
// opt-in — defense in depth with dryRun), settings:maintain, users:manage,
// roles:manage (the operational token must not be able to mint more users,
// edit roles, or run maintenance). Override `permissions` to widen.
export const DEFAULT_OPERATIONAL_PERMISSIONS = [
  "lists:get_all",
  "lists:manage_all",
  "subscribers:get_all",
  "subscribers:manage",
  "subscribers:import",
  // Needed by upsertSubscriber's 409-fallback find-by-email (GET
  // /api/subscribers?query=<SQL>); without it upsert silently degrades to
  // create-only. Verified against live v6.2.0 (the raw-SQL query route is
  // gated on subscribers:sql_query, distinct from subscribers:get_all).
  "subscribers:sql_query",
  "campaigns:get_all",
  "campaigns:manage",
  "media:get",
  "media:manage",
  "templates:get",
  "templates:manage",
  "settings:get",
  "settings:manage",
];

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const ApiCredentialSchema = z.object({
  apiUser: z.string(),
  // SENSITIVE — swamp vaults this field and persists only a reference.
  apiToken: z.string().meta({ sensitive: true }),
  roleId: z.number(),
  roleName: z.string(),
  mintedAt: z.string(),
});

const ProvisionRunSchema = z.object({
  retrievedAt: z.string(),
  dryRun: z.boolean(),
  username: z.string(),
  roleName: z.string(),
  roleId: z.number().nullable(),
  permissions: z.array(z.string()),
  roleAction: z.string(), // created|reused|reconciled|would-create|would-reuse|would-reconcile
  userAction: z.string(), // created | exists | would-create | would-reuse
  tokenMinted: z.boolean(),
});

export const authResources: ResourceMap = {
  apiCredential: {
    description:
      "The minted SCOPED operational credential (apiUser + sensitive " +
      "apiToken). ONLY the apiToken field is vault-stored (field-level " +
      "`sensitive`); data persists a vault reference for it and plaintext for " +
      "the audit fields (apiUser/roleId/roleName/mintedAt). Instance name is " +
      "keyed by username (`apiCredential-<username>`) so re-mints never clobber " +
      "another user's token. The instance reads the token back via a vault-" +
      "resolving CEL expression, e.g. apiToken=${{ data.latest('<provision-" +
      "instance>','apiCredential-swamp-ops').attributes.apiToken }} (verified " +
      "to resolve on v6.2.0). Written only " +
      "when a token is actually minted; keep lifetime infinite so the " +
      "data.latest reference never GCs out from under the instance config.",
    schema: ApiCredentialSchema,
    lifetime: "infinite",
    garbageCollection: 5,
  },
  provisionRun: {
    description:
      "Non-secret audit of a provisionApiUser run (what role/user it ensured, " +
      "whether a token was minted). Never carries the token.",
    schema: ProvisionRunSchema,
    lifetime: "infinite",
    garbageCollection: 20,
  },
};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Build a bootstrap LmConfig from superadmin method args + the instance baseUrl. */
export function bootstrapCfg(
  baseUrl: string,
  bootstrapUser: string,
  bootstrapToken: string,
  perPage?: number,
): LmConfig {
  return { baseUrl, apiUser: bootstrapUser, apiToken: bootstrapToken, perPage };
}

/** Find a user role by exact name in a GET /api/roles/users response. */
export function findRoleByName(
  json: Record<string, unknown>,
  name: string,
): { id: number; name: string; permissions: string[] } | null {
  const data = json.data;
  const rows = Array.isArray(data) ? data : [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r.name === name && typeof r.id === "number") {
      const permissions = Array.isArray(r.permissions)
        ? (r.permissions as unknown[]).map(String)
        : [];
      return { id: r.id, name, permissions };
    }
  }
  return null;
}

/**
 * True when two permission sets differ (order-insensitive). Used to decide
 * whether a REUSED role needs its permissions reconciled to the desired set —
 * without this, provisionApiUser would mint a token bound to a pre-existing
 * role that may be MORE privileged than the requested least-priv set.
 */
export function permissionsDiffer(
  current: string[],
  desired: string[],
): boolean {
  if (current.length !== desired.length) return true;
  const c = new Set(current);
  return desired.some((p) => !c.has(p));
}

/** Find a user by exact username in a GET /api/users response. */
export function findUserByName(
  json: Record<string, unknown>,
  username: string,
): { id: number; username: string } | null {
  const data = json.data;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown> | undefined)?.results)
    ? (data as Record<string, unknown>).results
    : [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r.username === username && typeof r.id === "number") {
      return { id: r.id, username };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const provisionArgs = z.object({
  bootstrapUser: z.string().min(1).describe(
    "Super Admin API username used ONLY to mint the scoped user.",
  ),
  bootstrapToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Super Admin API token (pair with bootstrapUser). Supply at call time " +
      'from the vault: ${{ vault.get("<vault>","bootstrap_token") }}.',
  ),
  username: z.string().regex(USERNAME_RE).min(3).max(2000).default("swamp-ops")
    .describe("The scoped api user to create (type=api, non-superadmin role)."),
  roleName: z.string().min(1).default("swamp-ops-role").describe(
    "The user role to ensure (created with `permissions` if absent).",
  ),
  permissions: z.array(z.string()).default(DEFAULT_OPERATIONAL_PERMISSIONS)
    .describe(
      "Least-privilege permission set for the role. Default excludes " +
        "campaigns:send / users:manage / roles:manage / settings:maintain.",
    ),
  email: z.string().optional().describe(
    "Email for the api user (listmonk may require one). Default " +
      "<username>@api.invalid.",
  ),
});

export const authMethods: MethodMap = {
  provisionApiUser: {
    description:
      "Bootstrap a least-privilege API user + token. Authenticates with the " +
      "bootstrap SUPER ADMIN credential (method args), ensures the role, " +
      "creates the scoped user, and writes the minted token to the sensitive " +
      "apiCredential resource (vault-stored). Idempotent: if the user already " +
      "exists the token is NOT re-minted (use rotateApiToken for a fresh one). " +
      "Gated by dryRun (default true): a dry run authenticates, inspects, and " +
      "reports the plan without creating anything.",
    arguments: provisionArgs,
    execute: async (
      args: z.infer<typeof provisionArgs> & { _fetch?: FetchLike },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const boot = bootstrapCfg(
        cfg.baseUrl,
        args.bootstrapUser,
        args.bootstrapToken,
        cfg.perPage,
      );
      const doFetch = args._fetch as FetchLike | undefined;
      const email = args.email ?? `${args.username}@api.invalid`;

      // 1. Validate the bootstrap token (cheap, not perm-gated).
      await lmFetch(boot, "GET", "api/profile", {}, doFetch);

      // 2. Resolve the role (create if absent).
      const rolesJson = await lmFetch(
        boot,
        "GET",
        "api/roles/users",
        {},
        doFetch,
      );
      let role = findRoleByName(rolesJson, args.roleName);
      const roleDrifts = role !== null &&
        permissionsDiffer(role.permissions, args.permissions);
      let roleAction = !role
        ? "created"
        : (roleDrifts ? "reconciled" : "reused");

      // 3. Resolve the user (existence check — token is only minted on create).
      const usersJson = await lmFetch(boot, "GET", "api/users", {}, doFetch);
      const existingUser = findUserByName(usersJson, args.username);
      let userAction = existingUser ? "exists" : "created";

      const handles: Array<{ name: string }> = [];

      if (cfg.dryRun) {
        context.logger.warning(
          "provisionApiUser DRY RUN: role={role} user={user}; no writes",
          {
            role: role ? "reuse" : "create",
            user: existingUser ? "exists" : "create",
          },
        );
        const h = await context.writeResource(
          "provisionRun",
          `provisionRun-${args.username}`,
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            username: args.username,
            roleName: args.roleName,
            roleId: role?.id ?? null,
            permissions: args.permissions,
            roleAction: !role
              ? "would-create"
              : (roleDrifts ? "would-reconcile" : "would-reuse"),
            userAction: existingUser ? "would-reuse" : "would-create",
            tokenMinted: false,
          },
        );
        return { dataHandles: [h] };
      }

      // --- live path ---
      if (!role) {
        context.logger.info("Creating role {name}", { name: args.roleName });
        const created = await lmFetch(boot, "POST", "api/roles/users", {
          json: { name: args.roleName, permissions: args.permissions },
        }, doFetch);
        const r = (created.data ?? {}) as Record<string, unknown>;
        if (typeof r.id !== "number") {
          throw new Error("role create did not return a numeric id");
        }
        role = { id: r.id, name: args.roleName, permissions: args.permissions };
        roleAction = "created";
      } else if (roleDrifts) {
        // Reuse-by-name is NOT enough: a pre-existing role may be MORE
        // privileged than the requested least-priv set. Reconcile it to the
        // desired permissions before binding a token to it.
        context.logger.warning(
          "Reconciling role {name} permissions to the requested set " +
            "(had {had}, want {want})",
          {
            name: args.roleName,
            had: role.permissions.length,
            want: args.permissions.length,
          },
        );
        await lmFetch(
          boot,
          "PUT",
          `api/roles/users/${assertId(role.id, "roleId")}`,
          { json: { name: args.roleName, permissions: args.permissions } },
          doFetch,
        );
        role = {
          id: role.id,
          name: args.roleName,
          permissions: args.permissions,
        };
        roleAction = "reconciled";
      }

      let tokenMinted = false;
      if (!existingUser) {
        context.logger.info("Creating api user {name}", {
          name: args.username,
        });
        const created = await lmFetch(boot, "POST", "api/users", {
          json: {
            username: args.username,
            type: "api",
            user_role_id: role.id,
            email,
            status: "enabled",
          },
        }, doFetch);
        const u = (created.data ?? {}) as Record<string, unknown>;
        const token = typeof u.password === "string" ? u.password : "";
        if (!token) {
          throw new Error(
            "user create did not return a token (data.password) — cannot " +
              "proceed. listmonk returns the token only once at creation, so " +
              "the just-created user has no retrievable token; recover with " +
              "rotateApiToken (DELETE + recreate) to mint a fresh one.",
          );
        }
        userAction = "created";
        tokenMinted = true;
        // The sensitive write: swamp vaults apiToken, persists only a reference.
        const credHandle = await context.writeResource(
          "apiCredential",
          `apiCredential-${args.username}`,
          {
            apiUser: args.username,
            apiToken: token,
            roleId: role.id,
            roleName: args.roleName,
            mintedAt: new Date().toISOString(),
          },
        );
        handles.push(credHandle);
      } else {
        context.logger.warning(
          "api user {name} already exists; token NOT re-minted (use " +
            "rotateApiToken for a fresh token)",
          { name: args.username },
        );
      }

      const runHandle = await context.writeResource(
        "provisionRun",
        `provisionRun-${args.username}`,
        {
          retrievedAt: new Date().toISOString(),
          dryRun: false,
          username: args.username,
          roleName: args.roleName,
          roleId: role.id,
          permissions: args.permissions,
          roleAction,
          userAction,
          tokenMinted,
        },
      );
      handles.push(runHandle);
      return { dataHandles: handles };
    },
  },

  rotateApiToken: {
    description:
      "DESTRUCTIVE + NON-ATOMIC: rotate the scoped api user's token by DELETE " +
      "+ recreate (listmonk cannot rotate in place). Requires the bootstrap " +
      "Super Admin credential. Writes a fresh apiCredential on success. Gated " +
      "by dryRun. WARNING: if the recreate POST fails after the DELETE " +
      "succeeds, the operational user is GONE with no replacement (self-" +
      "lockout); recover by re-running provisionApiUser with the bootstrap " +
      "credential. For zero-downtime rotation, prefer provisionApiUser with a " +
      "NEW username and re-point the instance's apiToken, then delete the old.",
    arguments: z.object({
      bootstrapUser: z.string().min(1),
      bootstrapToken: z.string().min(1).meta({ sensitive: true }),
      username: z.string().regex(USERNAME_RE).default("swamp-ops"),
    }),
    execute: async (
      args: {
        bootstrapUser: string;
        bootstrapToken: string;
        username: string;
        _fetch?: FetchLike;
      },
      context: ExecuteContext,
    ): Promise<ExecuteResult> => {
      const cfg = context.globalArgs;
      const boot = bootstrapCfg(
        cfg.baseUrl,
        args.bootstrapUser,
        args.bootstrapToken,
        cfg.perPage,
      );
      const doFetch = args._fetch;
      const usersJson = await lmFetch(boot, "GET", "api/users", {}, doFetch);
      const user = findUserByName(usersJson, args.username);
      if (!user) {
        throw new Error(
          `api user ${args.username} not found — nothing to rotate`,
        );
      }
      // role is needed to recreate; read it off the existing user row.
      const rows = (usersJson.data ?? []) as Array<Record<string, unknown>>;
      const row =
        (Array.isArray(rows) ? rows : []).find((r) =>
          r.username === args.username
        ) ?? {};
      const roleId = typeof row.user_role_id === "number"
        ? row.user_role_id
        : (typeof (row.role as Record<string, unknown> | undefined)?.id ===
            "number"
          ? (row.role as Record<string, unknown>).id as number
          : null);
      const email = typeof row.email === "string"
        ? row.email
        : `${args.username}@api.invalid`;

      if (cfg.dryRun) {
        context.logger.warning(
          "rotateApiToken DRY RUN: would DELETE user {id} and recreate",
          { id: user.id },
        );
        const h = await context.writeResource(
          "provisionRun",
          `provisionRun-${args.username}`,
          {
            retrievedAt: new Date().toISOString(),
            dryRun: true,
            username: args.username,
            roleName: "",
            roleId,
            permissions: [],
            roleAction: "would-reuse",
            userAction: "would-rotate",
            tokenMinted: false,
          },
        );
        return { dataHandles: [h] };
      }

      if (roleId === null) {
        throw new Error(
          `could not determine role for ${args.username}; refusing to recreate`,
        );
      }
      await lmFetch(
        boot,
        "DELETE",
        `api/users/${assertId(user.id, "userId")}`,
        {},
        doFetch,
      );
      const created = await lmFetch(boot, "POST", "api/users", {
        json: {
          username: args.username,
          type: "api",
          user_role_id: roleId,
          email,
          status: "enabled",
        },
      }, doFetch);
      const u = (created.data ?? {}) as Record<string, unknown>;
      const token = typeof u.password === "string" ? u.password : "";
      if (!token) throw new Error("recreate did not return a token");
      const cred = await context.writeResource(
        "apiCredential",
        `apiCredential-${args.username}`,
        {
          apiUser: args.username,
          apiToken: token,
          roleId,
          roleName: "",
          mintedAt: new Date().toISOString(),
        },
      );
      return { dataHandles: [cred] };
    },
  },
};
