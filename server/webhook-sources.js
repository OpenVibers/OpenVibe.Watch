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
 *                  it), Authorization: Bearer <secret> for a sender that cannot sign, or Telegram's
 *                  X-Telegram-Bot-Api-Secret-Token (setWebhook's secret_token: the watch's secret is a valid one).
 *                  Compared in constant time.
 *   A sender's own secret (agent plan A3, triggers v1): Slack and Stripe sign with a secret they make, so the person
 *                  pastes it (POST …/webhook-secret { provider, secret }) and that scheme checks the delivery instead:
 *                  slack   X-Slack-Signature: v0=<hex HMAC-SHA256(secret, "v0:" + X-Slack-Request-Timestamp + ":" +
 *                          body)>, the timestamp within 5 minutes; Slack's url_verification is answered with its
 *                          challenge, and a retry (X-Slack-Retry-Num) is acknowledged without a second check.
 *                  stripe  Stripe-Signature: t=<time>,v1=<hex HMAC-SHA256(secret, time + "." + body)> (any v1 of
 *                          several), the time within 5 minutes.
 *                  discord X-Signature-Ed25519 over X-Signature-Timestamp + body, checked with the application's
 *                          public key (64 hex characters, from the Developer Portal; it is public, kept like a
 *                          secret anyway). Discord wants an interaction reply within 3 seconds: a PING gets
 *                          { type: 1 }, anything else { type: 4, ephemeral "Got it" } at once, and the check runs
 *                          right after, with the interaction as its input.
 *   Email in       (A3) POST …/webhook-secret { provider: 'email' } gives the watch an address of its own,
 *                  in-<26 characters>@openvibe.watch (WATCH_MAIL_DOMAIN). Cloudflare Email Routing hands every message
 *                  for the domain to a Worker (edge/mail-worker.js), which posts it to POST /hooks/email signed with
 *                  WATCH_MAIL_INGRESS_SECRET (X-OpenVibe-Mail-Signature: t=<time>,v1=<hex HMAC-SHA256(secret,
 *                  time + "." + body)>, within five minutes). The address finds the watch; the message is read
 *                  (server/mail-parse.js) and the check runs with { from, from_name, to, subject, date, message_id,
 *                  text, text_truncated, attachments } as its JSON input. An unknown address answers 404, and the
 *                  Worker refuses the mail, so the sender gets a bounce. The address is the key: anyone who has it
 *                  can wake the watch, and making a new one retires the old.
 *   Answers        200 { state, triggered } after the check; 404 for an unknown id or a watch that is not a webhook
 *                  watch; 401 for a missing or wrong signature (the same answer either way); 409 for a paused watch;
 *                  429 over the watch's hourly budget (WATCH_WEBHOOK_MAX_PER_HOUR, default 60) with Retry-After;
 *                  503 with Retry-After: 1 while the watch's previous check still runs; 413 over 256 KB.
 */
const crypto = require('crypto');
const { parseMail } = require('./mail-parse');

const SECRET_RE = /^whk_[A-Za-z0-9_-]{43}$/;
const TOLERANCE_SEC = 300;
// A sender's own secret: what it looks like, and how it is described where the person pastes it.
const PROVIDERS = Object.freeze({
    slack: { name: 'Slack', secret: /^[0-9a-f]{32}$/, how: 'Slack signs each request with your app\'s signing secret (X-Slack-Signature, v0).' },
    stripe: { name: 'Stripe', secret: /^whsec_[A-Za-z0-9+/=_-]{16,200}$/, how: 'Stripe signs each event with the endpoint\'s signing secret (Stripe-Signature, v1).' },
    discord: { name: 'Discord', secret: /^[0-9a-f]{64}$/, how: 'Discord signs each interaction with your application\'s key (X-Signature-Ed25519); paste its public key.' },
});
const MAX_BODY = 256 * 1024;
// An email address of a watch's own: its local part is the key (Crockford base32, 26 characters, 130 bits).
const MAIL_LOCAL_RE = /^in-[0-9a-hjkmnp-tv-z]{26}$/;
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const newMailLocal = () => `in-${Array.from(crypto.randomBytes(26), (b) => B32[b & 31]).join('')}`;

const newSecret = () => `whk_${crypto.randomBytes(32).toString('base64url')}`;
const endpointFor = (watchId) => `/internal/hooks/${watchId}`;

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const fresh = (ts, nowMs) => /^\d{1,12}$/.test(String(ts)) && Math.abs(Math.floor(nowMs / 1000) - Number(ts)) <= TOLERANCE_SEC;

/** Slack's request signing: v0 over "v0:<timestamp>:<body>", the timestamp within five minutes. */
function slackVerified(secret, raw, headers, nowMs) {
    const ts = String(headers['x-slack-request-timestamp'] || '');
    const sig = String(headers['x-slack-signature'] || '');
    if (!fresh(ts, nowMs) || !sig.startsWith('v0=')) return false;
    return safeEqual(sig, `v0=${hmac(secret, Buffer.concat([Buffer.from(`v0:${ts}:`), raw]))}`);
}

/** Stripe's webhook signing: v1 over "<t>.<body>" (any of several v1), t within five minutes. */
function stripeVerified(secret, raw, headers, nowMs) {
    const parts = String(headers['stripe-signature'] || '').split(',').map((x) => x.trim().split('='));
    const t = (parts.find(([k]) => k === 't') || [])[1];
    if (!fresh(t, nowMs)) return false;
    const want = hmac(secret, Buffer.concat([Buffer.from(`${t}.`), raw]));
    return parts.filter(([k]) => k === 'v1').some(([, v]) => safeEqual(v || '', want));
}

// The DER prefix of an Ed25519 public key (SubjectPublicKeyInfo), so the 32 raw bytes Discord shows become a key object.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** Discord's interaction signing: Ed25519 over "<timestamp><body>" with the application's public key. */
function discordVerified(publicKeyHex, raw, headers, nowMs) {
    const ts = String(headers['x-signature-timestamp'] || '');
    const sig = String(headers['x-signature-ed25519'] || '');
    if (!fresh(ts, nowMs) || !/^[0-9a-f]{128}$/i.test(sig) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
    try {
        const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
        return crypto.verify(null, Buffer.concat([Buffer.from(ts), raw]), key, Buffer.from(sig, 'hex'));
    } catch { return false; }
}

/**
 * Does the delivery carry the watch's secret? With a sender's own secret (`provider`), only that sender's scheme
 * counts; with Watch's own, a matching body signature, the secret as a bearer token, or Telegram's secret token.
 */
function verified(secret, raw, headers, { provider = null, now = Date.now() } = {}) {
    if (!secret) return false;
    if (provider === 'slack') return slackVerified(secret, raw, headers, now);
    if (provider === 'stripe') return stripeVerified(secret, raw, headers, now);
    if (provider === 'discord') return discordVerified(secret, raw, headers, now);
    if (provider) return false;
    const tg = headers['x-telegram-bot-api-secret-token'];
    if (tg != null && safeEqual(String(tg), secret)) return true;
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
    const mail = {
        domain: String((config.mailIn && config.mailIn.domain) || 'openvibe.watch').toLowerCase(),
        ingressSecret: (config.mailIn && config.mailIn.ingressSecret) || null,
    };
    const st = {
        set: db.prepare(`INSERT INTO webhook_secrets (watch_id, secret, created_at, provider) VALUES (?, ?, ?, ?)
            ON CONFLICT (watch_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, provider = excluded.provider`),
        get: db.prepare('SELECT secret, provider FROM webhook_secrets WHERE watch_id = ?'),
        drop: db.prepare('DELETE FROM webhook_secrets WHERE watch_id = ?'),
        watch: db.prepare('SELECT * FROM watches WHERE id = ? AND deleted_at IS NULL'),
        byMail: db.prepare("SELECT watch_id FROM webhook_secrets WHERE provider = 'email' AND secret = ?"),
    };

    /**
     * The public address and a fresh secret for a webhook watch (replacing any it had), shown once. With a sender's own
     * secret ({ provider: 'slack' | 'stripe', secret }), that secret is kept instead and never echoed back. A bad
     * provider or secret answers { error } and changes nothing.
     */
    async function issue(watchId, { provider = null, secret: theirs = null } = {}) {
        const url = `${config.baseUrl}/hooks/${watchId}`;
        if (provider === 'email') {
            if (!mail.ingressSecret) return { error: 'email in is not set up on this server' };
            const local = newMailLocal();
            await st.set.run(watchId, local, now(), 'email');
            return { url, provider: 'email', address: `${local}@${mail.domain}`, signature: 'Mail sent to this address wakes the watch: the address is the key.' };
        }
        if (provider != null && provider !== '') {
            const p = PROVIDERS[provider];
            if (!p) return { error: `provider is one of ${Object.keys(PROVIDERS).join(', ')}` };
            const value = String(theirs || '').trim();
            if (!p.secret.test(value)) return { error: `that does not look like a ${p.name} signing secret` };
            await st.set.run(watchId, value, now(), provider);
            return { url, provider, signature: p.how };
        }
        const secret = newSecret();
        await st.set.run(watchId, secret, now(), null);
        return { url, secret, signature: 'X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body with the secret>, Authorization: Bearer <secret>, or Telegram\'s X-Telegram-Bot-Api-Secret-Token' };
    }
    async function forget(watchId) { await st.drop.run(watchId); }
    /** The watch's email address, when it has one (shown to its owner on the watch's page). */
    async function addressOf(watchId) {
        const row = await st.get.get(watchId);
        return row && row.provider === 'email' && MAIL_LOCAL_RE.test(row.secret) ? `${row.secret}@${mail.domain}` : null;
    }
    /** Whose secret signs this watch's deliveries: null for Watch's own, else 'slack' or 'stripe'. */
    async function providerOf(watchId) { return ((await st.get.get(watchId)) || {}).provider || null; }

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
        const kept = await st.get.get(id) || {};
        const provider = kept.provider || null;
        if (!verified(kept.secret || null, raw, req.headers, { provider, now: now() })) return problem(res, 401, 'watch.bad_signature', 'the delivery is not signed with this watch\'s secret');
        if (provider === 'slack') {
            // Slack checks a new address with a challenge it wants back, and resends an event it did not see answered
            // within three seconds: the first delivery is the one that runs the check.
            let msg = null;
            try { msg = JSON.parse(raw.toString('utf8')); } catch { /* a form post or not JSON: a delivery like any other */ }
            res.setHeader('Cache-Control', 'no-store');
            if (msg && msg.type === 'url_verification' && typeof msg.challenge === 'string') return res.json({ challenge: msg.challenge.slice(0, 200) });
            if (req.headers['x-slack-retry-num'] != null) return res.json({ watch_id: id, retry: true, state: null, triggered: false });
        }
        if (provider === 'discord') {
            // Discord wants its reply within three seconds and in its own shape, so the reply goes first and the check
            // runs right after, with the interaction as its input.
            let msg = null;
            try { msg = JSON.parse(raw.toString('utf8')); } catch { /* not an interaction */ }
            res.setHeader('Cache-Control', 'no-store');
            if (msg && msg.type === 1) return res.json({ type: 1 });
            if (row.status !== 'active') return res.json({ type: 4, data: { content: `This watch is ${row.status}.`, flags: 64 } });
            if (!underBudget(id)) return res.json({ type: 4, data: { content: 'Too many at once: try again in a while.', flags: 64 } });
            res.json({ type: 4, data: { content: 'Got it: the watch is checking.', flags: 64 } });
            check.run(id, { trigger: 'webhook', input: { body: raw, content_type: 'application/json' } })
                .catch((err) => log.error(`[webhook-sources] ${id}: ${err.message}`));
            return undefined;
        }
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

    /**
     * POST /hooks/email — a message from the mail Worker (edge/mail-worker.js): { to, from, raw (base64), truncated },
     * signed with WATCH_MAIL_INGRESS_SECRET. Answers as /hooks/:id does; 404 makes the Worker refuse the mail.
     */
    async function receiveMail(req, res) {
        let raw;
        try { raw = await readRaw(req); } catch (err) { return problem(res, err.status || 400, err.status === 413 ? 'watch.too_large' : 'watch.bad_request', err.status === 413 ? 'a delivery is at most 256 KB' : 'unreadable body'); }
        if (!mail.ingressSecret) return problem(res, 404, 'watch.not_found', 'email in is not set up on this server');
        if (!mailSigned(mail.ingressSecret, raw, req.headers, now())) return problem(res, 401, 'watch.bad_signature', 'the delivery is not signed by the mail ingress');
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); } catch { return problem(res, 400, 'watch.bad_request', 'the delivery is not JSON'); }
        const to = String((msg && msg.to) || '').trim().toLowerCase();
        const at = to.lastIndexOf('@');
        const local = at > 0 ? to.slice(0, at) : '';
        const found = at > 0 && to.slice(at + 1) === mail.domain && MAIL_LOCAL_RE.test(local) ? await st.byMail.get(local) : null;
        const row = found ? await st.watch.get(found.watch_id) : null;
        const source = row ? (typeof row.source === 'string' ? JSON.parse(row.source) : row.source) : null;
        if (!row || !source || source.kind !== 'webhook') return problem(res, 404, 'watch.not_found', 'no watch has this address');
        if (row.status !== 'active') return problem(res, 409, 'watch.disabled', `the watch is ${row.status}`);
        if (!underBudget(row.id)) return problem(res, 429, 'watch.rate_limited', `at most ${maxPerHour} deliveries an hour wake one watch`, { 'Retry-After': String(retryAfter()) });
        const parsed = parseMail(Buffer.from(String(msg.raw || ''), 'base64'));
        // The envelope is what Email Routing checked; the headers are what the sender wrote.
        const input = { ...parsed, from: String(msg.from || parsed.from || '').slice(0, 320), to, header_from: parsed.from, truncated: !!msg.truncated };
        let out;
        try {
            out = await check.run(row.id, { trigger: 'webhook', input: { body: Buffer.from(JSON.stringify(input)), content_type: 'application/json' } });
        } catch (err) {
            log.error(`[webhook-sources] mail ${row.id}: ${err.message}`);
            return problem(res, 500, 'watch.internal', 'the check failed; try again');
        }
        if (out && out.busy) return problem(res, 503, 'watch.busy', 'the watch\'s previous check is still running', { 'Retry-After': '1' });
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ watch_id: row.id, state: out && out.run ? out.run.state : null, triggered: !!(out && out.met) });
    }

    return { issue, forget, providerOf, addressOf, receive, receiveMail, endpointFor, verified, SECRET_RE, PROVIDERS };
}

/** The mail Worker's signature: X-OpenVibe-Mail-Signature: t=<time>,v1=<hex HMAC-SHA256(secret, time + "." + body)>. */
function mailSigned(secret, raw, headers, nowMs = Date.now()) {
    const parts = String(headers['x-openvibe-mail-signature'] || '').split(',').map((x) => x.trim().split('='));
    const t = (parts.find(([k]) => k === 't') || [])[1];
    if (!secret || !fresh(t, nowMs)) return false;
    const want = hmac(secret, Buffer.concat([Buffer.from(`${t}.`), raw]));
    return parts.filter(([k]) => k === 'v1').some(([, v]) => safeEqual(v || '', want));
}

module.exports = { createWebhookSources, verified, mailSigned, endpointFor, newSecret, newMailLocal, MAIL_LOCAL_RE, PROVIDERS };
