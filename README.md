# OpenVibe.Watch

> Persistent, user-defined observations and conditions over pages, feeds and APIs: define what to
> watch, get told when it changes or fires — cheaply, because a Watch never polls when an event or
> the site's own ETag will do.

**Status:** alpha (plan T18 steps 2–3). The registry, the check engine and the pull carriers exist;
the event, webhook, Node and Run rungs and the actions do not yet.  
**Domain:** `openvibe.watch` (a short "internal service" page and health on this repository's vhost;
the API is loopback-only). Install steps: [Public host](#public-host).  
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
This release carries the pull rungs:

| Kind | Carrier | State |
|---|---|---|
| `http` | one URL, conditional | implemented |
| `feed` | RSS 2.0 / RSS 1.0 (RDF) / Atom 1.0 → `{ items, latest, count }` | implemented |
| `api` | JSON/XML with `items_path` + `fields`, or the body itself | implemented |
| `event` | delivered by OpenVibe.Events | step 5 |
| `webhook` | delivered to `/internal/hooks/…` | step 5 |
| `run` | browser/code polling through OpenVibe.Run | step 6 |
| `node` | a probe through OpenVibe.Node | step 7 |

A kind whose carrier does not exist yet is **accepted by the registry but never fetched**: the
check is recorded `skipped` with `watch.carrier_unavailable` and the reason names the step. That is
what keeps a half-built rung from silently turning into polling.

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
holding, never once per check while nothing moves. **Actions are step 4 of the plan**: a fired
condition records the trigger and emits the event, and nothing else is dispatched yet.

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
| `watch.watch.manage` | `POST /api/v1/watches`, `PATCH /api/v1/watches/:id`, `POST /api/v1/watches/:id/pause`, `POST /api/v1/watches/:id/resume`, `DELETE /api/v1/watches/:id` |
| `watch.observation.read` | `GET /api/v1/watches/:id/observations?before=&limit=`, `GET /api/v1/watches/:id/checks?before=&limit=` |
| `watch.check.run` | `POST /api/v1/watches/:id/check` (404 unknown, 409 `watch.busy` while one runs, 409 `watch.disabled` for a paused watch, 422 `watch.carrier_unavailable`) |

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

A watch owned by a service (`svc:…`) still records every observation and trigger in its own tables,
but the person-facing payloads name a `usr_…`/`agt_…` owner (and a trigger a `usr_…` recipient), so
those two events are logged as not emitted rather than sent with a payload the contract refuses.

## Security

Reporting: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Auth.** Every `/api/v1` route needs a token for audience `openvibe.watch` with that route's ONE
  capability (`svc:…` by capability grant, `usr_…`/`agt_…` by identity), then passes the per-actor
  limits. `X-OV-Subject` is honoured only from a first-party service. The vhost keeps `/api/v1/*`
  loopback-only.
- **Ownership.** Reads and writes are scoped to the acting subject; another owner's watch answers
  404 on every route.
- **Egress.** A watch fetches outside URLs by design, only through the guard:
  [server/net/guard.js](server/net/guard.js), http(s) on `WATCH_ALLOWED_PORTS` (80/443), every
  resolved address public at connect time (no DNS rebinding), each redirect hop re-checked, one
  deadline and a byte cap per response. Exactly one path reaches the network — the carriers, through
  the fetcher — and only for a kind whose carrier exists. `test/carriers.test.js`.
- **Secrets.** A source's credential is the **name** of a `WATCH_CRED_*` variable, read at fetch
  time, sent only to the configured origin, never stored or logged. `OV_OAUTH_CLIENT_SECRET` and the
  credentials live in `/etc/openvibe/watch.env` (0600).
- **Data.** An observation records what the source stated, never a guess; snapshots are capped and
  pruned by retention; a failed check never records an observation.

## Owns

- the watch registry (`watches`, `watch_endpoint_state`) and the `watch.watch@1` /
  `watch.watch-request@1` / `watch.watch-result@1` shapes it serves
- checks: `check_runs`, `observations`, the scheduler, conditional-fetch state, backoff
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
- OpenVibe.Network (signing key; service principal `watch`)
- OpenVibe.Events (outbound events)

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

Not yet demonstrated: a check against a real site from a deployed service (nothing is deployed
yet), the event/webhook carriers (step 5), the Run rung (step 6), Node probes (step 7) and the
actions (step 4) — each answers `watch.carrier_unavailable` and fetches nothing today.

## Public host

`openvibe.watch` is an internal service, like `sources.openvibe.network`: its vhost answers only
`/`, `/api/health`, `/api/ready`, `/release.json` and `/robots.txt`, and keeps `/api/v1/*`
loopback-only (`deploy/nginx/openvibe.watch.conf`). Install: copy the unit and the vhost, write
`/etc/openvibe/watch.env` (0600) from `.env.example`, run
`sudo /opt/openvibe.host/roles/data/add-service.sh watch`, then
`sudo ovhost deploy watch`.

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.35.0
- openvibe-shared: v2.14.1
<!-- versions:end -->
