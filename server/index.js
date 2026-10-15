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
const { createPoster } = require('./net/post');
const { createActorTasks } = require('./actor');
const { createProjects, createRunJobs } = require('./run-jobs');
const { createCodesTasks } = require('./codes-tasks');
const { createMachines } = require('./machines');
const { createFetcher } = require('./net/fetcher');
const { createSpacer } = require('./spacer');
const { createCarriers } = require('./carriers');
const { extract } = require('./extract');
const condition = require('./condition');   // { evaluate, hasChanged, holds, … }
const { createCheck } = require('./check');
const { createWatchBilling } = require('./billing');
const { createScheduler } = require('./scheduler');
const { createEventSources } = require('./event-sources');
const { createWebhookSources } = require('./webhook-sources');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { validate } = require('openvibe-contracts');
const { jwksClient, createServiceTokenClient } = require('openvibe-sdk/auth');
const { createClient } = require('openvibe-sdk/core');
const { createNotificationsClient } = require('openvibe-sdk/notifications');
const { createActions } = require('./actions');
const { gracefulStop } = require('openvibe-sdk/service');
const { createAuth } = require('./auth');
const { createSessions } = require('./sessions');
const { createKeyStore } = require('./auth/keys');
const { createSiteLimits } = require('./http/site-limits');
const { createApp } = require('./app');
const accountDataLib = require('./account-data');
const { createNetworkSender, startSubscriptions } = require('openvibe-sdk/account-data');

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, lookupImpl, log = console, listen = true, limitsNow = null, accountSend: givenSend = null, notifications: givenNotifications = null, post: givenPost = null, actor: givenActor = null, run: givenRun = null, codes: givenCodes = null, projects: givenProjects = null, machines: givenMachines = null, projectSecrets: givenProjectSecrets = null } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const outbox = createServiceOutbox({
        db, source: config.serviceId, eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.relayIntervalMs, fetch: fetchImpl, log, now, table: 'service_outbox',
        eventTypes: ['watch.watch.created', 'watch.watch.updated', 'watch.watch.paused', 'watch.watch.removed',
            'watch.observation.recorded', 'watch.watch.triggered', 'watch.check.failed'],
        validate: (env) => validate('events.event-envelope@1', env),
    });
    // Actions of fired watches (plan T18 step 4): notifications go to the owner through Network with Watch's own
    // client-credentials token; without the client secret they wait (actions.status() says delivery is off).
    // Actor tasks (step 6) and Run jobs (project delegation) use the same client and token provider (a token per audience).
    const client = config.oauth.clientSecret
        ? createClient({
            tokenProvider: createServiceTokenClient({ network: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl }),
            baseUrls: { network: config.networkInternalUrl, actor: config.actions.actorUrl, run: config.actions.runUrl, codes: config.actions.codesUrl, bot: config.actions.botUrl }, fetch: fetchImpl,
        })
        : null;
    // A watch that names a project: Network says whether its owner is an admin or owner of it, when it is saved (Run checks
    // again before every job). Without the client secret no project can be checked, so none can be named.
    const projects = givenProjects || (client ? createProjects(client, { networkUrl: config.networkInternalUrl }) : null);
    const registry = createRegistry({ db, now, outbox, source: config.serviceId, maxWatchesPerOwner: config.watches.maxPerOwner, secretGrants: config.secretGrants, projects });
    const observations = createObservations({ db, now });
    // The only way out to the internet: SSRF guard (ports, private hosts, every redirect hop), byte
    // cap, one deadline, conditional GET; per-host spacing in front of every request.
    const guard = createGuard({ allowPrivateHosts: config.fetch.allowPrivateHosts, allowedPorts: config.fetch.allowedPorts, ...(lookupImpl ? { lookupImpl } : {}) });
    const fetcher = createFetcher({ guard, userAgent: config.fetch.userAgent, timeoutMs: config.fetch.timeoutMs, maxBytes: config.fetch.maxBytes, maxRedirects: config.fetch.maxRedirects });
    const spacer = createSpacer({ hostMinIntervalMs: config.fetch.hostMinIntervalMs });
    // Every carrier goes out through the spacer, so two watches over one host never hammer it.
    // A node source probes from its owner's own machine through OpenVibe.Bot (carriers/node.js).
    const machines = givenMachines || (client ? createMachines(client, { baseUrl: config.actions.botUrl }) : null);
    // Project secrets (ADR-056): a source credential or a webhook signature by secret_ref, through Network.
    const projectSecrets = givenProjectSecrets || (client ? require('./project-secrets').createProjectSecrets(client, { networkUrl: config.networkInternalUrl }) : null);
    const carriers = createCarriers({ fetcher: spacedFetcher(fetcher, spacer), config, log, machines, projectSecrets });
    const notifications = client ? createNotificationsClient(client) : null;
    const actorTasks = client ? createActorTasks(client, { baseUrl: config.actions.actorUrl }) : null;
    // Webhook actions leave through the same guard as every fetch (server/net/post.js).
    const post = givenPost || createPoster({ guard, userAgent: config.fetch.userAgent, timeoutMs: config.actions.webhookTimeoutMs });
    const runJobs = client ? createRunJobs(client, { baseUrl: config.actions.runUrl }) : null;
    const codesTasks = client ? createCodesTasks(client, { baseUrl: config.actions.codesUrl }) : null;
    const actions = createActions({ db, config, notifications: givenNotifications || notifications, post, actor: givenActor || actorTasks, run: givenRun || runJobs, codes: givenCodes || codesTasks, projectSecrets, now, log });
    // Usage readings (plan T5 step 14): a completed check queues one check-operation reading for Billing in its own
    // commit; off unless WATCH_BILLING_INTERVAL_MS is set (server/billing.js).
    const billing = createWatchBilling({ db, config: config.billing, networkUrl: config.networkInternalUrl, clock: { now }, fetchImpl, log });
    const check = createCheck({ db, registry, config, carriers, extract, condition, observations, outbox, actions, billing, now, log });
    const scheduler = createScheduler({ db, check, config, now, log });
    // Event sources (plan T18 step 5): watches woken by OpenVibe.Events events, with their subscriptions kept in step.
    const eventSources = createEventSources({ db, check, config, fetchImpl, log, now });
    registry.onEventSourceChange(() => eventSources.kick());
    const webhookSources = createWebhookSources({ db, registry, check, config, now, log });
    const keys = jwksClient(config.jwksUrl, { fetch: fetchImpl, log });
    const auth = createAuth({ config, log });
    // The public site: sessions in Watch's own database, the Network key to verify a sign-in token
    // against (the same shared JWKS client), and the site's write budgets.
    const sessions = createSessions({ db, now });
    const keyStore = createKeyStore({ config, fetchImpl, log });
    const siteLimits = createSiteLimits({ now: limitsNow || (() => Date.now()) });
    // Account export and deletion (ADR-033): the table map, and the sender to Network's internal routes with Watch's own
    // client-credentials token (a test hands in a stand-in).
    const accountData = accountDataLib.create({ db, log });
    const accountSend = givenSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : null);
    const app = createApp({ config, db, registry, check, observations, scheduler, auth, outbox, actions, now, log, limitsNow, sessions, keyStore, siteLimits, accountData, accountSend, eventSources, webhookSources, billing });
    // One JWKS client for the process (the SDK shares it with verifyUserToken): refresh in the background
    // on an unref'd timer, keeping the last good keys through a Network outage.
    keys.start();
    const keyLoaded = keys.keys().catch(() => null);
    outbox.start();
    if (config.worker.enabled) scheduler.start();
    actions.start();
    if (billing.enabled) billing.start();
    const pruneTimer = setInterval(async () => {
        try { await observations.prune(); } catch (err) { log.error(`[observations] prune: ${err.message}`); }
        try { await eventSources.prune(); } catch (err) { log.error(`[event-sources] prune: ${err.message}`); }
        try { await sessions.prune(); } catch (err) { log.error(`[sessions] prune: ${err.message}`); }
    }, 3600 * 1000);
    pruneTimer.unref?.();
    const outboxPruneTimer = setInterval(async () => { try { await outbox.outbox.prune(); } catch (err) { log.error(`[outbox] prune: ${err.message}`); } }, 6 * 3600 * 1000);
    outboxPruneTimer.unref?.();

    let server = null;
    if (listen) {
        server = await new Promise((resolve, reject) => {
            const s = app.listen(config.port, config.host, () => resolve(s));
            s.on('error', reject);
        });
        log.log(`[watch] listening on http://${config.host}:${server.address().port}`);
    }
    // The two account subscriptions at OpenVibe.Events, created when missing; off without EVENTS_URL,
    // WATCH_EVENTS_SECRET or the client secret.
    const subscriptions = listen ? startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: (config.events.secrets || [])[0],
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl, log,
    }) : null;
    if (listen) eventSources.start();

    async function close() {
        clearInterval(pruneTimer);
        clearInterval(outboxPruneTimer);
        if (subscriptions) subscriptions.stop();
        eventSources.stop();
        keys.stop();
        await scheduler.stop();
        await actions.stop();
        await billing.stop();
        await outbox.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        if (!givenDb) await db.close();
    }

    return { config, db, registry, eventSources, webhookSources, observations, guard, fetcher, spacer, carriers, extract, condition, check, scheduler, outbox, actions, billing, keys, keyLoaded, auth, sessions, keyStore, siteLimits, accountData, app, server, close };
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
