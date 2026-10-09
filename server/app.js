'use strict';
/**
 * Express app: the public site (pages, sign-in, discovery), the v1 API, health/readiness and metrics.
 *
 *   /, /watches, /watches/:id, /how-it-works, /updates   the pages (http/pages.js)
 *   /auth/*                                              Network SSO with PKCE (auth/sso.js)
 *   /api/v1/*                                            the API (api/watches.js, api/checks.js), loopback-only at the vhost
 *   /api/health, /api/ready, /release.json, /metrics     (loopback only)
 *
 * The site is server-rendered and complete without JavaScript; it acts on the registry in-process as
 * the signed-in person's subject, with exactly the API's ownership rules. The API keeps working
 * unchanged: bearer tokens, one capability per route, problem+json.
 */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const cache = require('openvibe-shared/cache-policy');
const { createWatchReadiness, registerWatchGauges } = require('./observability');
const { createSso } = require('./auth/sso');
const { createPageRoutes } = require('./http/pages');
const { watchesRouter } = require('./api/watches');
const { checksRouter } = require('./api/checks');
const { createActorLimits } = require('./api/actor-limits');
const { assetVersion, send, setRelease, SITE_NAME, TAGLINE } = require('./render/layout');
const { html } = require('./render/html');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** The text index non-HTML clients get for `/`; the site itself is at the same address for browsers. */
const TEXT_INDEX = [
    'OpenVibe.Watch: persistent user-defined observations and conditions over pages, feeds and APIs.',
    'A watch states what it observes (source), how often or what pushes to it (cadence / event pattern),',
    'what value it takes (extraction), how that value is compared and when the condition fires, and what',
    'it wakes. A watch never polls when an event or a webhook will do, and it never fabricates a value:',
    'a check that failed is recorded as failed, and an absent value stays absent.',
    '',
    'Pages (HTML, server-rendered): /, /watches, /how-it-works, /updates. Sign in at /auth/login.',
    'This text index is what a non-browser client gets here.',
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

/** Content-Security-Policy for the site's HTML: the OpenVibe Frame (navbar, footer) is loaded from Network. */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://openvibe.network https://static.cloudflareinsights.com; "
    + "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
    + "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https://openvibe.network https://openvibe.media; "
    + "connect-src 'self' https://openvibe.network https://openvibe.events https://cloudflareinsights.com; "
    + "frame-src 'self' https://openvibe.network; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self' https://openvibe.network";

function createApp({ config, db, registry, check, observations, scheduler, auth, outbox, relay, now, log = console, limitsNow = null, sessions, keyStore, siteLimits, fetchImpl = globalThis.fetch, accountData = null, accountSend = null }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy != null ? config.trustProxy : 'loopback');
    const release = createRelease({ service: 'watch', root: path.join(__dirname, '..') });
    setRelease(release.release);
    // HTTP golden signals by route template, process metrics, release_info and the Watch gauges;
    // GET /metrics answers direct loopback callers only (Track O).
    const metrics = instrument(app, { service: 'watch', release: release.release });
    registerWatchGauges(metrics.registry, { db, watches: registry, check, observations, outbox, now });
    app.use(http.middleware());
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        // The API and sign-in are never cached; a page decides for itself.
        if (req.path.startsWith('/api') || req.path.startsWith('/auth')) res.setHeader('Cache-Control', 'no-store');
        next();
    });
    // ── OpenVibe.Events → Watch (loopback only: nginx answers 404 for /internal/) ──
    // network.account.export_requested and network.account.deleted (ADR-033), answered by openvibe-sdk/account-data's
    // consumer over server/account-data.js. It reads the raw body itself (the v2 signature covers it), so no body
    // parser runs before it; a request that came through a proxy is refused.
    if (accountData) {
        const send = accountSend || (async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Watch cannot answer account events'); });
        app.post('/internal/events', accountData.consumer({ secrets: config.events.secrets || [], send, log }));
    }
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

    // ── Who is signed in (the session cookie; never a Network token) ──
    const sso = createSso({ config, keys: keyStore, sessions, fetchImpl, now: now || (() => Date.now()), log });
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth', sso.routes());

    // ── Static assets (content-hashed ?v= → immutable) ──
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── The API (unchanged: bearer tokens, one capability per route, problem+json) ──
    const limits = createActorLimits({ config, now: limitsNow || (() => Date.now()), registry: metrics.registry, log });
    app.use(watchesRouter({ registry, auth, limits }));
    app.use(checksRouter({ registry, check, observations, auth, limits }));
    app.use('/api', (req, res) => http.sendProblem(res, 404, 'watch.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────────────────────────────────────
    // `/` answers the text index to a client that does not ask for HTML (the service's own index,
    // kept from before the site existed); a browser falls through to the home page below.
    app.get('/', (req, res, next) => {
        if (/\btext\/html\b/.test(String(req.get('accept') || ''))) return next();
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Vary', 'Accept');
        return res.type('text/plain').send(TEXT_INDEX);
    });
    app.use((req, res, next) => {
        // A page is HTML; the CSP is the site's, and every page is complete without script.
        if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) res.setHeader('Content-Security-Policy', CSP);
        next();
    });
    app.use(createPageRoutes({ config, db, registry, check, observations, sessions, siteLimits, log }));

    app.use((req, res) => send(res, 404, {
        viewer: req.viewer, config, path: req.originalUrl, title: 'Not found',
        body: html`<h1>Not found</h1><p>No page here. Try <a href="/">the home page</a> or <a href="/watches">your watches</a>.</p>`,
    }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'watch.bad_json', { detail: 'request body is not valid JSON', ctx: req.ov });
        if (err.type === 'entity.too.large') return http.sendProblem(res, 413, 'watch.too_large', { detail: 'request body too large', ctx: req.ov });
        log.error(`[app] ${req.method} ${req.path}: ${err.stack || err}`);
        if (res.headersSent) return res.end();
        if (req.path.startsWith('/api')) return http.sendProblem(res, 500, 'watch.internal', { detail: 'internal error', ctx: req.ov });
        return res.status(500).type('text/plain').send(`Something went wrong on ${SITE_NAME}. ${TAGLINE}`);
    });

    app.locals.metrics = metrics;
    app.locals.sso = sso;
    return app;
}

module.exports = { createApp, TEXT_INDEX, CSP };
