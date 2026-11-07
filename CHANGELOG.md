# Changelog

## 2026-11-09 — a routine is a watch with a cron (Actor's triggers)

- **A schedule watch**: `POST /api/v1/watches/:id/schedule` saves a five-field cron and timezone (migration
  `0021_actor_schedule`). The scheduler fires it like a cadence; `check.run` records the occurrence as a
  `condition_met` run with carrier `schedule` and queues the watch's actions without fetching anything. The floor is 15
  minutes, as it is for a cadence. The source stays a valid `watch.watch@1` kind (the subscription is created paused, a
  webhook source is refused deliveries, and the routine never polls a page), so the released watch schema is unchanged.
- **A watch that fails five checks in a row pauses itself** and says so (one `agent.step` ended step); resuming clears
  the streak and arms it again. A routine's action then reaches Actor with `watch_id` and the Actor `trigger_id` from
  the watch's `actor_trigger` label, so the run links back to its card.

What shipped on OpenVibe.Watch, newest first. The plan is T18 ("Watch complete"); each entry names
the step it landed.

## 2026-11-06 — the chat apps' checks come from the SDK (agent plan A4)

- Slack's v0 request signing, Discord's Ed25519 interaction signature and Telegram's secret token
  are checked by `openvibe-sdk/chat-apps` (`verifySlack`, `verifyDiscord`, `verifyTelegram`), the
  same code the chat bots use, instead of Watch's own copies (`server/webhook-sources.js`). The
  behaviour is unchanged: the same five-minute window, the same exact raw bytes, the same
  constant-time comparison, and a provider Watch does not know still checks nothing.
- Pins openvibe-sdk v0.92.0 (was v0.82.0).

## 2026-11-03 — email in (agent plan A3)

- A webhook watch can have an email address of its own (`in-…@openvibe.watch`): mail sent there runs its check on the
  sender, subject and text. Cloudflare Email Routing hands each message to the mail Worker (`edge/mail-worker.mjs`),
  which posts it to `POST /hooks/email`, signed; an unknown address or a paused watch bounces the mail
  (`server/webhook-sources.js`, `server/mail-parse.js`, migration `0016_webhook_email_address`).

## 2026-11-01 — the condition in words, a quiet test before arming, and the evidence in every alert

- The watch list and each watch page say the watch's structured condition in one sentence — what it reads, where,
  and what makes it fire — instead of the condition operator alone (`server/render/watch.js`, `server/http/pages.js`).
- A polling watch made on the site is saved paused and read once by a quiet test check before it arms. The watch page
  shows the value that check found (or the state it recorded and why, when it found none), nothing is notified and no
  action is queued, and the person arms it when ready. The first arm is stored in `watches.armed_at`
  (migration `0014_armed_at.sql`, `server/check.js`, `server/http/pages.js`).
- Every alert now carries its evidence: a notification's message and `rich_content`, a webhook body, an Actor task's
  context and a run-job's firing argument state the value before and after, the source address and the time the value
  was fetched. A part the watch did not store is left out (`server/actions.js`). The watch page's alert history shows
  the same evidence (`server/http/pages.js`).
- Tests: `test/site.test.js` (the quiet test, the failed test, arming, the condition in words, the arm badge),
  `test/actions.test.js` (the notification and webhook evidence, the omitted line, the page history).

## 2026-10-31 — a person's Network session token on the API

- The watch API accepts a signed-in person's Network session token (`aud: openvibe.network`) as a Bearer, the same
  token the site's SSO verifies, as well as a person/agent token minted for `openvibe.watch`. A first-party service
  such as Shoes can therefore create a watch with the person's own token instead of a service token. The watch is
  owned by the token's canonical `usr_…`/`agt_…` `subject_id` (a Network session token's `sub` is the numeric
  account id), so project delegation and the person-only actions keep working. `server/auth.js`, `test/api.test.js`.

## 2026-10-13 — check-operation usage readings (plan T5 step 14, Watch slice)

- A completed check queues one `platform.usage-sample@1` reading (metric `check-operation`, quantity 1, unit `check`,
  operation and provider the carrier, subject the owner, project only when the watch names one, cost the run's
  `cost_usd`) in the transaction that records its run, keyed `watch:check:<run id>`; a failed check is not billed.
- `server/billing.js` relays them to OpenVibe.Billing (`POST /api/v1/usage`, `billing.usage.record`) with the
  `openvibe-sdk/usage` reporter; 400/422 rejects a reading, 429/5xx keeps it pending. `/api/ready` reports its counts.
- Off by default (`WATCH_BILLING_INTERVAL_MS=0`). Migration `0008_billing_readings.sql`, `test/billing.test.js`.

## 2026-10-08 — account export and deletion (ADR-033)

- `POST /internal/events` (loopback, `WATCH_EVENTS_SECRET`) answers network.account.export_requested and
  network.account.deleted through `server/account-data.js` over `openvibe-sdk/account-data` (SDK v0.37.0, was v0.36.0).
- **Export:** the person's watches.
- **Deletion:** their watches with every check run, observation and endpoint state under them, and their sessions.
- The two subscriptions are created at boot. Migration `0003_account_data.sql`, nginx `location /internal/ { return 404; }`,
  `test/account-data.test.js`.

## 2026-10-08 — the public site (T18 step 8)

- **Sign in with OpenVibe** at `/auth/login`: OAuth 2 authorization code with PKCE (S256) as the
  Network client `watch`, a session in Watch's own database (only the hash of the cookie token is
  stored), and the signed-in person's `usr_…` subject as the owner.
- **A site for watches**: the home page explains Watch and starts one of the four kinds; `/watches`
  lists yours; `/watches/:id` states a watch in plain words with its observation history and every
  check run; pause, resume, delete and check-now are plain forms. Every page works without
  JavaScript.
- **One create form, four starting points** (`/watches/new?template=page|price|feed|json`): a page
  that changes, a price below a value, a new item in a feed, a JSON value — the server picks the
  fields the kind needs.
- **Honest by construction**: the kinds that arrive later (event, webhook, Run, Node) and an AI
  reading are not offered, because Watch will not pretend to check what it cannot. Notifications go
  through OpenVibe.Network exactly as before.
- **Crawl artifacts** (robots.txt, sitemap.xml, llms.txt) and a public vhost that serves the site
  while `/api/v1/*` stays loopback-only.

## 2026-10-08 — the check engine and the pull carriers (T18 steps 2–3)

- **The watch registry**: `watch.watch@1` in and out, validated with the released contracts; a
  create needs a source, an extraction, a condition and an action; ownership is the authority and
  another owner's watch is 404.
- **The check engine**: conditional GET (ETag/Last-Modified, a 304 costs no body), HEAD-first when
  only "did it change?" matters, an unchanged body recorded as `no_change`, and a recorded state for
  every terminal path with backoff and `Retry-After`.
- **Carriers**: `http`, `feed` (RSS 2.0 / RSS 1.0 / Atom 1.0) and `api` (JSON/XML, mapped), all
  through the one SSRF-guarded fetcher with per-host spacing.
- **Extraction and conditions**: text, html, a small CSS subset, json/jsonpath and regex; `changed`,
  the numeric and string predicates, `for_sec` debounce, tolerance and percent.
- **Observations and check runs**: immutable rows with value hashes, capped snapshots and retention.
- **The API** (bearer tokens, one capability per route), the `watch.*` events through the
  transactional outbox, and per-actor limits.
