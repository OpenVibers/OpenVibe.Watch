'use strict';
/** Express app: request context, the v1 API, health/readiness, metrics. */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { createWatchReadiness, registerWatchGauges } = require('./observability');
const { watchesRouter } = require('./api/watches');
const { checksRouter } = require('./api/checks');
const { createActorLimits } = require('./api/actor-limits');
const pkg = require('../package.json');

const TEXT_INDEX = [
    'OpenVibe.Watch: persistent user-defined observations and conditions over pages, feeds and APIs.',
    'A watch states what it observes (source), how often or what pushes to it (cadence / event pattern),',
    'what value it takes (extraction), how that value is compared and when the condition fires, and what',
    'it wakes. A watch never polls when an event or a webhook will do, and it never fabricates a value:',
    'a check that failed is recorded as failed, and an absent value stays absent.',
    '',
    'This is an internal service. Its API is for OpenVibe services and their signed-in people on the',
    'production host (bearer tokens); openvibe.watch answers only this page, /api/health, /api/ready and',
    '/release.json.',
    '',
    'GET  /api/v1/watches, /api/v1/watches/:id                                      (watch.watch.read)',
    'POST/PATCH/DELETE /api/v1/watches[/:id], POST /api/v1/watches/:id/pause, /resume (watch.watch.manage)',
    'GET  /api/v1/watches/:id/observations, /api/v1/watches/:id/checks               (watch.observation.read)',
    'POST /api/v1/watches/:id/check                                                 (watch.check.run)',
    'GET  /api/health, /api/ready, /release.json',
    '',
    'Source: https://github.com/OpenVibers/OpenVibe.Watch',
    '',
].join('\n');

const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>OpenVibe.Watch</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #5c5c66; --accent: #2456d6; }
@media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #e8e8ec; --muted: #a0a0ab; --accent: #7aa2ff; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 1.4rem; margin: 0 0 12px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: .9rem; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>OpenVibe.Watch</h1>
<p>This is an internal service of the OpenVibe network, not a website. It keeps the watches people and
agents define — an observation over a page, a feed or an API, with a condition on it — and tells them,
or their Actors and Runners, when it changes or fires.</p>
<p>A watch prefers the cheapest way to know: an event or a webhook when one is delivered, then the
site's own ETag/Last-Modified, then a feed, then an API, and only then an expensive browser check.
A failed check is recorded as a failure; a value the source did not state stays absent.</p>
<p class="muted">Health: <a href="/api/health">/api/health</a> · Readiness: <a href="/api/ready">/api/ready</a> ·
Source code: <a href="https://github.com/OpenVibers/OpenVibe.Watch">OpenVibers/OpenVibe.Watch</a></p>
</main>
</body>
</html>
`;

function createApp({ config, db, registry, check, observations, scheduler, auth, outbox, relay, now, log = console, limitsNow = null }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    const release = createRelease({ service: 'watch', root: path.join(__dirname, '..') });
    // HTTP golden signals by route template, process metrics, release_info and the Watch gauges;
    // GET /metrics answers direct loopback callers only (Track O).
    const metrics = instrument(app, { service: 'watch', release: release.release });
    registerWatchGauges(metrics.registry, { db, watches: registry, check, observations, outbox, now });
    app.use(http.middleware());
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    app.use('/api', express.json({ limit: '256kb', type: ['application/json', 'application/*+json'] }));

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'openvibe-watch', version: pkg.version });
    });

    // Readiness (openvibe-shared/ready): 503 only when the database fails; the Network key and the
    // check worker (running, queue keeping up) are optional and degrade it (see observability.js).
    const readiness = createWatchReadiness({ db, config, registry, check, observations, scheduler, outbox, relay, now, release: release.release });
    app.get('/api/ready', readiness.handler);
    // GET /release.json (ADR-016) and POST /release-metrics (open tabs' update reports into /metrics).
    release.mount(app, { registry: metrics.registry });

    // Per-actor limits (api/actor-limits.js), counted by the principal once a route's capability guard
    // passed. limitsNow: the limiter's clock (tests; default the wall clock, not the check clock).
    const limits = createActorLimits({ config, now: limitsNow || (() => Date.now()), registry: metrics.registry, log });
    app.use(watchesRouter({ registry, auth, limits }));
    app.use(checksRouter({ registry, check, observations, auth, limits }));

    // The public host (openvibe.watch) shows only this page, health, readiness and /release.json:
    // Watch is internal. Browsers get a short honest HTML page, other clients the text route index.
    // Never cached, never indexed.
    app.get('/', (req, res) => {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Vary', 'Accept');
        if (/\btext\/html\b/.test(String(req.get('accept') || ''))) {
            // The page runs no script of its own. Cloudflare Web Analytics: Cloudflare injects its beacon at the
            // edge and the privacy text says it may measure performance; script-src loads it, connect-src is
            // where it reports.
            res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src https://static.cloudflareinsights.com; connect-src https://cloudflareinsights.com; base-uri 'none'; frame-ancestors 'none'");
            return res.type('html').send(HOME_HTML);
        }
        return res.type('text/plain').send(TEXT_INDEX);
    });

    app.use((req, res) => http.sendProblem(res, 404, 'watch.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'watch.bad_json', { detail: 'request body is not valid JSON', ctx: req.ov });
        if (err.type === 'entity.too.large') return http.sendProblem(res, 413, 'watch.too_large', { detail: 'request body too large', ctx: req.ov });
        log.error(`[app] ${req.method} ${req.path}: ${err.stack || err}`);
        if (res.headersSent) return res.end();
        return http.sendProblem(res, 500, 'watch.internal', { detail: 'internal error', ctx: req.ov });
    });

    app.locals.metrics = metrics;
    return app;
}

module.exports = { createApp };
