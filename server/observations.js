'use strict';
/**
 * Observations: what a check recorded for a watch — the extracted value exactly as the source
 * stated it, when it was seen, which check run saw it, whether it changed and whether the watch's
 * condition held. Rows are immutable (watch.observation@1) and carry a capped snapshot of the body
 * the value came from until `retained_until`, which the watch's retention sets.
 *
 * value_hash is SHA-256 over the canonical JSON of the value, so equal values hash equal whatever
 * order their keys came in; previous_hash is the value_hash of the observation before it (null for
 * the first), which is what makes "changed" answerable without reading the earlier row back.
 */
const { validate, ids: contractIds } = require('openvibe-contracts');
const { hashValue } = require('./util');

const DAY_MS = 24 * 3600 * 1000;

function createObservations({ db, now = () => Date.now(), ids = contractIds }) {
    const st = {
        insert: db.prepare(`INSERT INTO observations (id, watch_id, check_run_id, observed_at, value, value_hash, previous_hash,
            changed, condition_met, snapshot, retained_until)
            VALUES (@id, @watch_id, @check_run_id, @observed_at, @value, @value_hash, @previous_hash, @changed, @condition_met, @snapshot, @retained_until)`),
        latest: db.prepare('SELECT * FROM observations WHERE watch_id = ? ORDER BY rid DESC LIMIT 1'),
        before: db.prepare('SELECT * FROM observations WHERE watch_id = ? AND rid < ? ORDER BY rid DESC LIMIT 1'),
        page: db.prepare('SELECT * FROM observations WHERE watch_id = ? AND rid < ? ORDER BY rid DESC LIMIT ?'),
        count: db.prepare('SELECT COUNT(*) AS n FROM observations WHERE watch_id = ?'),
        trail: db.prepare('SELECT observed_at, condition_met FROM observations WHERE watch_id = ? ORDER BY rid DESC LIMIT 200'),
        prune: db.prepare('DELETE FROM observations WHERE retained_until IS NOT NULL AND retained_until <= ?'),
    };

    const bool = (v) => Boolean(Number(v));

    /** observation.v1.json, validated with the released schema. */
    function view(row) {
        const v = {
            id: row.id,
            watch_id: row.watch_id,
            check_run_id: row.check_run_id,
            observed_at: new Date(row.observed_at).toISOString(),
            // jsonb comes back parsed from both adapters (openvibe-sdk/db): the value as stored.
            value: row.value,
            value_hash: row.value_hash,
            previous_hash: row.previous_hash == null ? null : row.previous_hash,
            changed: bool(row.changed),
            condition_met: bool(row.condition_met),
            snapshot: row.snapshot == null ? null : row.snapshot,
        };
        const r = validate('watch.observation@1', v);
        if (!r.valid) throw new Error(`observation view does not match watch.observation@1: ${r.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
        return v;
    }

    /**
     * Build the row an observation will be (reads the previous one for previous_hash; writes
     * nothing). The caller inserts it inside the transaction that also writes the check run and the
     * events, so all three commit together.
     */
    async function build({ watch_id, check_run_id, value, snapshot = null, changed = false, condition_met = false, retentionDays = null, keepSnapshots = true, observed_at = null }) {
        const at = observed_at == null ? now() : observed_at;
        const previous = await st.latest.get(watch_id);
        const v = value === undefined ? null : value;
        return {
            id: `wco_${ids.ulid(at)}`,
            watch_id,
            check_run_id,
            observed_at: at,
            value: JSON.stringify(v),
            value_hash: hashValue(v),
            previous_hash: previous ? previous.value_hash : null,
            changed: changed ? 1 : 0,
            condition_met: condition_met ? 1 : 0,
            snapshot: keepSnapshots && snapshot != null ? snapshot : null,
            retained_until: retentionDays == null ? null : at + retentionDays * DAY_MS,
        };
    }

    /** Insert a built row (inside the caller's transaction). */
    async function insert(row) {
        await st.insert.run(row);
        return row;
    }

    /** build + insert, for a caller that has nothing else to commit with it. */
    async function record(input) {
        return await insert(await build(input));
    }

    async function latest(watch_id) {
        return await st.latest.get(watch_id);
    }

    /** The observation immediately before `row` (the previous_value of a trigger fired on it). */
    async function before(row) {
        return await st.before.get(row.watch_id, row.rid);
    }

    /** Newest first; `before` is the rid of the last row of the previous page. */
    async function list(watch_id, { before = null, limit = 50 } = {}) {
        const b = Number.isSafeInteger(Number(before)) && before != null ? Number(before) : Number.MAX_SAFE_INTEGER;
        return await st.page.all(watch_id, b, limit);
    }

    async function count(watch_id) {
        return (await st.count.get(watch_id)).n;
    }

    /**
     * When the current run of observations whose condition held began (ms), or null when the last
     * observation's condition did not hold (or there is none). This is what `for_sec` measures: a
     * condition that has held continuously for that long is met, not a condition seen once.
     */
    async function heldSince(watch_id) {
        const rows = await st.trail.all(watch_id);
        let since = null;
        for (const r of rows) {
            if (!bool(r.condition_met)) break;
            since = r.observed_at;
        }
        return since;
    }

    /** Drop observations past their retention. Rows a check run still refers to are pruned too. */
    async function prune(at = now()) {
        return (await st.prune.run(at)).changes;
    }

    return { build, insert, record, latest, before, list, count, heldSince, prune, view };
}

module.exports = { createObservations, DAY_MS };
