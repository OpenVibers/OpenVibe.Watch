'use strict';
/**
 * Watch's check-operation usage readings → OpenVibe.Billing (plan T5 step 14, Watch slice).
 *
 * Watch emits one platform.usage-sample@1 metric, check-operation:
 *
 *   check-operation   one reading per completed check run (a check_runs row whose state is not a failure, see
 *                     check.js FAILURE_STATES): quantity 1, unit 'check', operation and provider the carrier
 *                     (http/feed/api), subject the watch's owner, project the watch's project_id only when it
 *                     names one, cost_estimate the run's recorded cost_usd (0 when it records none), at the run's
 *                     finish. Idempotency key watch:check:<check run id>, so a retried or replayed run is never
 *                     billed twice. A failed check is not billed.
 *
 * The reporter is the SDK's own (openvibe-sdk/usage createUsageReporter): the check engine queues the reading
 * idempotency-keyed in the outbox inside the transaction that records the run (check.js settle), and the reporter
 * relays it to Billing's billing.usage.record (POST /api/v1/usage) with Watch's Network service token
 * (createServiceTokenClient, clientId 'watch', audience openvibe.billing). A relay that cannot reach Billing (no grant
 * yet, a missing route, a timeout, backpressure, a 401/403/404/408/425/429 or a 5xx) stays pending with backoff; only
 * Billing refusing the reading itself (any other 4xx) is marked rejected and never retried. A reading is never edited
 * (migrations/0008_billing_readings.sql).
 *
 * Off by default: WATCH_BILLING_INTERVAL_MS=0 starts no timer and queues nothing. With an interval but no
 * OV_BILLING_INTERNAL_URL (or OV_OAUTH_CLIENT_SECRET) readings are queued and stay local.
 *
 *   const billing = createWatchBilling({ db, config: config.billing, networkUrl: config.networkInternalUrl });
 *   if (billing.enabled) billing.start();
 */
const { createUsageReporter } = require('openvibe-sdk/usage');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const TABLE = 'billing_readings';
const METRIC = 'check-operation';

/**
 * @param {object} o
 * @param {object} o.db          the Watch database (openvibe-sdk/db)
 * @param {object} o.config      config.billing (server/config.js)
 * @param {string} [o.networkUrl] where Watch's service token comes from (OV_NETWORK_INTERNAL_URL)
 * @param {{ now(): number }} [o.clock]
 * @param {Function} [o.fetchImpl]
 * @param {object} [o.log]
 * @param {object} [o.reporter]  a ready createUsageReporter (tests); default one over `db`/`config`
 */
function createWatchBilling({ db, config, networkUrl, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, reporter: injected } = {}) {
    const intervalMs = Number(config && config.intervalMs) || 0;
    const now = () => clock.now();
    let tokenClient = null;
    if (config && config.url && config.clientSecret) {
        tokenClient = createServiceTokenClient({
            network: networkUrl, clientId: config.clientId, clientSecret: config.clientSecret,
            audience: config.audience, fetch: fetchImpl, timeoutMs: config.timeoutMs, now,
        });
    }
    const reporter = injected || createUsageReporter({
        db, service: 'watch', source: 'watch.check', table: TABLE,
        billingUrl: config && config.url, tokenClient, audience: config && config.audience,
        fetchImpl, timeoutMs: (config && config.timeoutMs) || 5000, now, log,
    });
    let lastError = null;

    /** The reading of one completed check run (`run` as check.js records it, `watch` as the registry reads it). */
    function readingOf({ watch, run }) {
        const cost = Number(run.cost_usd);
        return reporter.sample({
            idempotency_key: reporter.key('check', run.id),
            project: watch.project_id || undefined,
            subject: watch.owner || undefined,
            resource: METRIC, provider: run.carrier, operation: run.carrier,
            quantity: 1, unit: 'check',
            cost_estimate: cost > 0 ? cost : 0,
            at: new Date(Number(run.finished_at)).toISOString(),
        });
    }

    /** INSIDE the caller's transaction: queue the run's reading. -> true when inserted, false when already queued. */
    async function queue(t, { watch, run }) {
        return await reporter.record(t, readingOf({ watch, run }));
    }

    /** One relay pass. Never overlaps itself; never throws. */
    let flushing = null;
    function flush() {
        if (!flushing) flushing = reporter.flush()
            .catch((err) => { lastError = err.message; log.error(`[billing] flush failed: ${err.message}`); return null; })
            .finally(() => { flushing = null; });
        return flushing;
    }

    let timer = null;
    return {
        enabled: intervalMs > 0,
        reporting: !!tokenClient,
        reporter,
        readingOf, queue, flush,
        start() {
            if (timer || !(intervalMs > 0)) return false;
            if (!tokenClient) log.warn('[billing] OV_BILLING_INTERNAL_URL or OV_OAUTH_CLIENT_SECRET is not set: readings are stored and stay queued');
            timer = setInterval(flush, intervalMs);
            if (timer.unref) timer.unref();
            return true;
        },
        async stop() {
            if (timer) clearInterval(timer);
            timer = null;
            if (flushing) await flushing;
            await reporter.stop();
        },
        get running() { return !!timer; },
        async status() {
            return {
                enabled: intervalMs > 0,
                reporting: !!tokenClient,
                pending: await reporter.pending(),
                rejected: await reporter.rejected(),
                last_error: lastError,
            };
        },
    };
}

module.exports = { createWatchBilling, TABLE, METRIC };
