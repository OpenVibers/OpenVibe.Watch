'use strict';
/**
 * Watch actions (plan T18 step 4): what a fired condition sets in motion.
 *
 *   const actions = createActions({ db, config, notifications, now, log });
 *   await actions.queue({ watch, run, owner, value, previousValue, observedAt })   inside settle()'s transaction
 *   actions.start(); actions.stop(); await actions.tick(); await actions.status(); await actions.recent(watchId)
 *
 * queue() writes one action_runs row per action of the watch, in the SAME transaction as the check run that fired, so
 * a trigger queues each of its actions exactly once (UNIQUE (check_run_id, action_index)) and never without its run.
 *
 * Delivery, by kind:
 *   notification   the owner gets one OpenVibe notification through Network (openvibe-sdk/notifications, type
 *                  WATCH_TRIGGERED): the watch's name, the value and a link to the watch page. A person who switched
 *                  the category off is Network's decision and counts as sent; an owner Network does not know (a
 *                  deleted account) is `skipped`. A refusal retries after 1, 5 and 30 minutes, 2 and 6 hours, then
 *                  `failed`. Network keeps no idempotency record for a push, so a lost answer can repeat one: at least
 *                  once. A watch owned by an agent or a service has no one to notify: `skipped`.
 *   event          `watch.watch.triggered` is emitted with every firing, in the run's own commit, so that action is
 *                  `sent` as it is queued (it needs a person as owner, as the event does). Any other event type is not
 *                  declared in Watch's manifest: `unavailable`.
 *   webhook, actor-task, codes-run, run-job
 *                  `unavailable` with `watch.action_unavailable`: their dispatchers are later steps of the plan, and
 *                  the watch page says so rather than pretending they ran.
 *
 * The worker claims due rows with a short lease (FOR UPDATE SKIP LOCKED, next_attempt_at moved past the lease), so
 * two processes never deliver one row at the same time, and a process that dies mid-delivery leaves the row to the
 * next tick after the lease. Without the Network OAuth client secret there is no token to push with: rows wait and
 * status() says delivery is off.
 */

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const LEASE_MS = 2 * 60_000;
const TITLE_MAX = 120;
const MESSAGE_MAX = 300;
const LATER = new Set(['webhook', 'actor-task', 'codes-run', 'run-job']);
const TRIGGERED = 'watch.watch.triggered';

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A value as a person reads it in one line. */
function valueText(v) {
    if (v == null) return 'no value';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
}

/** The notification a fired watch sends its owner (network.notification-push-request@1 fields). */
function notificationFor({ config, watch, run, action, value, previousValue, observedAt }) {
    const now = valueText(value);
    const before = previousValue === undefined || previousValue === null ? null : valueText(previousValue);
    return {
        type: 'WATCH_TRIGGERED',
        service: 'watch',
        category: action.category || 'service',
        priority: action.priority || 'normal',
        icon: '👁',
        title: clip(`“${watch.name}” fired`, TITLE_MAX),
        message: clip(before !== null && before !== now ? `${now} (was ${before})` : now, MESSAGE_MAX),
        url: `${config.baseUrl}/watches/${encodeURIComponent(watch.id)}`,
        rich_content: { watch_id: watch.id, check_run_id: run.id, observed_at: observedAt ? new Date(observedAt).toISOString() : null },
    };
}

function createActions({ db, config, notifications = null, now = () => Date.now(), log = console }) {
    const enabled = Boolean(notifications) && config.actions.enabled;
    let timer = null;
    let busy = null;

    const st = {
        insert: db.prepare(`INSERT INTO action_runs (watch_id, check_run_id, action_index, kind, owner_sub, request, state, last_error, created_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (check_run_id, action_index) DO NOTHING`),
        claim: db.prepare(`SELECT rid, watch_id, kind, owner_sub, request, attempts FROM action_runs
            WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, rid LIMIT ? FOR UPDATE SKIP LOCKED`),
        lease: db.prepare('UPDATE action_runs SET attempts = attempts + 1, next_attempt_at = ? WHERE rid = ?'),
        finish: db.prepare('UPDATE action_runs SET state = ?, last_error = ?, finished_at = ? WHERE rid = ?'),
        retry: db.prepare('UPDATE action_runs SET next_attempt_at = ?, last_error = ? WHERE rid = ?'),
        counts: db.prepare(`SELECT COUNT(*) FILTER (WHERE state = 'queued') AS queued, COUNT(*) FILTER (WHERE state = 'failed') AS failed,
            COUNT(*) FILTER (WHERE state = 'sent') AS sent FROM action_runs`),
        recent: db.prepare(`SELECT check_run_id, action_index, kind, state, attempts, last_error, created_at, finished_at FROM action_runs
            WHERE watch_id = ? ORDER BY rid DESC LIMIT ?`),
    };

    /** One row per action of the watch, for the run that fired. Call inside the run's transaction. */
    async function queue({ watch, run, owner, value, previousValue, observedAt }) {
        const list = Array.isArray(watch.action) ? watch.action : [];
        const at = now();
        for (let i = 0; i < list.length; i++) {
            const action = list[i] || {};
            const kind = String(action.kind || '');
            let state = 'queued', error = null, request = {};
            if (kind === 'notification') {
                if (USER_SUBJECT.test(String(owner || ''))) request = notificationFor({ config, watch, run, action, value, previousValue, observedAt });
                else { state = 'skipped'; error = 'watch.action_no_person: the watch belongs to an agent or a service, not a person'; }
            } else if (kind === 'event') {
                if (action.event_type !== TRIGGERED) { state = 'unavailable'; error = `watch.action_unavailable: ${action.event_type || 'an event'} is not an event Watch declares (only ${TRIGGERED})`; }
                else if (!USER_SUBJECT.test(String(owner || ''))) { state = 'skipped'; error = `watch.action_no_person: ${TRIGGERED} names a person, and this watch belongs to an agent or a service`; }
                else { state = 'sent'; error = 'emitted with the check run'; }
            } else if (LATER.has(kind)) {
                state = 'unavailable'; error = `watch.action_unavailable: ${kind} actions are a later step (plan T18)`;
            } else {
                state = 'unavailable'; error = `watch.action_unavailable: unknown action kind ${kind || '(none)'}`;
            }
            await st.insert.run(watch.id, run.id, i, kind || 'unknown', String(owner || ''), JSON.stringify(request), state, error, at, state === 'queued' ? null : at);
        }
    }

    async function deliver(row) {
        const request = typeof row.request === 'string' ? JSON.parse(row.request) : row.request;
        if (row.kind !== 'notification') return { state: 'unavailable', error: `watch.action_unavailable: ${row.kind}` };
        const out = await notifications.push({ subjectId: row.owner_sub, ...request });
        if (out.sent) return { state: 'sent', error: out.skipped ? 'delivered; the person switched this category off' : null };
        return { state: 'skipped', error: 'watch.action_owner_unknown: Network does not know this owner (a deleted account?)' };
    }

    /** One pass: claim due rows under a lease, deliver each, record the outcome. Returns counts. */
    async function tick() {
        if (!enabled) return { enabled: false };
        if (busy) return await busy;
        busy = (async () => {
            const out = { sent: 0, skipped: 0, retried: 0, failed: 0 };
            const at = now();
            const rows = await db.tx(async () => {
                const due = await st.claim.all(at, config.actions.batch);
                for (const r of due) await st.lease.run(at + LEASE_MS, r.rid);
                return due;
            });
            for (const r of rows) {
                const attempt = Number(r.attempts) + 1;
                try {
                    const res = await deliver(r);
                    await st.finish.run(res.state, res.error, now(), r.rid);
                    if (res.state === 'sent') out.sent++; else out.skipped++;
                } catch (err) {
                    const why = String((err && (err.code || err.message)) || err).slice(0, 300);
                    if (attempt >= BACKOFF_MS.length + 1) {
                        await st.finish.run('failed', why, now(), r.rid);
                        out.failed++;
                        log.warn(`[actions] ${r.watch_id}: ${r.kind} gave up after ${attempt} attempts: ${why}`);
                    } else {
                        await st.retry.run(now() + BACKOFF_MS[attempt - 1], why, r.rid);
                        out.retried++;
                    }
                }
            }
            return out;
        })();
        try { return await busy; } finally { busy = null; }
    }

    function start() {
        if (timer || !enabled) return;
        timer = setInterval(() => { tick().catch((err) => log.warn(`[actions] tick: ${err.message}`)); }, config.actions.tickMs);
        timer.unref?.();
    }
    async function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        if (busy) await busy.catch(() => {});
    }

    async function status() {
        const c = await st.counts.get();
        return { enabled, queued: Number(c.queued) || 0, failed: Number(c.failed) || 0, sent: Number(c.sent) || 0 };
    }

    async function recent(watchId, limit = 10) {
        return (await st.recent.all(watchId, limit)).map((r) => ({
            check_run_id: r.check_run_id, kind: r.kind, state: r.state, attempts: Number(r.attempts),
            error: r.last_error || null,
            created_at: new Date(Number(r.created_at)).toISOString(),
            finished_at: r.finished_at == null ? null : new Date(Number(r.finished_at)).toISOString(),
        }));
    }

    return { queue, tick, start, stop, status, recent, enabled };
}

module.exports = { createActions, notificationFor, BACKOFF_MS };
