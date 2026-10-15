# Kinnect

Family task tracker: a Cloudflare Worker (Durable Objects) backend and a Svelte 5 web app, built
with Vite. Product spec and architecture: `docs/requirements.md`. Deploy guide: `docs/deploy.md`.

## Layout

- `src/worker/`: Worker API (`org/` per-family Durable Object, `directory/`, `auth/`, `push/`, `db/`)
- `src/web/`: Svelte app (`screens/`, `components/`, `public/`)
- `src/shared/`: code used by both the Worker and the web app
- `test/shared/`, `test/worker/`: Vitest tests; worker tests use helpers in `test/worker/helpers.ts`
- `scripts/`: `operator.ts` (operator CLI), `gen-vapid.mjs` (push keys)

## Commands

After a change, run what CI runs:

- `npm run format:check` (fix with `npm run format`; tabs, width 100)
- `npm run check` (Wrangler types, `tsc`, `svelte-check`)
- `npm test` ("Missing required secrets" warnings from Wrangler are expected)

## Rules

- Never put deployment-specific details in code, docs, comments, tests or commit messages: no
  real `APP_URL`, workers.dev subdomain, Cloudflare account name or ID, domains or secrets. Use
  placeholders such as `https://kinnect.<your-subdomain>.workers.dev`, and `https://kinnect.test`
  in tests. Per-deployment values belong in `.dev.vars` or `wrangler secret put`.
- Don't read or edit `.dev.vars` (local secrets and the real `APP_URL`).
- Don't edit generated output: `dist/`, `.wrangler/`, `worker-configuration.d.ts` (`npm run types`).
- Keep the product promises from the README: no passwords, no email addresses or phone numbers
  collected, and everything must fit Cloudflare's free plan.
