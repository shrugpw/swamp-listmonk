/**
 * @shrug/listmonk — a typed swamp behavior for driving a listmonk v6.2.0
 * deployment over its REST API (NOT exec/curl wrappers).
 *
 * One behavior type, one deployment per instance. Routine methods authenticate
 * as a SCOPED operational api user (globalArguments.apiUser/apiToken); the
 * superadmin credential is only ever supplied at provision time (method args).
 * Every write is gated behind globalArguments.dryRun (default true); campaign
 * sends carry an additional per-call gate.
 *
 * Module split (all under ./listmonk/, relative-imported so they bundle inline
 * at push time per repo rule 7):
 *   http.ts         — shared fetch seam + cross-module contracts + config schema
 *   core.ts         — Phase 0: health, sync
 *   auth.ts         — Phase 0.5: provisionApiUser, rotateApiToken
 *   settings.ts     — Phase 1: applySettings, getSettings, setSmtpServers, ...
 *   lists.ts        — Phase 2: upsertList, deleteList, listLists, getList
 *   subscribers.ts  — Phase 3: importSubscribers, upsertSubscriber, ...
 *   campaigns.ts    — Phase 4: createCampaign, ... (sends HARD-GATED)
 */
import {
  GlobalArgsSchema,
  type MethodMap,
  type ResourceMap,
} from "./listmonk/http.ts";
import { coreMethods, coreResources } from "./listmonk/core.ts";
import { authMethods, authResources } from "./listmonk/auth.ts";
import { settingsMethods, settingsResources } from "./listmonk/settings.ts";
import { listsMethods, listsResources } from "./listmonk/lists.ts";
import {
  subscribersMethods,
  subscribersResources,
} from "./listmonk/subscribers.ts";
import { campaignsMethods, campaignsResources } from "./listmonk/campaigns.ts";

const resources: ResourceMap = {
  ...coreResources,
  ...authResources,
  ...settingsResources,
  ...listsResources,
  ...subscribersResources,
  ...campaignsResources,
};

const methods: MethodMap = {
  ...coreMethods,
  ...authMethods,
  ...settingsMethods,
  ...listsMethods,
  ...subscribersMethods,
  ...campaignsMethods,
};

/**
 * The `@shrug/listmonk` behavior definition — assembles every phase module's
 * resource specs and methods into one behavior type. See the per-module files
 * for the method implementations and the pinned v6.2.0 API contracts.
 */
export const model = {
  type: "@shrug/listmonk",
  version: "2026.10.28.1", // CalVer; bump via `swamp extension version` at publish.
  description:
    "listmonk v6.2.0 REST API behavior: read-side health/sync, a bootstrap " +
    "provisionApiUser that mints a scoped least-privilege token into the " +
    "vault, declarative applySettings, upsertList, subscriber import/upsert, " +
    "and campaign CRUD with hard-gated sends. All writes gated behind dryRun " +
    "(default true).",
  globalArguments: GlobalArgsSchema,
  resources,
  methods,
};

export default model;
