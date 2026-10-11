'use strict';
/**
 * Webhook sources (plan T18 step 5): a watch whose source is { kind: 'webhook' } is woken by a POST to
 * https://openvibe.watch/hooks/<watch id> (its stored endpoint is /internal/hooks/<watch id>, as watch.watch@1 names
 * it), never on a cadence. Any service that can call a webhook (GitHub, a CI, a store, another OpenVibe product) can
 * wake a watch, and the watch's extraction, condition and actions take it from there.
 *
 *   The secret     whk_<43 characters>, made when the watch is created and shown once in that answer, or again by
 *                  POST /api/v1/watches/:id/webhook-secret (which replaces it). It is needed in full to check a
 *                  signature, so it is stored as it is (webhook_secrets), and it goes with its watch.
 *   Signing        X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)> (GitHub's form; many senders use
 *                  it), or Authorization: Bearer <secret> for a sender that cannot sign. Compared in constant time.
 *   Answers        200 { state, triggered } after the check; 404 for an unknown id or a watch that is not a webhook
 *                  watch; 401 for a missing or wrong signature (the same answer either way); 409 for a paused watch;
 *                  429 over the watch's hourly budget (WATCH_WEBHOOK_MAX_PER_HOUR, default 60) with Retry-After;
 *                  503 with Retry-After: 1 while the watch's previous check still runs; 413 over 256 KB.
 */
const crypto = require('crypto');

const SECRET_RE = /^whk_[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 256 * 1024;

const newSecret = () => `whk_${crypto.randomBytes(32).toString('base64url')}`;
const endpointFor = (watchId) => `/internal/hooks/${watchId}`;

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Does the delivery carry the watch's secret: a matching body signature, or the secret as a bearer token? */
function verified(secret, raw, headers) {
    if (!secret) return false;
    const sig = String(headers['x-hub-signature-256'] || '');
    if (sig.startsWith('sha256=')) {
        const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
        if (safeEqual(sig, want)) return true;
    }
    const auth = String(headers.authorization || '');
    if (/^Bearer\s+/i.test(auth) && safeEqual(auth.replace(/^Bearer\s+/i, '').trim(), secret)) return true;
    return false;
}

function createWebhookSources({ db, registry, check, config, now = () => Date.now(), log = console }) {
    const maxPerHour = Number.isInteger(config.webhookSources && config.webhookSources.maxPerWatchPerHour) && config.webhookSources.maxPerWatchPerHour > 0
        ? config.webhookSources.maxPerWatchPerHour : 60;
    const counts = new Map();   // watch id → { hour, n }
    const st = {
        set: db.prepare(`INSERT INTO webhook_secrets (watch_id, secret, created_at) VALUES (?, ?, ?)
            ON CONFLICT (watch_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at`),
        get: db.prepare('SELECT secret FROM webhook_secrets WHERE watch_id = ?'),
        drop: db.prepare('DELETE FROM webhook_secrets WHERE watch_id = ?'),
        watch: db.prepare('SELECT * FROM watches WHERE id = ? AND deleted_at IS NULL'),
    };

    /** The public address and a fresh secret for a webhook watch (replacing any it had). Shown once. */
    async function issue(watchId) {
        const secret = newSecret();
        await st.set.run(watchId, secret, now());
        return { url: `${config.baseUrl}/hooks/${watchId}`, secret, signature: 'X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body with the secret>, or Authorization: Bearer <secret>' };
    }
    async function forget(watchId) { await st.drop.run(watchId); }

    function retryAfter() { return 3600 - Math.floor((now() / 1000) % 3600); }
    function underBudget(id) {
        const hour = Math.floor(now() / 3600_000);
        const c = counts.get(id);
        if (!c || c.hour !== hour) { counts.set(id, { hour, n: 1 }); return true; }
        if (c.n >= maxPerHour) return false;
        c.n++;
        return true;
    }

    const problem = (res, status, code, detail, headers = {}) => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.setHeader('Cache-Control', 'no-store');
        res.status(status).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }));
    };
    // Over the cap: a declared length is refused before reading; an undeclared one stops being kept and is drained, so the
    // sender still gets its 413 instead of a dropped connection.
    const readRaw = (req) => new Promise((resolve, reject) => {
        if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); reject(Object.assign(new Error('too large'), { status: 413 })); return; }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
        req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
        req.on('error', reject);
    });

    /** POST /hooks/:id — the public receiver. */
    async function receive(req, res) {
        const id = String(req.params.id || '');
        let raw;
        try { raw = await readRaw(req); } catch (err) { return problem(res, err.status || 400, err.status === 413 ? 'watch.too_large' : 'watch.bad_request', err.status === 413 ? 'a delivery is at most 256 KB' : 'unreadable body'); }
        const row = /^wch_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? await st.watch.get(id) : null;
        const source = row ? (typeof row.source === 'string' ? JSON.parse(row.source) : row.source) : null;
        if (!row || !source || source.kind !== 'webhook') return problem(res, 404, 'watch.not_found', 'no webhook watch at this address');
        const secret = (await st.get.get(id) || {}).secret || null;
        if (!verified(secret, raw, req.headers)) return problem(res, 401, 'watch.bad_signature', 'the delivery is not signed with this watch\'s secret');
        if (row.status !== 'active') return problem(res, 409, 'watch.disabled', `the watch is ${row.status}`);
        if (!underBudget(id)) return problem(res, 429, 'watch.rate_limited', `at most ${maxPerHour} deliveries an hour wake one watch`, { 'Retry-After': String(retryAfter()) });
        let out;
        try {
            out = await check.run(id, { trigger: 'webhook', input: { body: raw, content_type: req.headers['content-type'] || null } });
        } catch (err) {
            log.error(`[webhook-sources] ${id}: ${err.message}`);
            return problem(res, 500, 'watch.internal', 'the check failed; try again');
        }
        if (out && out.busy) return problem(res, 503, 'watch.busy', 'the watch\'s previous check is still running', { 'Retry-After': '1' });
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ watch_id: id, state: out && out.run ? out.run.state : null, triggered: !!(out && out.met) });
    }

    return { issue, forget, receive, endpointFor, verified, SECRET_RE };
}

module.exports = { createWebhookSources, verified, endpointFor, newSecret };
