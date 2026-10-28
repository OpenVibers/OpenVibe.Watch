# OpenVibe.Watch

> Persistent, user-defined observations and conditions over pages, feeds, APIs, webhooks and OpenVibe events: define what to
> watch, get told when it changes or fires — cheaply, because a Watch never polls when an event or
> the site's own ETag will do.

**Status:** alpha (plan T18). The registry, the check engine, the pull carriers (`http`, `feed`, `api`), the push
sources (OpenVibe events and signed webhooks), Node probes from the owner's own machine, the actions (a notification,
an event, a webhook, an Actor task or agent run, a Run job, a Codes task) and the public site (sign-in, seven starting
points, forms) exist. The Run rung (browser or code polling through OpenVibe.Run) and the `ai` extraction do not
yet.  
**Domain:** `openvibe.watch` (a public, server-rendered site at [Public site](#public-site); the API
is loopback-only). Install steps: [Public host](#public-host).  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 — T18 (Watch complete),
the carrier preference order, "a Watch has source, cadence or event source, extraction, comparison,
condition, action, budget, retention".  
**License:** AGPL-3.0.

## Purpose

Sources ingests the sources a product chose; Watch is the place a **person or an agent** defines
their own observation: "this page's price", "this feed's latest release", "this API's stock", and
the condition on it. Sources performs permitted structured ingestion; **Watch owns user-defined
persistent observations and conditions**; Run executes expensive browser/code checks; Node observes
local/LAN things; Actor interprets and acts; Events transports the trigger.

A Watch is a first-class OpenVibe resource (`watch.watch@1`), so products compose it instead of
each growing a watcher: Rent, Homes, Work, Deals, Reviews, price trackers, uptime, releases.

## Running it

```bash
npm install
cp .env.example .env
npm run dev            # http://127.0.0.1:4730
npm test               # every test/*.test.js against local stub sites; no internet
npm run test:pg        # the same through PostgreSQL + PgBouncer (the CI path)
```

Node 22 in production. Production: `/opt/openvibe.watch`, env `/etc/openvibe/watch.env`, unit
[deploy/systemd/openvibe-watch.service](deploy/systemd/openvibe-watch.service), database `ov_watch`
on the host's data role (ADR-035; `sudo /opt/openvibe.host/roles/data/add-service.sh watch`), nginx
[deploy/nginx/openvibe.watch.conf](deploy/nginx/openvibe.watch.conf).

`GET /api/health` is liveness. `GET /api/ready` (openvibe-shared/ready) is 503 only when the
database fails; a Network key that has not loaded and a check worker that is off, stopped or behind
(a watch due for more than 15 minutes) degrade it. It reports watch counts by health status, checks
in flight, observations by state and the outbox backlog. `GET /metrics` (openvibe-shared/metrics)
answers direct loopback callers only: golden signals by route template, `watch_watches{status}`,
`watch_observations{state}`, the check queue (`watch_checks_due`,
`watch_checks_oldest_wait_seconds`, `watch_checks_in_flight`),
`watch_last_check_timestamp_seconds`, `watch_last_success_timestamp_seconds`.

Request telemetry: every HTTP request is aggregated by route template, method and status class, never
by raw URL. Once a minute one `http.request` sample per key, plus the active-requests, p95 latency and
event-loop-lag gauges, goes to this service's own `telemetry_samples` table (openvibe-sdk 0.46,
`platform.telemetry-sample@1`, migration 0011); rows older than 14 days are deleted daily. `/shared`
files, static assets, health, readiness and `/metrics` are not counted. `server/app.js` mounts
openvibe-sdk's `telemetryMiddleware` (a no-op until init); `server/index.js` calls `telemetry.init()`
at production start, runs the retention and flushes on stop.

## Public site

`openvibe.watch` is also the place a person manages their own watches in a browser. Every page is
server-rendered and complete without JavaScript: the create and edit forms POST, pause/resume/
delete/check-now are plain forms, and the fields a form shows are chosen by the query
(`/watches/new?template=price`), not by script. The visual layer is plain semantic HTML on the
classes openvibe-shared's frame and this repository's `public/css/app.css` already provide.

**Sign-in** is OpenVibe.Network's OAuth 2 authorization code with PKCE (S256), as the OAuth client
`watch` (`OV_OAUTH_CLIENT_ID`/`OV_OAUTH_CLIENT_SECRET`), redirecting to `BASE_URL/auth/callback`.
The Network token is verified once (issuer, audience `openvibe.network`, a `usr_…`/`agt_…` subject)
and then discarded; the browser holds an opaque random session token in an httpOnly, SameSite=Lax
cookie, and Watch's database stores only its SHA-256 hash (`web_sessions`, migration 0002). The
signed-in person's `usr_…` subject is the watch owner: the site calls the **registry directly,
in-process**, with exactly the ownership rules the API applies — another person's watch is 404 on
every page and every form, never 403. A signed-in write must also come from this site itself
(same-origin), so another site cannot make a visitor act here.

| Page | What it shows |
|---|---|
| `/` | what Watch is in one paragraph; the seven starting points as cards; channels active on OpenVibe.Live lately (live first) with a "tell me when they go live" watch each; ready-made watches (Host plan prices, release and job feeds, each blog's new posts); how it checks in plain words; the API samples; the questions (FAQPage JSON-LD); your watches summary (counts by status) when signed in. The channels, plans and blogs are OpenVibe.Search's public documents, read anonymously and kept 10 minutes ([server/http/network-reads.js](server/http/network-reads.js), `WATCH_SEARCH_URL`, `https://search.openvibe.network` in production, off elsewhere); a section with nothing to show is left out |
| `/watches` | your watches: name, source host, condition in words, status, last check state and time, last value, next due — paged with `before` |
| `/watches/new?template=page\|price\|feed\|json\|event\|webhook\|lan` | the one create form, showing only the fields the chosen kind needs; a link may fill it in (`url`, `name`, `value_path`, `op`, `value`, `event`, `event_filter`, `agent_id`), and the person still reviews and saves |
| `/watches/:id` | the watch in words, status with pause/resume/delete/check-now, the observation history (time, value, changed, condition met) and the check runs with their states in plain words, both paged |
| `/watches/:id/edit` | the same form, PATCH semantics |
| `/how-it-works`, `/updates` | the carrier order, the manners and every state, in plain words; Watch's own changelog |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt(/-full)` | discovery: the home page and how-it-works are listed; `/watches` and `/auth` are disallowed |

**Seven starting points**, each a page of the same form ([server/http/pages.js](server/http/pages.js) `TEMPLATES`):

| Template | Source | Extraction | Condition |
|---|---|---|---|
| `page` | http | html, an optional CSS selector | `changed` |
| `price` | http | css selector or regex | `lt`/`lte`/`gt`/`gte` |
| `feed` | feed | the newest item (`latest`) | `changed` |
| `json` | api | json with an optional `value_path` | any of the ops |
| `event` | event (a channel goes live, a blog post, a wiki page published …) | the event | `changed` |
| `webhook` | webhook (the watch's own signed address) | json with an optional `value_path` | any of the ops |
| `lan` | node (a host:port on the owner's own network, checked by their own computer) | `status` | `eq` `down` |

Besides **Notify me**, the form can run one of the person's OpenVibe.Actor agents (`actor-agent`, by its `agt_` id,
with an optional note) or start a coding task on OpenVibe.Codes in a repository they name (`codes-run`) when the watch
fires.

The cadence is a select (15 minutes, 1 hour, 6 hours, 1 day); 15 minutes is the shortest a person may
choose here (the contract's floor is 30 seconds, for a service). A validation error re-renders the
form with the person's own input and the registry's own message next to the field it names. The
kind whose carrier does not exist yet (`run`) and the `ai` extraction are **not offered** — and a watch of such a kind
created through the API still answers `watch.carrier_unavailable` when checked from the site, fetching nothing. An
event watch is checked when its event arrives and a webhook watch when a signed delivery reaches its `/hooks/` address,
so Check now answers `watch.event_awaited` or `watch.webhook_awaited`, fetching nothing.

Check-now from the page respects the API's limits and its refusals: a second check while one runs or
a check of a paused watch is the API's 409, said in words; a kind without a carrier is the API's 422;
and the manual-check and write budgets (10/120 and 30/600 per person, a minute/hour) are enforced
with a friendly page. "Notify me" stores the notification action: when the condition fires the owner gets one
notification on OpenVibe (through OpenVibe.Network), and the watch page lists what each firing did under "What it did
when it fired".

## The watch model

A Watch is: `source`, `cadence` (or an event pattern), `extraction`, `comparison`, `condition`,
`action`, `budget`, `retention`, plus `owner`, `status`, `labels`. It is validated against
`watch.watch-request@1` on the way in and served as `watch.watch@1` on the way out — both with
openvibe-contracts' own validator, never a hand copy of the schema. Rules a schema cannot carry
([server/registry.js](server/registry.js)): a create requires source, extraction, condition and
action; a source that polls (`http`, `feed`, `api`, `node`, `run`) needs `cadence.every_sec`; an
`event` or `webhook` source is pushed to and never polls (`cadence: null`); the headers the fetcher
owns (`Host`, `Cookie`, `User-Agent`, `If-None-Match`, …) cannot be overridden.

**Ownership is the authority.** Every read and write is scoped to the acting subject — a person's
`usr_…`/`agt_…` bearer token, or a first-party service acting for a person with `X-OV-Subject` —
and another owner's watch is **404, never 403**: an id must not confirm that someone else's watch
exists. A service principal that does not name a person owns what it creates.

## Carrier preference (binding, plan T18)

    webhook/event → ETag/Last-Modified → feed → API → and only then browser polling through Run

The rungs run from cheapest to most expensive, and `source.kind` fixes which one a watch uses.
This release carries the pull rungs and event sources:

| Kind | Carrier | State |
|---|---|---|
| `http` | one URL, conditional | implemented |
| `feed` | RSS 2.0 / RSS 1.0 (RDF) / Atom 1.0 → `{ items, latest, count }` | implemented |
| `api` | JSON/XML with `items_path` + `fields`, or the body itself | implemented |
| `event` | delivered by OpenVibe.Events (see [Event sources](#event-sources)) | implemented |
| `webhook` | a signed POST to `/hooks/<watch id>` (see [Webhook sources](#webhook-sources)) | implemented |
| `run` | browser/code polling through OpenVibe.Run | step 6 |
| `node` | a probe from the owner's own machine through OpenVibe.Bot and OpenVibe.Node (see below) | implemented (step 7) |

**Node sources** (plan T18 step 7, contracts 0.167.0, [server/carriers/node.js](server/carriers/node.js)): `{ kind: 'node', node_id: 'dev_…', probe: { target, timeout_s } }`. The check runs from the owner's own machine:
- **The call**: Watch asks OpenVibe.Bot (`WATCH_BOT_URL`, default `http://127.0.0.1:4630`) with its own token (`bot.computer.control`) and the owner in `X-OV-Subject`. Bot answers only for that person's machine, only where they turned on "Let my watches check things from this computer", and Watch may send nothing but the read-only `probe`.
- **Targets**: the machine's OpenVibe Node reaches only its own network (private, loopback or link-local addresses).
- **http(s) targets**: the answer's body is extracted like a page, and a status other than 200/203 is an `http_error`.
- **tcp targets**: the document is `{ open, status: 'up' | 'down', ms }`.
- **Owners**: an agent-owned watch is never probed (`node_person_only`).
- **The form**: its "Something on your network goes down" template makes one: a machine id, a host:port, and the condition `status` eq `down`.

A kind whose carrier does not exist yet is **accepted by the registry but never fetched**: the
check is recorded `skipped` with `watch.carrier_unavailable` and the reason names the step. That is
what keeps a half-built rung from silently turning into polling.

## Event sources

A watch whose source is `{ "kind": "event", "pattern": "host.release.published", "filter": { "repo": "OpenVibe.Bot" } }`
(and `cadence: null`) is checked when a matching OpenVibe.Events event arrives, and never on a cadence, so it costs
nothing while nothing happens (`server/event-sources.js`, `server/carriers/event.js`).

- **Matching.** The pattern matches the event type as Events matches topics: `*` stands for one or more whole
  segments (`media.*.ready`). Every `filter` key must equal the event's value: `subject.id`, `subject.type`, or a
  top-level `payload` field.
- **What the extraction reads.** The event is the check's document: `{ event_type, event_id, timestamp, subject,
  payload }`, so `{ "kind": "json", "value_path": "payload.version" }` takes the released version. Comparison,
  condition, observations and actions work exactly as for a fetched page.
- **Only public events.** Anyone may own a watch, and an internal or private event is not theirs to read, so only
  events with `visibility: "public"` wake a watch.
- **Once per event.** Events delivers at least once; each `event_id` is handled once (`event_source_receipts`, kept
  seven days), so a redelivery is answered `duplicate`.
- **A budget.** At most `WATCH_EVENT_MAX_PER_HOUR` (60) event checks per watch an hour. More are dropped and counted,
  so a busy pattern cannot turn one watch into a write storm.
- **Subscriptions.** Watch keeps one Events subscription per distinct pattern of an active event watch, delivered to
  the same signed loopback route as the account events (`POST /internal/events`, `WATCH_EVENTS_SECRET`). A sync at
  boot, every `WATCH_EVENT_SYNC_MS` (10 minutes) and two seconds after an event watch changes creates the missing ones,
  re-enables one a watch needs again, and disables the ones no watch needs. It never touches the account
  subscriptions or another endpoint's. It is off without `EVENTS_URL`, the secret or the OAuth client secret.
- **Check now** on an event watch answers 422 `watch.event_awaited`: there is no event to read.

## Webhook sources

A watch whose source is `{ "kind": "webhook" }` (and `cadence: null`) is woken by a POST to
`https://openvibe.watch/hooks/<watch id>` from anything that can call a webhook: GitHub, a CI, a store, another OpenVibe
product (`server/webhook-sources.js`, `server/carriers/webhook.js`).

- **The address is the watch's own.** Its stored endpoint is `/internal/hooks/<watch id>` (the form `watch.watch@1`
  names), whatever a caller sent, so a watch can never point at another watch's address.
- **The secret is shown once.** Creating the watch answers `{ watch, webhook: { url, secret } }`. The secret
  (`whk_…`) is never shown again; `POST /api/v1/watches/:id/webhook-secret` replaces it (the old one stops working at
  once). It is kept in full because checking a signature needs it (`webhook_secrets`), and it goes with its watch:
  deleting the watch or the account removes it.
- **Signing.** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the exact body with the secret>` (GitHub's form), or
  `Authorization: Bearer <secret>` for a sender that cannot sign. Compared in constant time.
- **What the extraction reads.** A JSON delivery is parsed and becomes the document (`value_path: "order.total"`); any
  other is read as text (`text`, `regex`). A delivery that says JSON but is not records `parse_error`.
- **Answers.** 200 `{ watch_id, state, triggered }` after the check. 401 for a missing or wrong signature. 404 for an
  unknown address or a watch that is not a webhook watch. 409 for a paused watch. 413 over 256 KB. 429 with
  `Retry-After` over `WATCH_WEBHOOK_MAX_PER_HOUR` (60) deliveries an hour. 503 with `Retry-After: 1` while the watch's
  previous check still runs.
- **Check now** on a webhook watch answers 422 `watch.webhook_awaited`: there is no delivery to read.

## A check

An in-process scheduler ([server/scheduler.js](server/scheduler.js)) starts checks for active
watches whose `next_due_at` and `not_before` have passed, oldest first, at most
`WATCH_MAX_CONCURRENT` at a time; `check.run()` refuses a second check of the same watch, so a
manual `POST …/check` never overlaps a scheduled one. One check
([server/check.js](server/check.js)):

1. **Carrier** chosen by `source.kind` (never for event/webhook/node/run — see above).
2. **Fetch** through the one way out: the SSRF guard, per-host spacing, conditional GET.
   - `If-None-Match` / `If-Modified-Since` from the stored validators; a **304 → `not_modified`**
     (no body, no observation).
   - When the watch only needs to know *whether* it changed (`condition.op: changed`), a **HEAD**
     is tried first while a validator is stored: two headers instead of a body.
   - A 200 whose body hashes to the last body → **`no_change`** (no observation).
   - 429/503 `Retry-After` → `not_before`, so Watch waits as long as the site asked.
3. **Extract** the value (table below) from the body, or from the records a feed/api carrier mapped.
4. **Compare and evaluate**: `changed` (with `tolerance`/`percent`), the predicate, and the
   `for_sec` debounce measured from the observation trail — an unchanged body still evaluates the
   condition, so "this has been true for five minutes" can fire without the page changing.
5. **Record**, in ONE transaction: the `check_runs` row, the `observations` row (value, hashes,
   changed, condition_met, capped snapshot, `retained_until`) and the events.
6. **Arm** `next_due_at` (the cadence plus jitter, or an exponential backoff after failures, capped
   at `WATCH_MAX_BACKOFF_MS`).

A condition that fires is recorded on the check run (`state: condition_met`, `triggers: 1`) and
emits `watch.watch.triggered`; it fires again only for a value that is new or for a new run of
holding, never once per check while nothing moves (the last firing is compared by when it finished: the holding trail
starts at the observation the firing run recorded).

## Actions

A fired condition queues the watch's actions in the same transaction as the check run that fired
(`server/actions.js`, table `action_runs`): each action once per trigger. The action worker (every
`WATCH_ACTIONS_TICK_MS`, up to `WATCH_ACTIONS_BATCH` at a time, off with `WATCH_ACTIONS=off`) delivers them:

| kind | what happens |
|---|---|
| `notification` | the owner gets one OpenVibe notification through OpenVibe.Network (`openvibe-sdk/notifications`, type `WATCH_TRIGGERED`): the watch's name, the value (and the value before), and a link to the watch page. A refusal retries after 1, 5 and 30 minutes, 2 and 6 hours, then `failed`; an owner Network does not know (a deleted account) is `skipped`; a person who switched the category off is Network's decision and counts as `sent`. A watch owned by an agent or a service has no one to notify (`skipped`). Needs the Network OAuth client secret and the grants `identity.subject.resolve` + `network.notifications.push` |
| `event` | `watch.watch.triggered` is emitted with every firing in the run's own commit, so that action is recorded `sent` as it is queued (the event names a person: an agent- or service-owned watch is `skipped`). Any other event type is not declared by Watch: `unavailable` |
| `webhook` | a POST of the firing (`type`, `watch {id, name, url}`, `check_run_id`, `condition`, `observation {observed_at, value, previous_value}`) to the action's https URL, through the same SSRF guard as every fetch, never following a redirect ([server/net/post.js](server/net/post.js)). It is signed with the key `secret_env` names exactly as OpenVibe.Events signs a delivery (`X-OpenVibe-Timestamp` + `X-OpenVibe-Signature-V2`; check it with openvibe-sdk/events `verifyDeliveryV2`). `X-OpenVibe-Delivery-Id` (`<check run>.<action index>`) is the same on every attempt, so a receiver can drop a repeat. 2xx is `sent`. 410 or a URL the guard refuses is `failed` at once. Anything else, or a lost connection, is retried on the backoff, then `failed`. The key must be granted to the owner (`WATCH_SECRET_GRANTS`, below) and set, 32 characters or more: otherwise `unavailable` |
| `actor-task` | a task for the owner on OpenVibe.Actor ([server/actor.js](server/actor.js)): the action's `brief`, followed by the firing as context (the watch, the value and what it was, its page), at most `budget_usd`. Watch names the owner in `X-OV-Subject`, so the task runs under **the owner's** allowance and appears in their task list, and Actor records Watch as `via`. The idempotency key `watch.<check run>.<action index>` makes a retried delivery the same task. Created is `sent`, with the task id recorded. A request Actor refuses as invalid (over the tier's budget, an unknown agent) is `failed` at once. Anything else, including a day's allowance spent, is retried on the backoff. An agent- or service-owned watch is `skipped`. Needs `actor.task.create` for `openvibe.actor` (Network grants it) and `WATCH_ACTOR_URL` |
| `actor-agent` | runs one of the person's OpenVibe.Actor agents by `agent_id`. Its optional `note` precedes the firing context (watch name and link, value and previous value, observation time); input is capped at 8000 characters without cutting the note. Watch uses `X-OV-Subject` for the owner. A created run is `sent` with its task id; a missing agent, limit or free-tier refusal is `failed` for that firing; service errors retry on the usual backoff. Only person-owned watches may use it. Needs the `actor.agent.run` grant for `openvibe.actor` and `WATCH_ACTOR_URL` |
| `run-job` | one OpenVibe.Run job for the owner in the watch's project ([server/run-jobs.js](server/run-jobs.js)): the action's `run.job-create-request@1` fields (`class`, `artifact`, `args`, `limits`, `egress`, `ttl_ms`), with the firing (watch, check run, value, previous value, time) under `args[firing_arg]` when the action names one. Watch submits as itself with the owner in `X-OV-Subject` and the project in `X-OV-Project` (project delegation, ADR-003 amendment 2026-10-12): Run bills the project, checks the owner is still an admin or owner of it, makes the owner the requester and records Watch as `via`. Key `watch.<check run>.<action index>`, so a retry is the same job. Created is `sent` with the job id; Run's final refusals (400, 403, 404, 409, 413, 422) are `failed` at once; anything else retries on the backoff. `WATCH_RUN_URL` is Run's internal address (default `http://127.0.0.1:4920`). |
| `codes-run` | a coding task on OpenVibe.Codes for the owner, run on the owner's own machine ([server/codes-tasks.js](server/codes-tasks.js), Contracts 0.162 `codes.task.start`): the action's `brief` with the firing as context (at most 8000 characters), in the `repo` it names. Watch starts it as itself with the owner in `X-OV-Subject`; Codes runs it in the project of the owner's latest openvibe.codes/run task and lists it on their /run page. Key `watch.<check run>.<action index>`, so a retry is the same task. Created is `sent` with the task's page; a refusal a retry cannot change (400, 403, 404, 409 — `codes.no_project` when the owner has never started a task on /run — 413, 422) is `failed` at once; anything else retries on the backoff. A person must own the watch: otherwise `skipped`. The create and edit forms offer it ("Start a coding task on my own machine"). `WATCH_CODES_URL` is Codes' internal address (default `http://127.0.0.1:4900`). |

**Into a team room.** An OpenVibe.Chat workspace room's hook (room settings → "Alerts into this room") takes a
`webhook` action as it is: its address is the action's `url`, and its `whsec_` secret, saved as a project secret granted
to `watch`, is the action's `secret_ref`. Each firing then arrives in the room as a message from Vibe, with the watch's
link, and can queue a task for the hook's maker.

A watch with a `run-job` action names a **project** (`project_id` on `watch.watch-request@1`, required for it:
`422 watch.project_required`). Only a person names one, and only a project OpenVibe.Network says they are an admin or
owner of and that is not archived (`GET /internal/projects/:project/members/:subject`, `network.project.member.read`),
checked when the project is named or changed: `403 project.not_delegated` otherwise, `503
watch.project_check_unavailable` when Network cannot answer. Run checks again before every job. The run-job action
needs `class` and `limits` (and `artifact` for `function` and `code`); the contract draft's `runtime`, `command` and
`workload` are refused.

Rows are claimed with a short lease (FOR UPDATE SKIP LOCKED), so two processes never deliver one row at once.
Network keeps no idempotency record for a push, so a lost answer can repeat a notification: delivery is at least once.
`/api/ready` reports the queue (`actions: { enabled, queued, failed, sent }`).

Nothing is invented: a value the source did not state is `null`, a failed check is a recorded state,
and the validators/body hash are stored only after a body was read successfully, so an unreadable
body is fetched and parsed again next time.

`check_runs.state` is one of `ok | not_modified | no_change | changed | condition_met | http_error |
timeout | parse_error | rate_limited | budget_exceeded | skipped | disabled`; every check re-arms the
watch on every terminal path.

### Extraction (`watch.watch@1` `$defs/extraction`)

| Kind | Reads |
|---|---|
| `text` | the whole body as text, trimmed (capped at 64 KiB) |
| `html` | the body's text, or the text of the first element `selector` matches |
| `css` | the same, with the small selector subset: `tag`, `.class`, `#id`, `[attr]`, `[attr=value]`, descendants and `>` |
| `json` / `jsonpath` | the parsed body, or a carrier's mapped `{ items, latest, count }`; `value_path` picks a part (`latest.price`, `items.0.title`), `fields` several at once |
| `regex` | the first match of `selector` (its first group when it has one), e.g. `(\d+\.\d+) EUR` |
| `ai` | **not a check**: an AI reading is an action (step 10). The watch is accepted, the check is recorded `skipped` with `watch.extraction_unavailable`, and nothing is fetched |

A path that matches nothing and a pattern that does not match extract `null` — which `absent` then
answers truthfully.

### Conditions (`watch.watch@1` `$defs/condition`)

`changed` (the default), `gt`, `gte`, `lt`, `lte`, `eq`, `ne`, `contains`, `matches`, `exists`,
`absent`; `for_sec` debounces a condition that must hold that long. Comparison refuses to guess: a
value that is not a number (or a plain decimal string) is never "greater than" anything, and an
unknown value is never low — the same rule Deals' watches use. `comparison.tolerance` (absolute)
and `comparison.percent` decide whether a move counts as a change at all.

### Observations

Immutable rows (`watch.observation@1`): the extracted `value`, its SHA-256 `value_hash` over the
canonical JSON, `previous_hash`, `changed`, `condition_met`, a capped `snapshot` of the body it came
from, and `retained_until` (the watch's `retention.observations_days`, `WATCH_RETENTION_DEFAULT_DAYS`
= 90 by default; `keep_snapshots: false` stores no snapshot). An hourly prune drops what is past its
retention.

## API (bearer tokens, one capability per route)

Callers present an OpenVibe.Network token for audience `openvibe.watch`: a service's
client-credentials token (judged by its `cap` claim with the contracts grant rule) or a signed-in
person's or agent's token (`usr_…`, `agt_…` — a watch is theirs, and ownership scoping is the
authority). A first-party service (`svc:…`) may present `X-OV-Subject: usr_…` to act for a person;
an app or module may not.

| Capability | Routes |
|---|---|
| `watch.watch.read` | `GET /api/v1/watches?status=&project_id=&before=&limit=`, `GET /api/v1/watches/:id` |
| `watch.watch.manage` | `POST /api/v1/watches`, `PATCH /api/v1/watches/:id`, `POST /api/v1/watches/:id/pause`, `POST /api/v1/watches/:id/resume`, `POST /api/v1/watches/:id/webhook-secret`, `DELETE /api/v1/watches/:id` |
| `watch.observation.read` | `GET /api/v1/watches/:id/observations?before=&limit=`, `GET /api/v1/watches/:id/checks?before=&limit=` |
| `watch.check.run` | `POST /api/v1/watches/:id/check` (404 unknown, 409 `watch.busy` while one runs, 409 `watch.disabled` for a paused watch, 422 `watch.carrier_unavailable`, or 422 `watch.event_awaited` for an event source) |
| `watch.resource.read` | `GET /api/v1/resources?project=&kind=&cursor=&limit=`, `GET /api/v1/resources/:ovrn` (first-party service token only) |
| `watch.resource.control` | `POST /api/v1/resources/control` (first-party service token only; ADR-048, [server/api/resource-control.js](server/api/resource-control.js)): a `common.resource-control-request@1` for a watch from OpenVibe.Services acting for its owner (`on_behalf_of`) — `suspend` (pause), `resume`, `delete`; other actions refused `control.unsupported_action`; only the owner's watch in the OVRN's project (otherwise `resources.unknown_resource`); `dry_run` applies nothing; the first answer per (caller, project, `idempotency_key`) is kept (`watch_control_log`, migration 0009) and a key reused for another request is 409. Loopback only: the public vhost 404s `/api/v1/resources*`. |

The loopback-only authority index lists non-deleted `watch.watch` resources as
`common.resource-list-result@1`. It orders watches by id, pages with an opaque cursor, and
includes an OVRN only for a watch with a valid project id.

The list answer is exactly `watch.watch-result@1` (`{ watches }`): page with
`before=<the last watch's id>`, since a `wch_` id is a ULID, i.e. creation order. Every watch view,
observation view and check-run view is validated against its released contract before it is sent.
Errors are problem+json (`watch.not_found` 404, `watch.invalid` 422 with the validator's detail).

### Per-actor limits

Every route also limits the principal that passed its capability guard, before any work:
[server/api/actor-limits.js](server/api/actor-limits.js), openvibe-sdk/limits. Past a limit: `429`
problem+json `rate_limited` with `Retry-After`, one `[limits]` log line and
`watch_rate_limited_total{limit,window}`.

| Routes | Per principal, a minute / an hour |
|---|---|
| Reads by an app or module (`app:…`, `mod:…`) | `WATCH_LIMITS_MINUTE` / `WATCH_LIMITS_HOUR` (120 / 3000) |
| `POST`/`PATCH`/`DELETE /api/v1/watches[/:id]`, pause, resume | 30 / 600 |
| `POST /api/v1/watches/:id/check` | 10 / 120 |

A first-party service (`svc:…`) is not counted on reads: the public site and agent runtimes read for
many people, and one budget for the whole service would refuse real people's work. Watch's own
worker (the scheduler, the carriers, the outbox relay) runs in-process and never passes through
HTTP. Never limited: `/api/health`, `/api/ready`, `/release.json`, `/metrics` and the home page.

## Events (transactional outbox → OpenVibe.Events when `EVENTS_URL` is set)

- `watch.observation.recorded` (low) — a check recorded an observation, with the value as the source
  stated it and its hash, never the raw body.
- `watch.watch.triggered` (important) — a condition fired, with the observation that fired it. This
  is what OpenVibe.Network turns into a `WATCH_TRIGGERED` notification for `payload.recipient`.
- `watch.check.failed` (important) — a check ended in a failure state, with `consecutive_failures`
  so a consumer can tell a blip from a watch that is down.

All `visibility: internal`, subject `{ type: watch, id: <watch_id> }`, actor `service:watch`,
envelopes validated as `events.event-envelope@1` and payloads against their released contracts. The
watch-lifecycle events (`watch.watch.created`, `watch.watch.updated`, `watch.watch.paused`,
`watch.watch.removed`) are emitted on the registry's writes; they have no payload contract yet.

`openvibe-sdk/events` owns the transactional outbox and relay. Pending rows live in `service_outbox`
(migration 0004); the migration copies pending rows from `event_outbox`, which remains through the
rollback window. When `EVENTS_URL` or the OAuth client secret is unset, rows wait for the relay.

A watch owned by a service (`svc:…`) still records every observation and trigger in its own tables,
but the person-facing payloads name a `usr_…`/`agt_…` owner (and a trigger a `usr_…` recipient), so
those two events are logged as not emitted rather than sent with a payload the contract refuses.

## Account export and deletion (ADR-033)

`network.account.export_requested` and `network.account.deleted` arrive at `POST /internal/events`. It is
loopback-only (nginx answers 404 for `/internal/`, and the handler refuses a forwarded request) and signed with
`WATCH_EVENTS_SECRET`. They are answered by `server/account-data.js` over `openvibe-sdk/account-data`.

- **Export:** the person's watch definitions, with how many check runs and observations each has.
- **Deletion:** their watches go with every check run, observation and conditional-GET state under them, and so do
  their sign-in sessions (never exported). A staff edit's `updated_by` on someone else's watch becomes NULL.
- **Receipts:** `account_data_events` (migration 0003) keeps one per export and deletion, so a redelivery changes
  nothing.
- **Subscriptions:** the two are created at boot when missing.

## Security

Reporting: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Auth.** Every `/api/v1` route needs a token for audience `openvibe.watch` with that route's ONE
  capability (`svc:…` by capability grant, `usr_…`/`agt_…` by identity), then passes the per-actor
  limits. `X-OV-Subject` is honoured only from a first-party service. The vhost keeps `/api/v1/*`
  loopback-only.
- **Ownership.** Reads and writes are scoped to the acting subject; another owner's watch answers
  404 on every route — and on every page and form of the public site, which acts on the same
  registry in-process.
- **Site sessions.** The browser holds an opaque random token in an httpOnly, SameSite=Lax cookie;
  the database keeps only its SHA-256 hash, and the Network access token is verified once and
  discarded. A signed-in write must be same-origin, and the page forms escape every value they show
  (the `html` tagged template, `server/render/html.js`).
- **Egress.** A watch fetches outside URLs by design, only through the guard:
  [server/net/guard.js](server/net/guard.js), http(s) on `WATCH_ALLOWED_PORTS` (80/443), every
  resolved address public at connect time (no DNS rebinding), each redirect hop re-checked, one
  deadline and a byte cap per response. Exactly one path reaches the network — the carriers, through
  the fetcher — and only for a kind whose carrier exists. `test/carriers.test.js`.
- **Secrets.** A source's credential is the **name** of a `WATCH_CRED_*` variable, and a webhook
  action's signing key the name of a `WATCH_HOOK_*` one. Both are read at use time, never stored or
  logged. A name is **not a capability**: the operator grants each one in `WATCH_SECRET_GRANTS`
  ([server/secret-grants.js](server/secret-grants.js)). A credential may be used only by the owners
  it is granted to, and sent only to the origins it is granted for. A webhook key may be used only by
  its owners. Otherwise anyone could name an operator's credential with a URL of their own, or have
  deliveries signed with another receiver's key. A name without a grant is usable by nobody. A save
  that names one is refused with 422 `watch.secret_not_granted` (the form shows why), and the carrier
  and the action worker check again at use. `OV_OAUTH_CLIENT_SECRET`, the credentials and the grants
  live in `/etc/openvibe/watch.env` (0600).
- **Project secrets (ADR-056).** A watch that names a project may use that project's own secrets instead:
  `source.auth.secret_ref` for its credential, and `secret_ref` on a webhook action for its signing key,
  looked up in the watch's `project_env` (production by default). OpenVibe.Network keeps them and the project
  grants each to `watch` (on openvibe.services, the project's Secrets page). A credential is **revealed** by
  Network for the source URL's origin only, at fetch time, and used for that one request. A webhook is
  **signed** by Network over `"<t>.<raw body>"` in the usual headers, so Watch never holds that key. A secret
  Network refuses leaves the credential missing (the check says so), or makes the action unavailable.
  Network unreachable is retried. Watch holds `network.secret.use` (Network's default grant), and naming a
  project secret needs `project_id` (422 `watch.project_required`).
- **Data.** An observation records what the source stated, never a guess; snapshots are capped and
  pruned by retention; a failed check never records an observation.

## Owns

- the watch registry (`watches`, `watch_endpoint_state`) and the `watch.watch@1` /
  `watch.watch-request@1` / `watch.watch-result@1` shapes it serves
- checks: `check_runs`, `observations`, the scheduler, conditional-fetch state, backoff
- the public site's sign-in sessions (`web_sessions`) and its pages
- `watch.*` events

## Does not own

- structured source ingestion for publication (OpenVibe.Sources' registry and adapters): Watch
  observes what one person or agent asked for, not what a product publishes
- expensive browser/code execution (OpenVibe.Run, step 6) and local/LAN probes (OpenVibe.Node,
  step 7) — Watch asks them, they run
- interpreting a trigger and acting on it (OpenVibe.Actor, OpenVibe.Codes, actions = step 4)
- delivery of a notification (OpenVibe.Network consumes `watch.watch.triggered`)

## Depends on

- PostgreSQL 18 (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through
  `openvibe-sdk/db`
- OpenVibe.Contracts (the watch contracts, service tokens, capability checks, problem details, ids,
  the event envelope; `wch_`/`wco_`/`ckr_` in `lib/ids.js`)
- OpenVibe.Network (signing key; service principal `watch`; grants `network.account.export.contribute` and
  `network.account.deletion.confirm` for account export and deletion, given last, once this release is live)
- OpenVibe.Events (outbound events; the two account subscriptions, created at boot with `events.subscription.manage`)
- OpenVibe.Billing (one `check-operation` usage reading per completed check, `POST /api/v1/usage` with `billing.usage.record`; off by default, `WATCH_BILLING_INTERVAL_MS`)

## Capabilities

Implemented here (the service manifest's `capabilities`; routes in [API](#api-bearer-tokens-one-capability-per-route)):
`watch.watch.read`, `watch.watch.manage`, `watch.observation.read` and `watch.check.run`, each
checked by [server/auth.js](server/auth.js) with the contracts grant rule for audience
`openvibe.watch`.

Called elsewhere, as the service principal `watch` (client credentials from OpenVibe.Network):

| Service | Grant | Why |
|---|---|---|
| OpenVibe.Events | `events.event.publish` (audience `openvibe.events`) | the outbox relays `watch.observation.recorded`, `watch.watch.triggered`, `watch.check.failed` and the lifecycle events |
| OpenVibe.Run | `run.*` (plan T18 step 6) | not yet: a `run` source answers `watch.carrier_unavailable` today, and `WATCH_RUN_URL` (`http://127.0.0.1:4920`) is where it will call |

## Acceptance (tests)

- the release contract on both sides: bodies validated against `watch.watch-request@1`, every watch,
  observation and check-run view against `watch.watch@1` / `watch.observation@1` /
  `watch.check-run@1`, and every emitted payload against its released event contract
  (`test/api.test.js`, `test/registry.test.js`, `test/check.test.js`)
- conditional GET: validators stored, 304 → `not_modified`, identical body → `no_change`, a HEAD
  answers `changed` without a body (`test/carriers.test.js`)
- the guard refuses a private host before any socket, a redirect into a private address, a port
  outside `WATCH_ALLOWED_PORTS`, URL credentials (`test/carriers.test.js`)
- credentials by variable name, read at fetch time, never stored, missing → `disabled` with no
  request (`test/carriers.test.js`)
- feeds and mapped APIs, `items_path`/`fields`, and the parse errors they can raise
  (`test/carriers.test.js`)
- every condition op, tolerance and percent, `for_sec` debounce (`test/condition.test.js`); every
  extraction kind, the selector subset, and `ai` refusing (`test/extract.test.js`)
- a check writes its run and its observation and emits `watch.observation.recorded`; a fired
  condition emits `watch.watch.triggered`; failures emit `watch.check.failed` and back off;
  event/webhook/node/run sources and an `ai` extraction are never fetched; retention prune
  (`test/check.test.js`)
- due order, the concurrency cap, `not_before`, backoff, and the worker checking on its own tick
  (`test/scheduler.test.js`)
- the API: one capability per route, owner scoping 404, 422 from the validator, pause/resume/delete,
  X-OV-Subject delegation, the check and observation reads, per-actor 429 (`test/api.test.js`)
- the registry: required fields, cadence rules, forbidden headers, due selection, re-arm, soft
  delete, the keyset page (`test/registry.test.js`)
- the public site (`test/site.test.js`): sign-in through the stand-in Network (PKCE, a session,
  state mismatch refused, `/auth/me`, sign-out), the signed-out pages, each create template against
  what the API would store, validation errors that keep the input, another person's watch 404 on
  every page and form, pause/resume/delete/check-now against a stub site (with the API's 409s and
  422), cross-site writes refused, and hostile names and values escaped on every page

Demonstrated on production (2026-10-15): a check against a real site from the deployed service.
- A feed watch on openvibe.work's `/jobs.atom` was made from Work's Get alerts link and submitted through the
  prefilled form.
- One check answered HTTP 200 with one observation; the condition was met and the notification fired.
- The proof watch was deleted.

Not yet demonstrated: the Run rung (step 6), which answers `watch.carrier_unavailable` and fetches nothing
today (node sources are covered by `test/node-carrier.test.js` against a stand-in Bot) — and the action kinds beyond notifications. Event sources are covered end to end by
`test/event-sources.test.js` (matching, visibility, once per event, the budget, the signed route and the subscription
sync against a stand-in Events), and webhook sources by `test/webhook-sources.test.js` (the secret shown once, both
signing forms, every refusal, the budget, rotation, text and JSON bodies, and removal).

## Deploy

`sudo ovhost deploy watch` on the host: git checkout at `/opt/openvibe.watch`, unit
[deploy/systemd/openvibe-watch.service](deploy/systemd/openvibe-watch.service) as
`openvibe-watch.service` on `127.0.0.1:4730`, env `/etc/openvibe/watch.env` (0600) from
[.env.example](.env.example), database `ov_watch` on the host's data role (ADR-035,
`sudo /opt/openvibe.host/roles/data/add-service.sh watch`). nginx serves `openvibe.watch` from
[deploy/nginx/openvibe.watch.conf](deploy/nginx/openvibe.watch.conf); the pages, `/auth/*` and the
discovery files are public, `/api/v1/*` and `/internal/*` stay loopback-only. Rollback: ovhost puts
the previous sha back by itself when `/api/ready` does not answer 2xx after the restart; afterwards
`sudo ovhost rollback watch --to <sha>`. Nothing is deployed yet: there is no host install, and
openvibe.watch has no DNS or vhost.

## Public host

`openvibe.watch` serves the site at the edge: the pages, `/auth/*`, `/css/*` and `/shared/*`, the
discovery files, and `/api/health`, `/api/ready`, `/release.json`. It keeps `/api/v1/*`
loopback-only, exactly as before, so the service API is reached only from the host. Sign-in and form
POSTs have their own per-address limit zones (nginx refuses `limit_req` inside `limit_except`, so a
`map` on `$request_method` gives GET/HEAD an empty key). Install: copy the unit and the vhost, write
`/etc/openvibe/watch.env` (0600) from `.env.example`, run
`sudo /opt/openvibe.host/roles/data/add-service.sh watch`, then
`sudo ovhost deploy watch`.

<!-- versions:start -->
- openvibe-contracts: v0.222.0
- openvibe-sdk: v0.67.0
- openvibe-shared: v4.31.0
<!-- versions:end -->
