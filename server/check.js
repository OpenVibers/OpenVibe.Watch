'use strict';
/**
 * The check engine: one execution of one watch (plan T18 step 3).
 *
 *   run(id, { trigger }) —
 *     1  one check of a watch at a time (a second call answers { busy: true })
 *     2  load the watch; a watch that is not active is recorded `disabled` and never fetched
 *     3  choose the carrier (carriers/index.js). event, webhook, node and run sources are accepted
 *        by the registry but have no carrier yet: the check is recorded `skipped` with
 *        watch.carrier_unavailable and NOTHING is fetched (steps 5-7)
 *     4  carrier.run() → the body, its validators and the terminal state; watch_endpoint_state is
 *        updated with what the site said (ETag, Last-Modified, status, body hash)
 *     5  extract → value; record an observation (value, hashes, changed, condition, retention)
 *     6  evaluate the condition; a condition that MET writes check_runs(triggers = 1, state
 *        'condition_met') and emits watch.watch.triggered. Actions are step 4 of the plan and are
 *        NOT dispatched here: a met condition records the trigger and emits the event, nothing else
 *     7  arm next_due_at (+ jitter, or exponential backoff after a failure, capped) and not_before
 *        (Retry-After)
 *
 * The run row, the observation and every event commit in ONE transaction: an event exists exactly
 * when its effect does. Nothing polls a source whose condition is 'changed' twice for the same
 * body: a 304 is `not_modified` and an identical body hash is `no_change`, and neither records an
 * observation.
 */
const { ids: contractIds, validate } = require('openvibe-contracts');
const { nextDue } = require('./registry');
const { ExtractError } = require('./extract');

/** States that count as a failure, back off, and emit watch.check.failed. */
const FAILURE_STATES = new Set(['http_error', 'timeout', 'parse_error', 'rate_limited', 'budget_exceeded', 'skipped', 'disabled']);

/** The owner a watch event can name: observation.recorded takes usr_…/agt_…, triggered usr_… only. */
const PERSON_OWNER = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_OWNER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createCheck({ db, registry, config, carriers, extract, condition, observations, outbox, now = () => Date.now(), log = console, relay = null, ids = contractIds }) {
    const inflight = new Set();

    const st = {
        insertRun: db.prepare(`INSERT INTO check_runs (id, watch_id, trigger, carrier, started_at, finished_at, state, http_status,
            error_code, detail, bytes, raw_body_hash, cost_usd, observations, triggers)
            VALUES (@id, @watch_id, @trigger, @carrier, @started_at, @finished_at, @state, @http_status,
            @error_code, @detail, @bytes, @raw_body_hash, @cost_usd, @observations, @triggers)`),
        endpoint: db.prepare('SELECT * FROM watch_endpoint_state WHERE watch_id = ? AND url = ?'),
        touchEndpoint: db.prepare(`INSERT INTO watch_endpoint_state (watch_id, url, last_status, last_fetch_at) VALUES (@w, @u, @status, @at)
            ON CONFLICT(watch_id, url) DO UPDATE SET last_status = excluded.last_status, last_fetch_at = excluded.last_fetch_at`),
        saveEndpoint: db.prepare(`INSERT INTO watch_endpoint_state (watch_id, url, etag, last_modified, last_status, last_fetch_at, last_body_hash)
            VALUES (@w, @u, @etag, @lm, @status, @at, @hash)
            ON CONFLICT(watch_id, url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
            last_status = excluded.last_status, last_fetch_at = excluded.last_fetch_at, last_body_hash = excluded.last_body_hash`),
        finish: db.prepare(`UPDATE watches SET last_check_at = @at, last_success_at = COALESCE(@success_at, last_success_at),
            last_state = @state, consecutive_failures = @failures, next_due_at = @next_due, not_before = @not_before WHERE id = @id`),
        runs: db.prepare('SELECT * FROM check_runs WHERE watch_id = ? AND rid < ? ORDER BY rid DESC LIMIT ?'),
        run: db.prepare('SELECT * FROM check_runs WHERE id = ?'),
        // The last check that fired the condition: a repeat needs a value that is new or a new run
        // of holding, so a satisfied watch does not fire once per check while nothing moves.
        lastTrigger: db.prepare('SELECT id, started_at FROM check_runs WHERE watch_id = ? AND triggers > 0 ORDER BY rid DESC LIMIT 1'),
    };

    const boolOf = (v) => Boolean(Number(v));

    /** check-run.v1.json, validated with the released schema. */
    function runView(row) {
        const v = {
            id: row.id,
            watch_id: row.watch_id,
            trigger: row.trigger,
            carrier: row.carrier == null ? null : row.carrier,
            started_at: new Date(row.started_at).toISOString(),
            finished_at: new Date(row.finished_at).toISOString(),
            state: row.state,
            http_status: row.http_status == null ? null : Number(row.http_status),
            observations: Number(row.observations),
            triggers: Number(row.triggers),
            cost_usd: Number(row.cost_usd),
            detail: row.detail == null ? null : row.detail,
        };
        const r = validate('watch.check-run@1', v);
        if (!r.valid) throw new Error(`check-run view does not match watch.check-run@1: ${r.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
        return v;
    }

    function baseRun(watch, trigger, carrier, startedAt) {
        return {
            id: `ckr_${ids.ulid(startedAt)}`, watch_id: watch.id, trigger, carrier,
            started_at: startedAt, finished_at: startedAt, state: null, http_status: null, error_code: null,
            detail: null, bytes: null, raw_body_hash: null, cost_usd: 0, observations: 0, triggers: 0,
        };
    }

    // ── Events ───────────────────────────────────────────────────────────────────────────────

    /**
     * The three events OpenVibe.Watch publishes (released payload contracts). They are emitted only
     * when the watch's owner is a subject the payload can name: observation.recorded takes usr_… or
     * agt_…, and a trigger names a usr_… recipient. A watch owned by a service still records every
     * observation and trigger in its own tables; it just has no notification recipient, and the
     * service logs that rather than emitting a payload the contract refuses.
     */
    async function eventsFor({ watch, owner, observation, value, met, firedOn = null, firedAt = null, previousValue, failures, run }) {
        const events = [];
        if (observation) {
            if (PERSON_OWNER.test(owner)) {
                events.push({
                    event_type: 'watch.observation.recorded',
                    subject: { type: 'watch', id: watch.id },
                    visibility: 'internal', priority: 'low',
                    payload: {
                        watch_id: watch.id, owner,
                        observed_at: new Date(observation.observed_at).toISOString(),
                        value,
                        value_hash: observation.value_hash,
                        changed: boolOf(observation.changed),
                        condition_met: boolOf(observation.condition_met),
                    },
                });
            } else {
                log.warn(`[check] ${watch.id}: observation.recorded not emitted: watch.observation.recorded@1 names usr_/agt_ owners, this watch belongs to ${owner}`);
            }
        }
        if (met && firedOn) {
            if (USER_OWNER.test(owner)) {
                events.push({
                    event_type: 'watch.watch.triggered',
                    subject: { type: 'watch', id: watch.id },
                    visibility: 'internal', priority: 'important',
                    payload: {
                        watch_id: watch.id, recipient: owner, project_id: null, name: watch.name,
                        condition: watch.condition,
                        fired_at: new Date(firedAt == null ? firedOn.observed_at : firedAt).toISOString(),
                        observation: {
                            id: firedOn.id,
                            observed_at: new Date(firedOn.observed_at).toISOString(),
                            value,
                            previous_value: previousValue === undefined ? null : previousValue,
                        },
                    },
                });
            } else {
                log.warn(`[check] ${watch.id}: watch.triggered not emitted: watch.watch.triggered@1 names a usr_ recipient, this watch belongs to ${owner}`);
            }
        }
        if (FAILURE_STATES.has(run.state)) {
            events.push({
                event_type: 'watch.check.failed',
                subject: { type: 'watch', id: watch.id },
                visibility: 'internal',
                payload: {
                    watch_id: watch.id, state: run.state, carrier: run.carrier,
                    http_status: run.http_status == null ? null : Number(run.http_status),
                    error_code: run.error_code, consecutive_failures: Math.max(1, failures),
                },
            });
        }
        return events;
    }

    /**
     * One terminal path, in ONE transaction: the observation (when there is one), the check run,
     * the events and the watch's re-armed runtime state all commit together, or none of them do.
     * `failures` is the consecutive failure count (0 when the check succeeded).
     */
    async function settle({ watch, run, failures, successAt = null, notBefore = 0, events = [], observation = null, endpoint = null }) {
        const armed = nextDue(watch, run.finished_at, { failures, maxBackoffMs: config.worker.maxBackoffMs });
        await db.tx(async () => {
            if (observation) await observations.insert(observation);
            await st.insertRun.run(run);
            if (endpoint) await st.saveEndpoint.run(endpoint);
            await st.finish.run({
                id: watch.id, at: run.finished_at, success_at: successAt, state: run.state,
                failures, next_due: armed, not_before: notBefore,
            });
            for (const e of events || []) await outbox.enqueue(e);
        });
        if (relay) relay.flush().catch(() => { });
        return { run, observation, met: run.triggers > 0, failures };
    }

    // ── One check ────────────────────────────────────────────────────────────────────────────

    async function runOnce(row, trigger) {
        const watch = registry.fromRow(row);
        const startedAt = now();
        const carrier = watch.source && watch.source.kind ? watch.source.kind : null;
        const failuresBefore = Number(row.consecutive_failures) || 0;

        const skip = async (state, error_code, detail) => {
            const run = {
                ...baseRun(watch, trigger, carrier, startedAt),
                state, error_code, detail, finished_at: now(),
            };
            const events = await eventsFor({ watch, owner: row.owner_sub, run, failures: failuresBefore + 1 });
            return await settle({ watch, run, failures: failuresBefore + 1, events });
        };

        // A watch that is not active is never fetched, and says so.
        if (row.status !== 'active') {
            return { disabled: true, ...(await skip('disabled', `watch_${row.status}`, `the watch is ${row.status}`)) };
        }

        // An extraction this release cannot run (an AI reading is an action, step 10): never fetch.
        if (watch.extraction && watch.extraction.kind === 'ai') {
            const out = await skip('skipped', 'watch.extraction_unavailable', 'ai extraction is an AI action, not a check (plan T18 step 10). Nothing was fetched.');
            return { unavailable: { code: 'watch.extraction_unavailable' }, ...out };
        }

        const choice = carriers.choose(watch);
        if (choice.unavailable) {
            const out = await skip('skipped', choice.unavailable.code, choice.unavailable.detail);
            return { unavailable: choice.unavailable, ...out };
        }

        const url = watch.source.url || null;
        const state = url ? (await st.endpoint.get(watch.id, url)) || {} : {};
        let out;
        try {
            out = await choice.run({ watch, state, now });
        } catch (err) {
            log.error(`[check] ${watch.id}: carrier ${carrier} crashed: ${err.stack || err}`);
            out = { state: 'http_error', error_code: 'internal', detail: 'the carrier failed unexpectedly' };
        }
        const finishedAt = now();

        // What the site said about this URL. Status and fetch time are always recorded; the
        // validators and the body hash are stored only after a body that was read successfully
        // (OpenVibe.Sources' rule), so a body that failed to parse is fetched and parsed again on
        // the next check instead of being skipped as unchanged forever.
        const endpointFor = (hash) => (url && out.http_status != null ? {
            w: watch.id, u: url, etag: out.etag ?? null, lm: out.last_modified ?? null,
            status: out.http_status, at: finishedAt, hash,
        } : null);
        const endpoint = endpointFor(out.raw_body_hash ?? state.last_body_hash ?? null);
        if (url && out.http_status != null) await st.touchEndpoint.run({ w: watch.id, u: url, status: out.http_status, at: finishedAt });

        // A failed fetch: the run is the record, and nothing was stated.
        if (FAILURE_STATES.has(out.state)) {
            const run = {
                ...baseRun(watch, trigger, carrier, startedAt),
                state: out.state, http_status: out.http_status ?? null, error_code: out.error_code ?? null,
                detail: out.detail ? String(out.detail).slice(0, 500) : null,
                bytes: out.bytes ?? null, raw_body_hash: out.raw_body_hash ?? null, finished_at: finishedAt,
            };
            const failures = failuresBefore + 1;
            const events = await eventsFor({ watch, owner: row.owner_sub, run, failures });
            const result = await settle({ watch, run, failures, events, endpoint, notBefore: out.notBefore || 0 });
            return { ...result, rateLimitedUntil: out.notBefore || null };
        }

        // The value: extracted from the body, or the one we already hold. `not_modified` (304) and
        // `no_change` (an identical body) state nothing new, so no observation is recorded — but the
        // condition is still evaluated against the held value, because a condition that must hold
        // for for_sec becomes met while the page has not changed.
        const stated = out.state === 'ok';
        let value = null;
        let snapshot = null;
        if (stated) {
            try {
                const extracted = extract(watch.extraction, {
                    body: out.body === undefined ? null : out.body,
                    contentType: out.content_type || null,
                    document: out.document,
                    snapshotMax: config.observations.snapshotMax,
                });
                value = extracted.value;
                snapshot = extracted.snapshot;
            } catch (err) {
                const unsupported = err instanceof ExtractError && err.code === 'unsupported';
                const run = {
                    ...baseRun(watch, trigger, carrier, startedAt),
                    state: unsupported ? 'skipped' : 'parse_error',
                    error_code: unsupported ? 'watch.extraction_unavailable' : 'unreadable',
                    detail: String(err.message).slice(0, 500),
                    http_status: out.http_status ?? null, bytes: out.bytes ?? null, raw_body_hash: out.raw_body_hash ?? null,
                    finished_at: finishedAt,
                };
                const failures = failuresBefore + 1;
                const events = await eventsFor({ watch, owner: row.owner_sub, run, failures });
                return await settle({ watch, run, failures, events });
            }
        } else {
            const held = await observations.latest(watch.id);
            if (!held) {
                const run = {
                    ...baseRun(watch, trigger, carrier, startedAt),
                    state: out.state, http_status: out.http_status ?? null, error_code: out.error_code ?? null,
                    detail: out.detail ? String(out.detail).slice(0, 500) : null,
                    bytes: out.bytes ?? null, raw_body_hash: out.raw_body_hash ?? null, finished_at: finishedAt,
                };
                const events = await eventsFor({ watch, owner: row.owner_sub, run, failures: 0 });
                return await settle({ watch, run, failures: 0, successAt: finishedAt, events, endpoint });
            }
            value = held.value;
        }

        const latest = await observations.latest(watch.id);
        const previous = latest ? {
            value: latest.value,   // jsonb is parsed by the db layer
            condition_met: boolOf(latest.condition_met),
            observed_at: latest.observed_at,
        } : null;
        const heldSince = await observations.heldSince(watch.id);
        const verdict = condition.evaluate({ comparison: watch.comparison, condition: watch.condition }, {
            value, previous, heldSince, now: finishedAt,
            changed: stated ? undefined : false,   // a body that did not change states no new value
        });

        // A condition fires when it becomes satisfied and stays satisfied: it fires again only for a
        // value that is new (changed) or for a new run of holding (the trail began after the last
        // firing) — never once per check while nothing moves.
        const lastFired = await st.lastTrigger.get(watch.id);
        const repeat = verdict.met && !verdict.changed && lastFired != null && verdict.since != null && lastFired.started_at >= verdict.since;
        const met = verdict.met && !repeat;

        const retentionDays = watch.retention && Number.isInteger(watch.retention.observations_days)
            ? watch.retention.observations_days
            : config.retention.defaultDays;
        const keepSnapshots = !(watch.retention && watch.retention.keep_snapshots === false);

        const run = {
            ...baseRun(watch, trigger, carrier, startedAt),
            state: met ? 'condition_met' : (stated ? (verdict.changed ? 'changed' : 'ok') : out.state),
            http_status: out.http_status ?? null, bytes: out.bytes ?? null, raw_body_hash: out.raw_body_hash ?? null,
            observations: stated ? 1 : 0, triggers: met ? 1 : 0, finished_at: finishedAt,
        };

        // The observation row is built before the transaction (it needs the previous one's hash),
        // then inserted with the run, the endpoint state and the events in one commit. A check that
        // stated nothing inserts no observation; its trigger (if any) points at the last one.
        let observation = null;
        let firedOn = latest;
        let previousValue = previous ? previous.value : null;
        // WATCH_OBSERVATIONS_MAX_PER_CHECK bounds what one check may write (a mapped feed or API can
        // carry several watched records; a pull check today carries one value).
        if (stated && run.observations < Math.max(1, config.observations.maxPerCheck)) {
            observation = await observations.build({
                watch_id: watch.id, check_run_id: run.id, value, snapshot,
                changed: verdict.changed, condition_met: verdict.holds,
                retentionDays, keepSnapshots, observed_at: finishedAt,
            });
            firedOn = observation;
        } else if (met && latest) {
            const beforeLatest = await observations.before(latest);
            previousValue = beforeLatest ? beforeLatest.value : null;
        }

        const events = await eventsFor({
            watch, owner: row.owner_sub, observation, value, met, run,
            firedOn, firedAt: finishedAt, previousValue, failures: 0,
        });
        const result = await settle({ watch, run, failures: 0, successAt: finishedAt, events, observation, endpoint });
        return {
            ...result, met, value, verdict: { ...verdict, met, repeat },
            observation: observation ? observations.view(observation) : null,
        };
    }

    /**
     * run(id, { trigger, event }) →
     *   null                                  no such watch
     *   { busy: true }                        a check of this watch is already in flight
     *   { disabled: true }                    the watch is paused/disabled/failed; recorded, not fetched
     *   { unavailable: { code, detail } }     the carrier (or extraction) is a later step; nothing fetched
     *   { run, observation, met, value }      the check ran
     */
    async function run(id, { trigger = 'schedule' } = {}) {
        const key = String(id);
        // Claimed before the first await, so two callers racing on one watch cannot both proceed.
        if (inflight.has(key)) return { busy: true };
        inflight.add(key);
        try {
            const row = await registry.get(key);
            if (!row) return null;
            return await runOnce(row, trigger);
        } finally {
            inflight.delete(key);
        }
    }

    /** Newest first; `before` is the rid of the last row of the previous page. */
    async function list(watch_id, { before = null, limit = 50 } = {}) {
        const b = before != null && Number.isSafeInteger(Number(before)) ? Number(before) : Number.MAX_SAFE_INTEGER;
        return await st.runs.all(watch_id, b, limit);
    }

    return { run, list, runView, inflight: () => [...inflight], FAILURE_STATES };
}

module.exports = { createCheck, FAILURE_STATES };
