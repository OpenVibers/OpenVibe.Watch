'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the Watch gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real query on the watch registry: without it nothing is served or checked
 *   network_jwks  optional  the Network signing keys have loaded into the SDK's JWKS client. Without them
 *                           no token can be verified (the API answers 503), but checks keep running, so
 *                           it degrades rather than fails
 *   checker       optional  the check worker is on and running, and its queue keeps up: no active watch
 *                           has waited longer than OVERDUE_MS. Without it watches stop being checked
 *
 * Gauges: watches by health status, the check queue (due, in flight), the time of the last finished
 * check and of the last successful one, observations by state, and the outbox backlog.
 */
const { createReadiness } = require('openvibe-shared/ready');
const { jwksStatus } = require('openvibe-sdk/auth');

const OVERDUE_MS = 15 * 60 * 1000;
const STATUSES = ['healthy', 'failing', 'never_checked', 'waiting', 'paused', 'disabled', 'failed'];
const OBSERVATION_STATES = ['unchanged', 'changed', 'condition_met'];

function readers(db, { startedAt }) {
    // A watch waits from when it became due, when it was last changed (a new or re-enabled watch is
    // due at once, from next_due_at 0) or when this process started, whichever is latest.
    const due = db.prepare(`SELECT COUNT(*) AS n, MIN(GREATEST(next_due_at, not_before, updated_at)) AS oldest FROM watches
        WHERE status = 'active' AND deleted_at IS NULL AND cadence IS NOT NULL AND next_due_at <= @now AND not_before <= @now`);
    const lastCheck = db.prepare('SELECT finished_at FROM check_runs ORDER BY rid DESC LIMIT 1');
    const lastSuccess = db.prepare('SELECT MAX(last_success_at) AS t FROM watches');
    const observations = db.prepare(`SELECT COUNT(*) AS n,
        SUM(CASE WHEN condition_met = 1 THEN 1 ELSE 0 END) AS met,
        SUM(CASE WHEN condition_met = 0 AND changed = 1 THEN 1 ELSE 0 END) AS changed FROM observations`);
    return {
        /** Active watches whose turn has come, and how long the oldest has waited. */
        async queue(t) {
            const r = await due.get({ now: t });
            return { due: r.n, oldest_wait_ms: r.n ? Math.max(0, t - Math.max(r.oldest, startedAt)) : 0 };
        },
        lastCheckAt: async () => { const r = await lastCheck.get(); return r ? r.finished_at : null; },
        lastSuccessAt: async () => (await lastSuccess.get()).t,
        observations: async () => {
            const r = await observations.get();
            const n = Number(r.n) || 0;
            const met = Number(r.met) || 0;
            const changed = Number(r.changed) || 0;
            return { unchanged: n - met - changed, changed, condition_met: met };
        },
    };
}

function createWatchReadiness({ db, config, registry, check, observations, scheduler, outbox, now, release = null }) {
    const read = readers(db, { startedAt: now() });
    const iso = (v) => (v == null ? null : new Date(v).toISOString());
    return createReadiness({
        service: 'watch',
        release,
        checks: [
            // A real round trip that names the store (postgresql / pglite), and the schema present.
            { name: 'db', required: true, check: async () => { const r = await db.ready(); if (!r.ok) return r.error; await db.prepare('SELECT COUNT(*) AS n FROM watches').get(); return { ok: true, detail: r.detail }; } },
            { name: 'network_jwks', required: false, check: () => {
                // The SDK's client for the JWKS this service verifies against (server/index.js started it).
                // Public: counts and times only — never the internal JWKS URL and never the fetch error
                // behind it (both are logged by the SDK client, not answered).
                const st = jwksStatus().find((s) => s.url === config.jwksUrl) || null;
                if (!st) return 'the Network JWKS client has not started: no token can be verified';
                const detail = { keys: st.keys || 0, stale: Boolean(st.stale), failures: st.failures || 0, fetchedAt: iso(st.fetchedAt) };
                if (!st.ready) return { ok: false, error: 'Network signing key not loaded yet: no token can be verified', detail };
                return { ok: true, detail };
            } },
            {
                name: 'checker', required: false,
                check: async () => {
                    const q = await read.queue(now());
                    const detail = {
                        enabled: config.worker.enabled, running: scheduler.running(), in_flight: check.inflight().length,
                        max_concurrent: config.worker.maxConcurrent, due: q.due, oldest_wait_ms: q.oldest_wait_ms,
                        last_check_at: iso(await read.lastCheckAt()),
                    };
                    if (!config.worker.enabled) return { ok: false, error: 'the check worker is off (WATCH_WORKER=off): nothing is checked', detail };
                    if (!scheduler.running()) return { ok: false, error: 'the check worker is not running', detail };
                    if (q.oldest_wait_ms > OVERDUE_MS) return { ok: false, error: `the check queue is behind: ${q.due} watch(es) due, the oldest for ${Math.round(q.oldest_wait_ms / 60000)} min`, detail };
                    return { ok: true, detail };
                },
            },
        ],
        details: async (body) => {
            const dbOk = body.checks.db.status === 'ok';
            let watches = null;
            if (dbOk) {
                watches = {};
                for (const r of await registry.all(null)) {
                    const s = registry.health(r).status;
                    watches[s] = (watches[s] || 0) + 1;
                }
            }
            return {
                watches,
                checks_in_flight: check.inflight().length,
                observations: dbOk ? await read.observations() : null,
                outbox: dbOk ? await outbox.status() : null,
            };
        },
    });
}

/** Watch gauges on the openvibe-shared/metrics registry. */
function registerWatchGauges(registry, { db, watches, check, outbox, now }) {
    const read = readers(db, { startedAt: now() });
    const seconds = (ms) => (ms == null ? null : ms / 1000);
    registry.gauge({
        name: 'watch_watches', help: 'Watches by health status', labelNames: ['status'],
        collect: async () => {
            const n = Object.fromEntries(STATUSES.map((s) => [s, 0]));
            for (const r of await watches.all(null)) { const s = watches.health(r).status; n[s] = (n[s] || 0) + 1; }
            return Object.entries(n).map(([status, value]) => ({ labels: { status }, value }));
        },
    });
    registry.gauge({
        name: 'watch_observations', help: 'Observations held, by state', labelNames: ['state'],
        collect: async () => Object.entries(await read.observations()).map(([state, value]) => ({ labels: { state }, value })),
    });
    registry.gauge({ name: 'watch_checks_due', help: 'Active watches whose next check is due now (the check queue)', collect: async () => (await read.queue(now())).due });
    registry.gauge({ name: 'watch_checks_oldest_wait_seconds', help: 'How long the longest-waiting due watch has waited', collect: async () => (await read.queue(now())).oldest_wait_ms / 1000 });
    registry.gauge({ name: 'watch_checks_in_flight', help: 'Checks in progress', collect: () => check.inflight().length });
    // Left out until there is a check: a timestamp of 0 would read as "1970", not "never".
    registry.gauge({ name: 'watch_last_check_timestamp_seconds', help: 'When the last check finished (any outcome), Unix seconds', collect: async () => seconds(await read.lastCheckAt()) });
    registry.gauge({ name: 'watch_last_success_timestamp_seconds', help: 'When a watch was last checked successfully, Unix seconds', collect: async () => seconds(await read.lastSuccessAt()) });
    registry.gauge({ name: 'watch_outbox_pending', help: 'Events waiting in the outbox', collect: async () => (await outbox.status()).pending });
}


module.exports = { createWatchReadiness, registerWatchGauges, OVERDUE_MS, OBSERVATION_STATES };
