# Changelog

What shipped on OpenVibe.Watch, newest first. The plan is T18 ("Watch complete"); each entry names
the step it landed.

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
