# @shrug/listmonk

A typed [swamp](https://github.com/swamp-club/swamp) behavior for driving a
[listmonk](https://listmonk.app) **v6.2.0** deployment over its REST API — a
real primitive, not exec/curl wrappers. One behavior type (`@shrug/listmonk`),
one deployment per instance.

Status: **in development** (Phases 0–4 built and smoke-tested against a local
v6.2.0; publishing is gated on depersonalized tests + a public repo).

## Auth model

Routine methods authenticate as a **scoped operational API user**
(`apiUser` + vaulted `apiToken`). The Super Admin credential is only ever
supplied at provision time, as method arguments — never stored in the instance.

The wire contract (verified on v6.2.0):

- Header: `Authorization: token <apiUser>:<apiToken>` (literal word `token`,
  **not** bearer).
- Never send a `Cookie` header — a stray session cookie silently shadows the
  Authorization header and the request `403`s even with a valid token.
- Unauth / insufficient permission → HTTP `403` (not `401`). `GET /api/profile`
  is the only non-permission-gated probe.

## Provisioning the scoped token

`provisionApiUser` mints a least-privilege API user and writes the minted token
into a **sensitive resource field** — swamp stores it in the vault and persists
only a reference; the plaintext never touches a data file, a log, or the
terminal. The instance then reads it back with a vault-resolving expression.

Because `${{ vault.get() }}` only evaluates in workflow step inputs (not in
`--input`), run provisioning from a workflow step so the bootstrap token comes
from the vault:

```yaml
# provision.workflow.yaml (excerpt)
steps:
  - id: provision
    model: my-listmonk
    method: provisionApiUser
    input:
      bootstrapUser: admin
      bootstrapToken: ${{ vault.get("my-listmonk", "bootstrap_token") }}
      username: swamp-ops
```

Then wire the instance's operational token to the minted credential:

```yaml
# my-listmonk instance global arguments
baseUrl: https://lists.example.com
apiUser: swamp-ops
apiToken: ${{ data.latest("my-listmonk", "apiCredential-swamp-ops").attributes.apiToken }}
dryRun: true
```

The default permission set deliberately **excludes** `campaigns:send`,
`users:manage`, `roles:manage`, and `settings:maintain` — defense in depth with
the `dryRun` gate. Pass `permissions` to widen.

## Method surface (by phase)

- **Phase 0** — `health`, `sync` (secret-free deployment snapshot).
- **Phase 0.5** — `provisionApiUser`, `rotateApiToken`.
- **Phase 1** — `getSettings`, `applySettings` (GET-merge-PUT with SMTP password
  preservation), `setSmtpServers`, `testSmtp`, `reloadApp`.
- **Phase 2** — `listLists`, `findListByName`, `getList`, `upsertList`,
  `deleteList`.
- **Phase 3** — `querySubscribers`, `getSubscriber`, `importSubscribers`
  (async), `upsertSubscriber`, `manageSubscriberLists`, `deleteSubscriber`,
  `getImportStatus`, `stopImport`.
- **Phase 4** — `listCampaigns`, `getCampaign`, `createCampaign`,
  `updateCampaign`, `setCampaignStatus`, `previewCampaign`, template CRUD, and
  the **hard-gated** `sendCampaign` / `scheduleCampaign` / `testCampaign`.

## Write gating

Every write is gated behind the global `dryRun` (default `true`): a dry run
returns a would-do preview and makes **no** mutating call. Anything that
transmits email (`sendCampaign`, `scheduleCampaign`, `testCampaign`, or a
status transition to `running`/`scheduled`) requires **both** `dryRun=false`
**and** an explicit `confirmSend: true` — otherwise it refuses before any HTTP.

```bash
# Dry preview (default) — no list is created:
swamp behavior run my-listmonk upsertList \
  --input name="Announcements" --input type=public \
  --input optin=double --input 'tags=["announce"]'
```
