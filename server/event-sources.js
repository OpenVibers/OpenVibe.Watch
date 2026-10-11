'use strict';
/**
 * Event sources (plan T18 step 5): a watch whose source is { kind: 'event', pattern, filter } is checked when a matching
 * OpenVibe.Events event arrives, and never on a cadence: it costs nothing while nothing happens.
 *
 *   Subscriptions  one per distinct pattern of an active event watch, delivered to POST /internal/events (the route the
 *                  account subscriptions use, signed with WATCH_EVENTS_SECRET). sync() creates the missing ones,
 *                  re-enables one a watch needs again and disables the ones no watch needs (Events keeps a subscription;
 *                  it has no delete). It runs at boot, every WATCH_EVENT_SYNC_MS, and shortly after an event watch changes.
 *   Delivery       onEvent(ev), the account-data consumer's hook for every other event type. Events delivers at least
 *                  once, so each event_id is handled once (event_source_receipts). Only `public` events wake a watch:
 *                  anyone may own a watch, and an internal or private event is not theirs to read.
 *   Matching       the pattern matches the event type as Events matches topics (`*` stands for one or more whole
 *                  segments), and every filter key equals the event's value for it: `subject.id`, `subject.type`, or
 *                  a top-level `payload` field.
 *   Budget         at most WATCH_EVENT_MAX_PER_HOUR event checks per watch (default 60); more in the hour are counted
 *                  and dropped, so a busy pattern cannot turn one watch into a write storm.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const ACCOUNT_TOPICS = new Set(['network.account.export_requested', 'network.account.deleted']);
const RECEIPT_DAYS = 7;

/** A topic pattern (`media.*.ready`) as a RegExp over event types: `*` is one or more whole segments. */
function patternRegExp(pattern) {
    const parts = String(pattern || '').split('.').map((seg) => (seg === '*' ? '[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*' : seg.replace(/[^a-z0-9_-]/g, '\\$&')));
    return new RegExp(`^${parts.join('\\.')}$`);
}

/** Does the event carry every filter value? Keys: subject.id, subject.type, or a top-level payload field. */
function filterMatches(filter, ev) {
    if (!filter || typeof filter !== 'object') return true;
    for (const [key, want] of Object.entries(filter)) {
        let have;
        if (key === 'subject.id') have = ev.subject ? ev.subject.id : undefined;
        else if (key === 'subject.type') have = ev.subject ? ev.subject.type : undefined;
        else have = ev.payload && typeof ev.payload === 'object' ? ev.payload[key] : undefined;
        if (have === undefined) return false;
        if (have !== want) return false;
    }
    return true;
}

function createEventSources({ db, check, config, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const es = config.eventSources || {};
    const maxPerHour = Number.isInteger(es.maxPerWatchPerHour) && es.maxPerWatchPerHour > 0 ? es.maxPerWatchPerHour : 60;
    const endpoint = `http://127.0.0.1:${config.port}/internal/events`;
    const secret = (config.events.secrets || [])[0] || '';
    const enabled = !!(config.events.url && secret && config.oauth && config.oauth.clientSecret);
    const counts = new Map();   // watch id → { hour, n }
    let dropped = 0;

    const st = {
        receipt: db.prepare(`INSERT INTO event_source_receipts (event_id, event_type, received_at) VALUES (?, ?, ?)
            ON CONFLICT (event_id) DO NOTHING RETURNING event_id`),
        woke: db.prepare('UPDATE event_source_receipts SET watches = ? WHERE event_id = ?'),
        prune: db.prepare('DELETE FROM event_source_receipts WHERE received_at < ?'),
        watches: db.prepare(`SELECT * FROM watches WHERE status = 'active' AND deleted_at IS NULL AND source->>'kind' = 'event'`),
    };

    function underBudget(id) {
        const hour = Math.floor(now() / 3600_000);
        const c = counts.get(id);
        if (!c || c.hour !== hour) { counts.set(id, { hour, n: 1 }); return true; }
        if (c.n >= maxPerHour) { dropped++; return false; }
        c.n++;
        return true;
    }

    /** The account-data consumer's hook: an event that is not an account event. Returns the outcome Events records. */
    async function onEvent(ev) {
        if (!ev || typeof ev.event_type !== 'string' || typeof ev.event_id !== 'string') return 'ignored:shape';
        if (ACCOUNT_TOPICS.has(ev.event_type)) return 'ignored:type';
        const fresh = await st.receipt.get(ev.event_id, ev.event_type, now());
        if (!fresh) return 'duplicate';
        if (ev.visibility !== 'public') return 'ignored:visibility';
        const rows = await st.watches.all();
        let woke = 0;
        for (const row of rows) {
            const source = typeof row.source === 'string' ? JSON.parse(row.source) : row.source;
            if (!source || source.kind !== 'event') continue;
            if (!patternRegExp(source.pattern).test(ev.event_type) || !filterMatches(source.filter, ev)) continue;
            if (!underBudget(row.id)) continue;
            try {
                const out = await check.run(row.id, { trigger: 'event', input: ev });
                if (out && !out.busy) woke++;
            } catch (err) {
                // One watch failing never costs the others their check (the receipt is already written).
                log.error(`[event-sources] ${row.id} on ${ev.event_type} ${ev.event_id}: ${err.message}`);
            }
        }
        if (woke) await st.woke.run(woke, ev.event_id);
        return woke ? `applied:${woke}` : 'applied:none';
    }

    // ── Subscriptions at OpenVibe.Events ────────────────────────────────────────────────────────────
    const tokens = enabled ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events', scope: 'events.subscription.manage', fetch: fetchImpl,
    }) : null;
    async function call(method, path, body) {
        const res = await fetchImpl(`${config.events.url}${path}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401) tokens.invalidate();
        return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
    }

    /** The patterns active event watches use now. */
    async function wanted() {
        const out = new Set();
        for (const row of await st.watches.all()) {
            const source = typeof row.source === 'string' ? JSON.parse(row.source) : row.source;
            if (source && source.kind === 'event' && source.pattern) out.add(source.pattern);
        }
        return out;
    }

    let syncing = null;
    /** Make Events' subscriptions for this endpoint match the patterns in use. Returns what it did, or null when off. */
    async function sync() {
        if (!enabled) return null;
        if (syncing) return syncing;
        syncing = (async () => {
            const want = await wanted();
            const listed = await call('GET', '/api/v1/subscriptions');
            if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
            const mine = (listed.body.subscriptions || []).filter((s) => s.endpoint === endpoint && !ACCOUNT_TOPICS.has(s.topic_pattern));
            const done = { created: [], enabled: [], disabled: [] };
            for (const pattern of want) {
                const have = mine.find((s) => s.topic_pattern === pattern);
                if (!have) {
                    const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: pattern, endpoint, secret });
                    if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${pattern}: ${r.status} ${r.body.code || ''}`.trim());
                    if (r.ok) done.created.push(pattern);
                } else if (have.enabled === false) {
                    const r = await call('POST', `/api/v1/subscriptions/${encodeURIComponent(have.id)}/enable`);
                    if (r.ok) done.enabled.push(pattern);
                }
            }
            for (const s of mine) {
                if (!want.has(s.topic_pattern) && s.enabled !== false) {
                    const r = await call('POST', `/api/v1/subscriptions/${encodeURIComponent(s.id)}/disable`);
                    if (r.ok) done.disabled.push(s.topic_pattern);
                }
            }
            if (done.created.length || done.enabled.length || done.disabled.length) log.log(`[event-sources] subscriptions: ${JSON.stringify(done)}`);
            return done;
        })().finally(() => { syncing = null; });
        return syncing;
    }

    let soon = null;
    /** A watch with an event source changed: sync in a moment (several changes, one sync). */
    function kick() {
        if (!enabled || soon) return;
        soon = setTimeout(() => { soon = null; sync().catch((err) => log.warn(`[event-sources] sync: ${err.message}`)); }, 2000);
        soon.unref?.();
    }

    let timer = null;
    function start() {
        if (!enabled || timer) return;
        sync().catch((err) => log.warn(`[event-sources] sync: ${err.message}`));
        timer = setInterval(() => sync().catch((err) => log.warn(`[event-sources] sync: ${err.message}`)), es.syncMs || 10 * 60_000);
        timer.unref?.();
    }
    function stop() {
        if (timer) clearInterval(timer);
        if (soon) clearTimeout(soon);
        timer = soon = null;
    }

    async function prune() { await st.prune.run(now() - RECEIPT_DAYS * 86400_000); }

    return { onEvent, sync, kick, start, stop, prune, enabled, stats: () => ({ dropped, maxPerHour }) };
}

module.exports = { createEventSources, patternRegExp, filterMatches, ACCOUNT_TOPICS };
