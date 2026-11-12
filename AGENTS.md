# AGENTS.md — OpenVibe.Watch

## Project overview

OpenVibe.Watch (`https://openvibe.watch`) is the network's place for a **person or an agent** to define
persistent observations and conditions over pages, feeds, APIs, webhooks and OpenVibe events, and an
action when they change or fire — cheaply, because a Watch prefers an event or the site's own ETag
over polling. The API is loopback-only; the public site is server-rendered.

- **Entry:** `server/index.js`; app `server/app.js`; port `4730`, service id `watch`.
- **API:** `server/api/` — `watches.js`, `checks.js`, `provider-rates.js`, `resource-index.js`,
  `resource-control.js`, `actor-limits.js` (all `/api/v1`); `server/http/` — `pages.js`,
  `discovery.js`, `site-limits.js`, `network-reads.js`.
- **Carriers (binding order):** `server/carriers/` — `event.js` (OpenVibe.Events), `feed.js`, `api.js`,
  `node.js` (Link probes from the owner's machine), `http.js`, `webhook.js`; the preference logic is in
  `index.js`.
- **Checks:** scheduler, conditional fetch and backoff in `server/check*`/`server/net/fetcher.js`;
  the outbound guard is `server/net/guard.js`; checks and observations live in `check_runs`/
  `observations` with `watch_endpoint_state`.
- **Events and actions:** `server/events/` (`envelope.js`, `agent-step.js`), actions in the check path
  (notification, event, webhook, Actor task/agent run, Run job, Codes task).
- **Pages:** `server/render/` (`watch.js`, `layout.js`, `html.js`, `changelog.js`, `short.js`); no own
  browser script layer, CSS in `public/css`; every page complete without JavaScript.

## Owns, does not own

Owns the watch registry (`watches`, `watch_endpoint_state`) and the `watch.watch@1` /
`watch.watch-request@1` / `watch.watch-result@1` shapes; checks (`check_runs`, `observations`, the
scheduler, conditional-fetch state, backoff); the public site's sign-in sessions (`web_sessions`) and
pages; `watch.*` events; provider-rate evidence (`WATCH_PROVIDER_RATES`, off) — the DeepInfra and
Featherless official price documents as immutable observations, the pending change and a person's dated
approval.

Does not own: structured source ingestion for publication (Sources — Watch observes what one person or
agent asked for, not what a product publishes); expensive browser/code execution (Run, step 6) and
local/LAN probes (Link, step 7) — Watch asks them, they run; interpreting a trigger and acting (Actor,
Codes); delivery of a notification (Network consumes `watch.watch.triggered`); the supply rate card
(AI's catalog — an approved rate change is evidence AI's operator applies).

## Who calls it, what it calls

Every `/api/v1` route needs a Network token for audience `openvibe.watch` with that route's **one**
capability: a service token is judged by its `cap` claim, a person/agent token by identity
(`usr_…`/`agt_…`), and a first-party `svc:…` may send `X-OV-Subject` to act for a person (an app or
module may not). Watch calls Events (sources and
outbox), Live/Community/anything through the generic pull carriers, Link for node probes, Run for
browser/code checks (not yet), Actor/Codes/Run for actions, Network (JWKS, sessions, notifications),
and a webhook target only through the guarded POST. The vhost keeps `/api/v1/*` and `/internal/*`
loopback-only.

## Database and migrations

PostgreSQL `ov_watch` through `openvibe-sdk/db`: `DATABASE_URL` through PgBouncer, owner role for
migrations; `migrations/` are applied at boot and only add. Tests use PGlite (slow to boot — 180 s per
file) or `WATCH_TEST_STORE=pg`; never edit a migration that has run, and rollback must work. A check
writes a `check_runs` row and observations; a conditional fetch stores its validators only after a
good answer.

## Auth, ownership and exposure

Tokens are Network RS256 JWTs verified offline against JWKS. Reads and writes are scoped to the acting
subject; another owner's watch answers 404, not 403. `X-OV-Subject` is honoured only from a first-party
service. `/auth/*`, the pages and discovery files are public; the API and `/internal/*` are
loopback-only; `/metrics` answers direct loopback callers only. `/internal/events` is signed and
loopback-only.

## Deploy

`sudo ovhost deploy watch`: checkout `/opt/openvibe.watch`, unit
`deploy/systemd/openvibe-watch.service` as `openvibe-watch.service` on `127.0.0.1:4730`, env
`/etc/openvibe/watch.env` (0600), database `ov_watch`, nginx
`deploy/nginx/openvibe.watch.conf`. Rollback with `sudo ovhost rollback watch --to <sha>`; readiness
reports `degraded` for an unloaded Network key or a check worker behind by 15 minutes.

## Commands and tests

```bash
npm install
npm run dev                  # http://127.0.0.1:4730
npm test                     # every test/*.test.js against local stub sites
npm test -- carriers check   # only matching files
npm run test:pg              # the same through PgBouncer (CI path)
```

`test/run.js` uses `openvibe-shared/test-runner` (180 s, serial): temp PGlite, generated RSA keys and
stub subscribers/sites, never the network. Tests cover the carriers and their preference, event and
webhook sources, conditional fetch/ETag, extraction, conditions and observations, actions, budgets,
account export/deletion, provider rates, the pages and discovery.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; problem+json errors; escaped server HTML.
- **Carrier preference is binding:** an event or ETag wins over polling; a Watch must not poll when the
  source can push or answer 304. A new carrier is added to `server/carriers/index.js` and the README
  table, not bolted onto the http path.
- **Watch asks, others run:** no browser/code execution or LAN probing in this repo — call Run/Link
  with the person's authority. Expensive work needs a budget.
- **Every check records its observation state and backoff**; a failure is recorded, not retried in a
  tight loop, and never invents a change.
- **Actions are explicit and owner-scoped:** a notification, event, webhook, Actor/Codes/Run task are
  the person's; never let a watch trigger another person's process.
- **The public site is complete without JavaScript**: create/edit/pause/resume/delete/check-now are
  forms; the query picks a template, not a script.
- **Provider rates are evidence, not an applied price:** while `WATCH_PROVIDER_RATES` is off, store
  the official document, show the pending change and require the dated approval; AI's operator applies
  it.
