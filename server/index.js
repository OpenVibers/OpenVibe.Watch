'use strict';
/**
 * OpenVibe.Watch entry point.
 *
 *   node server/index.js            (systemd: openvibe-watch.service)
 *
 * start() is also what the tests use: it takes a config (server/config.js load()) plus injectable
 * clock/fetch/log/DNS lookup, and returns handles to every part. Nothing starts at module load:
 * the database, the JWKS client, the scheduler and the outbox relay are all started here, and every
 * one of them is stopped by close().
 */
const { load } = require('./config');
const { openDb } = require('./db');
const { createRegistry } = require('./registry');
const { createObservations } = require('./observations');
const { createGuard } = require('./net/guard');
const { createFetcher } = require('./net/fetcher');
const { createSpacer } = require('./spacer');
const { createCarriers } = require('./carriers');
const { extract } = require('./extract');
const condition = require('./condition');   // { evaluate, hasChanged, holds, … }
const { createCheck } = require('./check');
const { createScheduler } = require('./scheduler');
const { createOutbox, createRelay } = require('./events/outbox');
const { jwksClient } = require('openvibe-sdk/auth');
const { gracefulStop } = require('openvibe-sdk/service');
const { createAuth } = require('./auth');
const { createSessions } = require('./sessions');
const { createKeyStore } = require('./auth/keys');
const { createSiteLimits } = require('./http/site-limits');
const { createApp } = require('./app');

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, tokenClient, lookupImpl, log = console, listen = true, limitsNow = null } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const outbox = createOutbox(db, { source: config.serviceId, now });
    const relay = createRelay({
        db, outbox, eventsUrl: config.events.url, intervalMs: config.events.relayIntervalMs, fetchImpl, log, now,
        tokenClient,
        tokenOpts: config.oauth.clientSecret ? { tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret } : null,
    });
    const registry = createRegistry({ db, now, outbox });
    const observations = createObservations({ db, now });
    // The only way out to the internet: SSRF guard (ports, private hosts, every redirect hop), byte
    // cap, one deadline, conditional GET; per-host spacing in front of every request.
    const guard = createGuard({ allowPrivateHosts: config.fetch.allowPrivateHosts, allowedPorts: config.fetch.allowedPorts, ...(lookupImpl ? { lookupImpl } : {}) });
    const fetcher = createFetcher({ guard, userAgent: config.fetch.userAgent, timeoutMs: config.fetch.timeoutMs, maxBytes: config.fetch.maxBytes, maxRedirects: config.fetch.maxRedirects });
    const spacer = createSpacer({ hostMinIntervalMs: config.fetch.hostMinIntervalMs });
    // Every carrier goes out through the spacer, so two watches over one host never hammer it.
    const carriers = createCarriers({ fetcher: spacedFetcher(fetcher, spacer), config, log });
    const check = createCheck({ db, registry, config, carriers, extract, condition, observations, outbox, now, log, relay });
    const scheduler = createScheduler({ db, check, config, now, log });
    const keys = jwksClient(config.jwksUrl, { fetch: fetchImpl, log });
    const auth = createAuth({ config, log });
    // The public site: sessions in Watch's own database, the Network key to verify a sign-in token
    // against (the same shared JWKS client), and the site's write budgets.
    const sessions = createSessions({ db, now });
    const keyStore = createKeyStore({ config, fetchImpl, log });
    const siteLimits = createSiteLimits({ now: limitsNow || (() => Date.now()) });
    const app = createApp({ config, db, registry, check, observations, scheduler, auth, outbox, relay, now, log, limitsNow, sessions, keyStore, siteLimits });
    // One JWKS client for the process (the SDK shares it with verifyUserToken): refresh in the background
    // on an unref'd timer, keeping the last good keys through a Network outage.
    keys.start();
    const keyLoaded = keys.keys().catch(() => null);
    relay.start();
    if (config.worker.enabled) scheduler.start();
    const pruneTimer = setInterval(async () => {
        try { await observations.prune(); } catch (err) { log.error(`[observations] prune: ${err.message}`); }
        try { await sessions.prune(); } catch (err) { log.error(`[sessions] prune: ${err.message}`); }
    }, 3600 * 1000);
    pruneTimer.unref?.();
    const outboxPruneTimer = setInterval(async () => { try { await outbox.prune(); } catch (err) { log.error(`[outbox] prune: ${err.message}`); } }, 6 * 3600 * 1000);
    outboxPruneTimer.unref?.();

    let server = null;
    if (listen) {
        server = await new Promise((resolve, reject) => {
            const s = app.listen(config.port, config.host, () => resolve(s));
            s.on('error', reject);
        });
        log.log(`[watch] listening on http://${config.host}:${server.address().port}`);
    }

    async function close() {
        clearInterval(pruneTimer);
        clearInterval(outboxPruneTimer);
        keys.stop();
        await scheduler.stop();
        await relay.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        if (!givenDb) await db.close();
    }

    return { config, db, registry, observations, guard, fetcher, spacer, carriers, extract, condition, check, scheduler, outbox, relay, keys, keyLoaded, auth, sessions, keyStore, siteLimits, app, server, close };
}

/**
 * The fetcher every carrier uses: one request per host at a time, spaced like any other client to
 * that host — including every redirect hop, which the fetcher hands us before it follows it. A URL
 * the spacer cannot read is not a URL the guard would pass either; the real fetcher refuses it and
 * the carrier records the refusal.
 */
function spacedFetcher(fetcher, spacer) {
    return {
        fetchUrl: async (url, opts = {}) => {
            await spacer.space(new URL(url).host);
            const inner = opts.beforeHop;
            return await fetcher.fetchUrl(url, {
                ...opts,
                beforeHop: async (next) => {
                    await spacer.space(next.host);
                    return inner ? await inner(next) : null;
                },
            });
        },
    };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        // SIGTERM/SIGINT (openvibe-sdk/service, docs/service.md's handles family, Watch 25 s): requests in
        // flight get 15 s, then handles.close() (the prune timers and JWKS refresher stopped, the scheduler,
        // relay and server stopped, the database closed; a rejection exits 1); past 25 s the process exits 1.
        gracefulStop({ name: 'Watch', server: handles.server, handles, drainMs: 15000, deadlineMs: 25000 });
    }).catch((err) => {
        console.error(`[watch] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
