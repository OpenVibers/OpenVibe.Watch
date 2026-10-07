'use strict';
/**
 * The watch registry: validation, CRUD and the view.
 *
 * A Watch is a user-defined persistent observation (plan T18): where it watches (source), how often
 * or what pushes to it (cadence / event pattern), what value it takes from the answer (extraction),
 * how that value is compared with the last observation (comparison), the condition that fires
 * (condition), the actions it wakes (action, executed from step 4), its budget and its retention.
 *
 * Validation is openvibe-contracts' own validator: every request body is checked against
 * watch.watch-request@1 and every answer against watch.watch@1 (never a hand copy of the schema).
 * The rules a schema cannot carry live here: a create needs source, extraction, condition and
 * action; a source that polls (http, feed, api, node, run) needs a cadence with every_sec, and an
 * event or webhook source never polls (cadence null).
 *
 * Ownership is the authority: every read and write is scoped to the acting subject (principal.sub,
 * or the person a first-party service names with X-OV-Subject), and another owner's watch is not
 * found — 404, never 403 (an id must not confirm that someone else's watch exists).
 */
const { validate, ids: contractIds } = require('openvibe-contracts');

/** Source kinds that reach out on a cadence; event and webhook sources are pushed to instead. */
const POLLING = new Set(['http', 'feed', 'api', 'node', 'run']);
const PUSHED = new Set(['event', 'webhook']);
const RUN_STATES = ['ok', 'not_modified', 'no_change', 'changed', 'condition_met', 'http_error', 'timeout', 'parse_error', 'rate_limited', 'budget_exceeded', 'skipped', 'disabled'];
const STATUSES = ['active', 'paused', 'disabled', 'failed'];
/** Headers the fetcher decides; a watch may never override them (SSRF and conditional-GET safety). */
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'user-agent', 'accept-encoding', 'if-none-match', 'if-modified-since']);

class RegistryError extends Error {
    constructor(detail, code = 'watch.invalid') { super(detail); this.code = code; }
}

const parse = (v) => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v));

/** A name a watch can always carry, taken from the source it watches (watch.watch@1 requires one). */
function defaultName(source) {
    if (!source || typeof source !== 'object') return 'watch';
    if (source.url) {
        try {
            const u = new URL(source.url);
            return `${u.host}${u.pathname}`.slice(0, 120);
        } catch { return String(source.url).slice(0, 120); }
    }
    if (source.pattern) return source.pattern.slice(0, 120);
    if (source.endpoint) return `webhook ${source.endpoint}`.slice(0, 120);
    if (source.node_id) return `node ${source.node_id}`.slice(0, 120);
    if (source.runtime) return `run ${source.runtime}`.slice(0, 120);
    return source.kind ? `${source.kind} watch` : 'watch';
}

/**
 * Validate a watch-request body (openvibe-contracts' validator). `create` adds the rules of a new
 * watch. Returns the body unchanged; throws RegistryError (watch.invalid) with a readable detail.
 */
function validateRequest(body, { create = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RegistryError('body must be a watch object');
    const v = validate('watch.watch-request@1', body);
    if (!v.valid) throw new RegistryError(`body does not match watch.watch-request@1: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
    if (create) {
        for (const field of ['source', 'extraction', 'condition', 'action']) {
            if (body[field] === undefined || body[field] === null) throw new RegistryError(`a new watch requires ${field}`);
        }
    }
    const cadence = body.cadence === undefined ? undefined : body.cadence;
    if (body.source && body.source.headers) {
        // A watch may add headers to its own request, but not the ones that decide who is asking or
        // what was asked: the fetcher owns those (OpenVibe.Sources refuses the same set).
        for (const name of Object.keys(body.source.headers)) {
            if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new RegistryError(`source.headers.${name} is set by the fetcher and cannot be overridden`);
        }
    }
    if (body.source) {
        const kind = body.source.kind;
        if (POLLING.has(kind)) {
            if (cadence === null || cadence === undefined) throw new RegistryError(`a ${kind} source needs a cadence (every_sec)`);
            if (!Number.isInteger(cadence.every_sec)) throw new RegistryError('cadence.every_sec is required for a source that polls');
        }
        if (PUSHED.has(kind) && cadence) throw new RegistryError(`a ${kind} source is pushed to and never polls: cadence must be null`);
        // A HEAD source states no body, so only a document/record extraction can read one: refuse
        // the misconfiguration here instead of recording `parse_error` on every check.
        if (body.source.method === 'HEAD' && !['json', 'jsonpath'].includes((body.extraction || {}).kind)) {
            throw new RegistryError('a HEAD source states no body: its extraction must be json or jsonpath (status, etag, last_modified, content_type, content_length)');
        }
    }
    return body;
}

/**
 * When an active, polling watch is next due: every_sec from `at` plus its jitter, or — after
 * failures — an exponential backoff (every_sec · 2^(failures-1), capped at the worker's maximum,
 * the same shape OpenVibe.Sources uses for a failing source). 0 for a source that never polls.
 */
function nextDue(rec, at, { failures = 0, maxBackoffMs = Infinity } = {}) {
    if (!rec || !rec.cadence || !rec.cadence.every_sec) return 0;
    const every = rec.cadence.every_sec * 1000;
    if (failures > 0) return at + Math.min(every * 2 ** Math.min(failures - 1, 10), Math.max(maxBackoffMs, every));
    const jitter = Math.max(0, Number(rec.cadence.jitter_sec) || 0);
    return at + every + (jitter ? Math.floor(Math.random() * jitter * 1000) : 0);
}

/** Validate an answer (openvibe-contracts' validator). A view this service produces must always fit. */
function validateView(view) {
    const v = validate('watch.watch@1', view);
    if (!v.valid) throw new RegistryError(`watch view does not match watch.watch@1: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`, 'watch.internal');
    return view;
}

function createRegistry({ db, now = () => Date.now(), ids = contractIds, outbox = null }) {
    const st = {
        get: db.prepare('SELECT * FROM watches WHERE id = ? AND deleted_at IS NULL'),
        insert: db.prepare(`INSERT INTO watches (id, project_id, owner_sub, name, status, source, cadence, extraction, comparison, condition,
            action, budget, retention, labels, next_due_at, not_before, created_at, updated_at, updated_by)
            VALUES (@id, @project_id, @owner_sub, @name, @status, @source, @cadence, @extraction, @comparison, @condition,
            @action, @budget, @retention, @labels, @next_due_at, 0, @created_at, @updated_at, @updated_by)`),
    };

    /** Every column a patch may write, and nothing else. */
    const COLUMNS = {
        name: (v) => v,
        labels: (v) => JSON.stringify(v || {}),
        status: (v) => v,
        source: (v) => JSON.stringify(v),
        cadence: (v) => (v == null ? null : JSON.stringify(v)),
        extraction: (v) => JSON.stringify(v),
        comparison: (v) => (v == null ? null : JSON.stringify(v)),
        condition: (v) => JSON.stringify(v),
        action: (v) => JSON.stringify(v || []),
        budget: (v) => JSON.stringify(v || {}),
        retention: (v) => JSON.stringify(v || {}),
        project_id: (v) => v,
    };

    /** The stored record, request-shaped (what a PATCH merges into). */
    function fromRow(row) {
        if (!row) return null;
        return {
            id: row.id,
            project_id: row.project_id,
            owner: row.owner_sub,
            name: row.name,
            labels: parse(row.labels) || {},
            status: row.status,
            source: parse(row.source),
            cadence: parse(row.cadence),
            extraction: parse(row.extraction) || {},
            comparison: parse(row.comparison),
            condition: parse(row.condition) || {},
            action: parse(row.action) || [],
            budget: parse(row.budget) || {},
            retention: parse(row.retention) || {},
        };
    }

    /** What the operator sees about a watch's runtime, never invented: counts and times only. */
    function health(row) {
        const iso = (v) => (v == null ? null : new Date(v).toISOString());
        const polls = row.cadence != null;
        let status;
        if (row.status === 'paused') status = 'paused';
        else if (row.status === 'disabled') status = 'disabled';
        else if (row.status === 'failed') status = 'failed';
        else if (!polls) status = 'waiting';
        else if (row.last_check_at == null) status = 'never_checked';
        else if (row.consecutive_failures > 0) status = 'failing';
        else status = 'healthy';
        return {
            status,
            last_check_at: iso(row.last_check_at),
            last_success_at: iso(row.last_success_at),
            last_state: row.last_state,
            consecutive_failures: row.consecutive_failures,
            next_due_at: row.status === 'active' && polls ? iso(Math.max(row.next_due_at, row.not_before)) : null,
            not_before: iso(row.not_before || null),
        };
    }

    /** row → watch.watch@1, validated with the released schema. */
    function view(row) {
        const rec = fromRow(row);
        return validateView({
            id: rec.id,
            project_id: rec.project_id,
            owner: rec.owner,
            name: rec.name,
            labels: rec.labels,
            status: rec.status,
            source: rec.source,
            cadence: rec.cadence,
            extraction: rec.extraction,
            comparison: rec.comparison,
            condition: rec.condition,
            action: rec.action,
            budget: rec.budget,
            retention: rec.retention,
            health: health(row),
            created_at: new Date(row.created_at).toISOString(),
            updated_at: new Date(row.updated_at).toISOString(),
        });
    }

    const ownerOf = (principal) => (principal && (principal.subject || principal.sub)) || null;

    /** The next time an active, polling watch is due: every_sec from now, plus its jitter. */
    function arm(rec, at) {
        return nextDue(rec, at, {});
    }

    /** The row when it exists AND belongs to the acting subject; null otherwise (routes answer 404). */
    async function get(id, principal) {
        const row = await st.get.get(String(id || ''));
        if (!row) return null;
        const owner = ownerOf(principal);
        if (owner && row.owner_sub !== owner) return null;
        return row;
    }

    async function create(body, principal) {
        const req = validateRequest(body, { create: true });
        const owner = ownerOf(principal);
        if (!owner) throw new RegistryError('no acting subject', 'watch.invalid');
        const t = now();
        const rec = {
            name: req.name || defaultName(req.source),
            status: req.status || 'active',
            source: req.source,
            cadence: req.cadence == null ? null : req.cadence,
            extraction: req.extraction,
            comparison: req.comparison == null ? null : req.comparison,
            condition: req.condition,
            action: req.action,
            budget: req.budget || {},
            retention: req.retention || {},
            labels: req.labels || {},
        };
        const row = {
            id: `wch_${ids.ulid(t)}`,
            project_id: null,
            owner_sub: owner,
            name: rec.name,
            status: rec.status,
            source: JSON.stringify(rec.source),
            cadence: rec.cadence ? JSON.stringify(rec.cadence) : null,
            extraction: JSON.stringify(rec.extraction),
            comparison: rec.comparison ? JSON.stringify(rec.comparison) : null,
            condition: JSON.stringify(rec.condition),
            action: JSON.stringify(rec.action),
            budget: JSON.stringify(rec.budget),
            retention: JSON.stringify(rec.retention),
            labels: JSON.stringify(rec.labels),
            // A new active polling watch takes its first reading on the next scheduler tick (as Sources arms a new
            // source), not one cadence later; resume/patch re-arm by cadence below.
            next_due_at: rec.status === 'active' ? t : 0,
            created_at: t,
            updated_at: t,
            updated_by: owner,
        };
        // The row and its event commit together: an event exists exactly when its effect does.
        await db.tx(async () => {
            await st.insert.run(row);
            if (outbox) await outbox.enqueue(watchEvent('watch.watch.created', row, owner, { name: rec.name, status: rec.status }));
        });
        return await st.get.get(row.id);
    }

    /** Only the fields the patch names are written; the merged watch is validated first. */
    async function patch(id, changes, principal) {
        const row = await get(id, principal);
        if (!row) return null;
        if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new RegistryError('body must be a watch object');
        const current = fromRow(row);
        const merged = { ...current, ...changes };
        delete merged.id;      // an id never changes
        delete merged.owner;   // ownership never changes (a watch is the subject's)
        // project_id is not part of watch.watch-request@1: the row's own null is dropped, and a
        // caller that sends one fails the schema check below rather than being silently ignored.
        if (changes.project_id === undefined) delete merged.project_id;
        validateRequest(merged);
        const sets = [];
        const args = { id: row.id, updated_at: now(), updated_by: ownerOf(principal) };
        for (const [k, v] of Object.entries(changes)) {
            if (!COLUMNS[k]) continue;
            sets.push(`${k} = @${k}`);
            args[k] = COLUMNS[k](v);
        }
        if (!sets.length) return await st.get.get(row.id);
        // A changed watch gets a fresh cadence: re-arm from now, so editing never fires late work.
        const rec = { ...current, ...changes };
        args.next_due_at = rec.status === 'active' ? arm(rec, args.updated_at) : 0;
        sets.push('next_due_at = @next_due_at');
        sets.push('updated_at = @updated_at', 'updated_by = @updated_by');
        const type = changes.status === 'paused' ? 'watch.watch.paused' : 'watch.watch.updated';
        const touched = Object.keys(changes).filter((k) => k !== 'labels');
        await db.tx(async () => {
            await db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = @id AND deleted_at IS NULL`).run(args);
            if (outbox && touched.length) {
                await outbox.enqueue(watchEvent(type, row, row.owner_sub, { name: rec.name, status: rec.status, fields: touched.sort() }));
            }
        });
        return await st.get.get(row.id);
    }

    /** Soft delete: the rows an observation refers to stay resolvable. */
    async function remove(id, principal) {
        const row = await get(id, principal);
        if (!row) return null;
        const t = now();
        await db.tx(async () => {
            await db.prepare('UPDATE watches SET deleted_at = ?, updated_at = ?, next_due_at = 0 WHERE id = ?').run(t, t, row.id);
            if (outbox) await outbox.enqueue(watchEvent('watch.watch.removed', row, row.owner_sub, { name: row.name, status: row.status }));
        });
        return { id: row.id, deleted: true };
    }

    /**
     * Watches, newest first, scoped to the acting subject. The keyset is `id`: a wch_ ULID is
     * creation order, so `id < before` is exactly "older than the last row of the previous page",
     * with no ties.
     *
     * A null principal means NO scoping and is the service's own view (the gauges and the readiness
     * detail): every API route passes req.principal, which the capability guard always sets.
     */
    async function all(principal, { status = null, project_id = null, before = null, limit = 50 } = {}) {
        const owner = principal == null ? null : ownerOf(principal);
        const rows = await db.prepare(`SELECT * FROM watches WHERE deleted_at IS NULL
            AND (@owner::text IS NULL OR owner_sub = @owner)
            AND (@status::text IS NULL OR status = @status)
            AND (@project_id::text IS NULL OR project_id = @project_id)
            AND (@before::text IS NULL OR id < @before)
            ORDER BY id DESC LIMIT @limit`).all({ owner, status, project_id, before, limit });
        return rows;
    }

    /** Active watches whose turn has come, oldest due first (the scheduler's queue). */
    async function due(limit) {
        return await db.prepare(`SELECT id FROM watches WHERE status = 'active' AND deleted_at IS NULL AND cadence IS NOT NULL
            AND next_due_at <= @now AND not_before <= @now ORDER BY next_due_at, id LIMIT @limit`).all({ now: now(), limit });
    }

    /** The envelope every watch-lifecycle event shares: the watch's own subject, internal. */
    function watchEvent(event_type, row, owner, payload) {
        return {
            event_type,
            subject: { type: 'watch', id: row.id },
            payload: { watch_id: row.id, owner, ...payload },
            visibility: 'internal',
            priority: 'low',
        };
    }

    return { validate: validateRequest, validateView, view, health, fromRow, create, get, all, patch, remove, due };
}

module.exports = { createRegistry, validateRequest, validateView, RegistryError, defaultName, nextDue, POLLING, PUSHED, RUN_STATES, STATUSES };
