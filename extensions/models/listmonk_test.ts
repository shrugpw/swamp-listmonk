/**
 * Assembly test for @shrug/listmonk — guards that every domain module is wired
 * into the behavior's method + resource maps (a module failing to export, or an
 * accidental name collision on spread, would surface here rather than at runtime).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import model from "./listmonk.ts";

Deno.test("model identity + CalVer version", () => {
  assertEquals(model.type, "@shrug/listmonk");
  assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), model.version);
  assert(model.globalArguments, "globalArguments schema present");
});

Deno.test("every phase's methods are wired", () => {
  const expected = [
    // Phase 0 / 0.5
    "health",
    "sync",
    "provisionApiUser",
    "rotateApiToken",
    // Phase 1
    "getSettings",
    "applySettings",
    "setSmtpServers",
    "testSmtp",
    "reloadApp",
    // Phase 2
    "listLists",
    "findListByName",
    "getList",
    "upsertList",
    "deleteList",
    // Phase 3
    "querySubscribers",
    "getSubscriber",
    "importSubscribers",
    "upsertSubscriber",
    "manageSubscriberLists",
    "deleteSubscriber",
    "getImportStatus",
    "stopImport",
    // Phase 4
    "listCampaigns",
    "getCampaign",
    "createCampaign",
    "updateCampaign",
    "setCampaignStatus",
    "sendCampaign",
    "scheduleCampaign",
    "testCampaign",
    "previewCampaign",
  ];
  for (const m of expected) {
    assert(m in model.methods, `method ${m} is wired`);
    assert(
      typeof model.methods[m].execute === "function",
      `method ${m} has an execute`,
    );
  }
});

Deno.test("key resources are wired (incl. sensitive apiCredential)", () => {
  for (
    const r of ["health", "snapshot", "apiCredential", "lists", "settings"]
  ) {
    assert(r in model.resources, `resource ${r} is wired`);
  }
});

Deno.test("no method or resource name was dropped by a spread collision", () => {
  // Each module's method count is additive; a collision would reduce the total.
  assert(
    Object.keys(model.methods).length >= 31,
    `expected >=31 methods, got ${Object.keys(model.methods).length}`,
  );
});
