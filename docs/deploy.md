# Deploying and running Kinnect

Kinnect runs on Cloudflare's free plan: one Worker serves the app and the API, and each family is one Durable Object with its own SQLite database. No credit card is needed (NFR-1).

## First deploy to a new Cloudflare account

You need Node.js 22.18 or newer and a free Cloudflare account.

```sh
npm install
npx wrangler login                     # opens the browser to sign in to Cloudflare
npm run vapid                          # push keys: public key → wrangler.jsonc, private key → .dev.vars
npm run operator -- init-secret        # adds OPERATOR_SECRET to .dev.vars
```

1. Choose the app's address:
   - change `"name"` in `wrangler.jsonc` if you want a different `*.workers.dev` address;
   - add it to `.dev.vars` as `APP_URL`, e.g. `APP_URL=https://kinnect.<your-subdomain>.workers.dev`. Your subdomain is shown in the Cloudflare dashboard under **Workers & Pages**. Push services use it to contact the sender, and operator links point at it. Deploys fail until it is set.
2. Run the checks and the first deploy. The first deploy uploads both secrets from `.dev.vars`:

   ```sh
   npm run check && npm test
   npm run build && npx wrangler deploy --secrets-file .dev.vars
   ```

3. Check it's up: `curl https://<your-app>/api/directory/health` should return `{"ok":true,...}`.
4. Create the first family:

   ```sh
   npm run operator -- create-org
   ```

   Open the printed link on the phone of the person who will own the family. It works once and expires after 7 days.

**Keep `.dev.vars` safe and out of git** (it is in `.gitignore`).
- `VAPID_PRIVATE_KEY`: if it is lost or replaced, every phone has to turn notifications on again.
- `OPERATOR_SECRET`: signs create-family and owner-recovery links.
- `APP_URL`: not secret, just your deployment's address. To change it later: `npx wrangler secret put APP_URL`.

## Updating

```sh
npm run check && npm test
npm run deploy                         # vite build + wrangler deploy
```

**Schema changes**
- **Forward-only:** migrations are numbered entries in `orgMigrations` (`src/worker/org/schema.ts`) and `directoryMigrations`. Each family's database applies new ones the next time it starts. Never edit a migration that has been deployed; add a new one to the end.
- **Export:** a new column must also go into `EXPORT_PLAN` (`src/worker/org/export.ts`), either exported or excluded. `test/worker/export.test.ts` fails until it does.

**Rolling back**
- `npx wrangler rollback` returns to the previous Worker version.
- It does **not** undo a schema migration. Older code refuses to open a database newer than itself (the family's requests fail with an error) rather than corrupt it.
- So for a release with a migration, fix forward instead of rolling back.

## Backups and recovery

- **Family data export (FR-92).** An admin can download everything at any time: Settings → Family data → **Download family data**. It contains tasks, history, members and households, but no sign-in tokens, invite codes or push addresses. Suggest each family's admin keeps a copy once a month. This is the off-platform copy (NFR-8).
- **Point-in-time recovery.** Durable Object SQLite storage can be restored to any moment in the last 30 days. Kinnect has no button for this yet. A restore needs a short one-off change to `OrgDO`:
  - call `ctx.storage.getBookmarkForTime(time)`;
  - then call `ctx.storage.onNextSessionRestoreBookmark(bookmark)` and `ctx.abort()`.

  See Cloudflare's Durable Objects storage API docs. Everything after the chosen time is lost for that family, so download an export first.
- **Owner lost every device.** Print a recovery link and send it to the owner. It signs one new device in as the owner, works once, and lasts 48 hours:

  ```sh
  npm run operator -- recover <orgId>
  ```

  Any other member who lost their phone just needs a new "add device" link from an admin.

## Free-plan limits that matter

Check Cloudflare's current [Workers](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/) limits.
- **Daily request limit:** a handful of families (NFR-7) stays far below it.
- **Subrequests per run:** each scheduler run sends at most 40 pushes. That keeps it under the free plan's subrequest limit (Phase 0 measured about 0.5–0.8 ms of CPU per push). Larger bursts continue in the next run straight away.

## Monitoring

- `npx wrangler tail` streams live logs (errors, failed pushes).
- Workers observability is enabled in `wrangler.jsonc`. Logs are searchable in the Cloudflare dashboard under Workers → kinnect → Logs.

## Adding a family member's phone

1. In Settings, an admin creates the member and sends their invite link, for example by WhatsApp.
2. The member opens it **in Chrome** (Android) or **Safari** (iPhone), not inside WhatsApp. The app tells them if they're in an in-app browser.
3. They tap **Join**. Kinnect opens **Set up this phone** and walks them through:
   - installing the app;
   - turning on notifications;
   - on Android, setting **Chrome's** battery use to Unrestricted;
   - sending a test notification.
4. Later, the dot on their initials (header) and the "This phone" row in Settings show whether the phone still needs anything.
5. Admins and watchers can see in the member's page whether any of their devices can receive reminders.
