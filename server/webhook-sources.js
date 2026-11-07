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
 *   YouTube        (agent plan A5) POST …/webhook-secret { provider: 'youtube', channel_id: 'UC…' } subscribes the watch to
 *                  the channel through YouTube's WebSub hub (WATCH_YOUTUBE_HUB, pubsubhubbub.appspot.com): the callback is
 *                  the watch's own /hooks/<id>, signed with a new whk_ secret of Watch's (X-Hub-Signature: sha1=<hex
 *                  HMAC>, as the hub sends it). The hub first checks the callback with a GET (hub.mode, hub.topic,
 *                  hub.challenge): only this watch's own topic is echoed. Each notification (an Atom entry for a new or
 *                  changed video, or a deleted one) runs the check with { provider, channel_id, videos: [{ id, channel_id,
 *                  title, url, author, published, updated }], deleted: [{ id, when }] } as its JSON input. A lease runs
 *                  ten days and is renewed two days before it ends (renewLeases, hourly). A bad signature is ignored
 *                  with a 2xx, as WebSub asks, so the hub does not retry it.
 *   Answers        200 { state, triggered } after the check; 404 for an unknown id or a watch that is not a webhook
 *                  watch; 401 for a missing or wrong signature (the same answer either way); 409 for a paused watch;
 *                  429 over the watch's hourly budget (WATCH_WEBHOOK_MAX_PER_HOUR, default 60) with Retry-After;
 *                  503 with Retry-After: 1 while the watch's previous check still runs; 413 over 256 KB.
 */
const crypto = require('crypto');
const { verifySlack, verifyDiscord, verifyTelegram } = require('openvibe-sdk/chat-apps');
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

// YouTube through its WebSub hub (agent plan A5): a channel id, its feed (the hub's topic), and the lease asked for.
const YT_CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const ytTopic = (channelId) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
const YT_LEASE_SEC = 10 * 86400;
const YT_RENEW_BEFORE_MS = 2 * 86400 * 1000;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => (e[0] === '#'
        ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : (XML_ENTITIES[e.toLowerCase()] != null ? XML_ENTITIES[e.toLowerCase()] : m)))
    .trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? unxml(m[1]) : null; };

/**
 * A YouTube WebSub notification (Atom) as the check's input: the videos it names and the ones it says were deleted.
 * Only what the feed says: no title or channel is invented when the feed leaves it out.
 */
function parseYoutubeFeed(xml) {
    const s = String(xml || '');
    const videos = [];
    for (const m of s.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
        const e = m[1];
        const id = tag(e, 'yt:videoId');
        if (!id) continue;
        const link = e.match(/<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/) || e.match(/<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="alternate"/);
        const author = e.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/);
        videos.push({
            id, channel_id: tag(e, 'yt:channelId'), title: tag(e, 'title'),
            url: link ? unxml(link[1]) : `https://www.youtube.com/watch?v=${id}`,
            author: author ? unxml(author[1]) : null, published: tag(e, 'published'), updated: tag(e, 'updated'),
        });
    }
    const deleted = [...s.matchAll(/<at:deleted-entry\b[^>]*>/g)].map((m) => {
        const ref = (m[0].match(/\bref="([^"]*)"/) || [])[1] || '';
        const when = (m[0].match(/\bwhen="([^"]*)"/) || [])[1] || null;
        return { id: unxml(ref).replace(/^yt:video:/, ''), when: when ? unxml(when) : null };
    }).filter((d) => d.id);
    const channel = videos.find((v) => v.channel_id) || null;
    return { provider: 'youtube', channel_id: channel ? channel.channel_id : null, videos, deleted };
}

/** WebSub's signature: X-Hub-Signature: <sha1|sha256|sha384|sha512>=<hex HMAC of the body with the secret>. */
function websubVerified(secret, raw, headers) {
    const m = String(headers['x-hub-signature'] || '').match(/^(sha1|sha256|sha384|sha512)=([0-9a-f]+)$/i);
    if (!m) return false;
    return safeEqual(m[2].toLowerCase(), crypto.createHmac(m[1].toLowerCase(), secret).update(raw).digest('hex'));
}
const endpointFor = (watchId) => `/internal/hooks/${watchId}`;

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const fresh = (ts, nowMs) => /^\d{1,12}$/.test(String(ts)) && Math.abs(Math.floor(nowMs / 1000) - Number(ts)) <= TOLERANCE_SEC;

/** Stripe's webhook signing: v1 over "<t>.<body>" (any of several v1), t within five minutes. */
function stripeVerified(secret, raw, headers, nowMs) {
    const parts = String(headers['stripe-signature'] || '').split(',').map((x) => x.trim().split('='));
    const t = (parts.find(([k]) => k === 't') || [])[1];
    if (!fresh(t, nowMs)) return false;
    const want = hmac(secret, Buffer.concat([Buffer.from(`${t}.`), raw]));
    return parts.filter(([k]) => k === 'v1').some(([, v]) => safeEqual(v || '', want));
}

/**
 * Does the delivery carry the watch's secret? With a sender's own secret (`provider`), only that sender's scheme
 * counts; with Watch's own, a matching body signature, the secret as a bearer token, or Telegram's secret token.
 */
function verified(secret, raw, headers, { provider = null, now = Date.now() } = {}) {
    if (!secret) return false;
    if (provider === 'slack') return verifySlack({ secret, raw, headers, now });
    if (provider === 'stripe') return stripeVerified(secret, raw, headers, now);
    if (provider === 'discord') return verifyDiscord({ publicKey: secret, raw, headers, now });
    if (provider === 'youtube') return websubVerified(secret, raw, headers);
    if (provider) return false;
    if (verifyTelegram({ secret, headers })) return true;
    const sig = String(headers['x-hub-signature-256'] || '');
    if (sig.startsWith('sha256=')) {
        const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
        if (safeEqual(sig, want)) return true;
    }
    const auth = String(headers.authorization || '');
    if (/^Bearer\s+/i.test(auth) && safeEqual(auth.replace(/^Bearer\s+/i, '').trim(), secret)) return true;
    return false;
}

function createWebhookSources({ db, registry, check, config, now = () => Date.now(), log = console, fetchImpl = globalThis.fetch }) {
    const maxPerHour = Number.isInteger(config.webhookSources && config.webhookSources.maxPerWatchPerHour) && config.webhookSources.maxPerWatchPerHour > 0
        ? config.webhookSources.maxPerWatchPerHour : 60;
    const counts = new Map();   // watch id → { hour, n }
    const mail = {
        domain: String((config.mailIn && config.mailIn.domain) || 'openvibe.watch').toLowerCase(),
        ingressSecret: (config.mailIn && config.mailIn.ingressSecret) || null,
    };
    const youtubeHub = String((config.youtube && config.youtube.hub) || 'https://pubsubhubbub.appspot.com/subscribe');
    const st = {
        set: db.prepare(`INSERT INTO webhook_secrets (watch_id, secret, created_at, provider) VALUES (?, ?, ?, ?)
            ON CONFLICT (watch_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, provider = excluded.provider,
            topic = NULL, lease_until = NULL`),
        setYoutube: db.prepare(`INSERT INTO webhook_secrets (watch_id, secret, created_at, provider, topic, lease_until) VALUES (?, ?, ?, 'youtube', ?, NULL)
            ON CONFLICT (watch_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, provider = 'youtube',
            topic = excluded.topic, lease_until = NULL`),
        lease: db.prepare("UPDATE webhook_secrets SET lease_until = ? WHERE watch_id = ? AND provider = 'youtube' AND topic = ?"),
        due: db.prepare("SELECT watch_id, secret, topic FROM webhook_secrets WHERE provider = 'youtube' AND (lease_until IS NULL OR lease_until < ?) ORDER BY watch_id LIMIT 200"),
        get: db.prepare('SELECT secret, provider, topic, lease_until FROM webhook_secrets WHERE watch_id = ?'),
        drop: db.prepare('DELETE FROM webhook_secrets WHERE watch_id = ?'),
        watch: db.prepare('SELECT * FROM watches WHERE id = ? AND deleted_at IS NULL'),
        byMail: db.prepare("SELECT watch_id FROM webhook_secrets WHERE provider = 'email' AND secret = ?"),
    };

    /**
     * The public address and a fresh secret for a webhook watch (replacing any it had), shown once. With a sender's own
     * secret ({ provider: 'slack' | 'stripe', secret }), that secret is kept instead and never echoed back. A bad
     * provider or secret answers { error } and changes nothing.
     */
    /** Ask YouTube's hub to (un)subscribe a watch's callback. True when the hub took the request (it checks it next). */
    async function hub(mode, watchId, secret, topic) {
        const form = new URLSearchParams({ 'hub.callback': `${config.baseUrl}/hooks/${watchId}`, 'hub.topic': topic, 'hub.mode': mode, 'hub.verify': 'async' });
        if (mode === 'subscribe') { form.set('hub.secret', secret); form.set('hub.lease_seconds', String(YT_LEASE_SEC)); }
        try {
            const r = await fetchImpl(youtubeHub, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(15000) });
            if (r.status === 202 || r.status === 204) return true;
            log.warn(`[webhook-sources] youtube ${mode} ${watchId}: the hub answered ${r.status}`);
        } catch (err) { log.warn(`[webhook-sources] youtube ${mode} ${watchId}: ${err.message}`); }
        return false;
    }
    /** A watch leaving YouTube: the hub is told, best effort (a lease left alone ends in ten days anyway). */
    async function leaveYoutube(watchId) {
        const kept = await st.get.get(watchId);
        if (kept && kept.provider === 'youtube' && kept.topic) await hub('unsubscribe', watchId, kept.secret, kept.topic);
    }

    async function issue(watchId, { provider = null, secret: theirs = null, channel_id: channelId = null } = {}) {
        const url = `${config.baseUrl}/hooks/${watchId}`;
        if (provider === 'youtube') {
            const ch = String(channelId || '').trim();
            if (!YT_CHANNEL_RE.test(ch)) return { error: 'a YouTube channel id starts with UC and has 24 characters (youtube.com/channel/UC…)' };
            const before = await st.get.get(watchId);
            if (before && before.provider === 'youtube' && before.topic && before.topic !== ytTopic(ch)) await hub('unsubscribe', watchId, before.secret, before.topic);
            const secret = newSecret();
            await st.setYoutube.run(watchId, secret, now(), ytTopic(ch));
            const asked = await hub('subscribe', watchId, secret, ytTopic(ch));
            return { url, provider: 'youtube', channel_id: ch, subscribed: asked, signature: 'YouTube\'s hub signs each notification with a secret Watch gave it (X-Hub-Signature)' };
        }
        await leaveYoutube(watchId);
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
    async function forget(watchId) { await leaveYoutube(watchId); await st.drop.run(watchId); }
    /** The channel a YouTube watch follows and when its lease ends (shown on the watch's page), or null. */
    async function youtubeOf(watchId) {
        const row = await st.get.get(watchId);
        if (!row || row.provider !== 'youtube' || !row.topic) return null;
        const m = row.topic.match(/channel_id=(UC[A-Za-z0-9_-]{22})$/);
        return { channel_id: m ? m[1] : null, lease_until: row.lease_until == null ? null : Number(row.lease_until) };
    }
    /** Renew every YouTube lease that ends within two days, or that the hub never confirmed (hourly, server/index.js). */
    async function renewLeases() {
        let asked = 0;
        for (const row of await st.due.all(now() + YT_RENEW_BEFORE_MS)) {
            const w = await st.watch.get(row.watch_id);
            if (!w || w.status !== 'active') continue;
            if (await hub('subscribe', row.watch_id, row.secret, row.topic)) asked++;
        }
        return asked;
    }

    /**
     * GET /hooks/:id — the hub's check of a (un)subscription: its challenge is echoed only for the topic this watch
     * follows (subscribe), or one it no longer follows (unsubscribe). A subscribe confirmed sets the lease's end.
     */
    async function verifyIntent(req, res) {
        const id = String(req.params.id || '');
        const q = new URL(req.originalUrl || req.url, 'http://watch.invalid').searchParams;
        const mode = q.get('hub.mode');
        const topic = q.get('hub.topic');
        const challenge = q.get('hub.challenge');
        res.setHeader('Cache-Control', 'no-store');
        const kept = /^wch_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? await st.get.get(id) : null;
        const follows = !!(kept && kept.provider === 'youtube' && kept.topic && kept.topic === topic);
        if (mode === 'denied') { log.warn(`[webhook-sources] youtube ${id}: the hub denied the subscription (${String(q.get('hub.reason') || '').slice(0, 200)})`); return res.status(200).end(); }
        if (!challenge || challenge.length > 512 || !topic) return problem(res, 404, 'watch.not_found', 'no subscription to confirm here');
        if (mode === 'subscribe' && follows) {
            const lease = Number(q.get('hub.lease_seconds'));
            await st.lease.run(now() + (Number.isFinite(lease) && lease > 0 ? Math.min(lease, 30 * 86400) : YT_LEASE_SEC) * 1000, id, topic);
            return res.status(200).type('text/plain').send(challenge);
        }
        if (mode === 'unsubscribe' && !follows) return res.status(200).type('text/plain').send(challenge);
        return problem(res, 404, 'watch.not_found', 'this watch does not follow that topic');
    }
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
        // A routine uses the same stored address so the create stays inside watch.watch@1's source kinds; it is not
        // a page anyone can push to, and a delivery here must not run the person's agent out of turn.
        if (row.schedule) return problem(res, 404, 'watch.not_found', 'this address belongs to a routine, not a webhook watch');
        const kept = await st.get.get(id) || {};
        const provider = kept.provider || null;
        if (!verified(kept.secret || null, raw, req.headers, { provider, now: now() })) {
            // WebSub: a notification whose signature does not match is ignored but acknowledged, so the hub does not resend it.
            if (provider === 'youtube') { log.warn(`[webhook-sources] youtube ${id}: a notification with a bad signature was ignored`); res.setHeader('Cache-Control', 'no-store'); return res.status(202).json({ watch_id: id, ignored: true }); }
            return problem(res, 401, 'watch.bad_signature', 'the delivery is not signed with this watch\'s secret');
        }
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
        // A YouTube notification is Atom: the check reads it as JSON (parseYoutubeFeed).
        const input = provider === 'youtube'
            ? { body: Buffer.from(JSON.stringify(parseYoutubeFeed(raw.toString('utf8')))), content_type: 'application/json' }
            : { body: raw, content_type: req.headers['content-type'] || null };
        let out;
        try {
            out = await check.run(id, { trigger: 'webhook', input });
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

    return { issue, forget, providerOf, addressOf, youtubeOf, renewLeases, verifyIntent, receive, receiveMail, endpointFor, verified, SECRET_RE, PROVIDERS };
}

/** The mail Worker's signature: X-OpenVibe-Mail-Signature: t=<time>,v1=<hex HMAC-SHA256(secret, time + "." + body)>. */
function mailSigned(secret, raw, headers, nowMs = Date.now()) {
    const parts = String(headers['x-openvibe-mail-signature'] || '').split(',').map((x) => x.trim().split('='));
    const t = (parts.find(([k]) => k === 't') || [])[1];
    if (!secret || !fresh(t, nowMs)) return false;
    const want = hmac(secret, Buffer.concat([Buffer.from(`${t}.`), raw]));
    return parts.filter(([k]) => k === 'v1').some(([, v]) => safeEqual(v || '', want));
}

module.exports = { createWebhookSources, verified, mailSigned, endpointFor, newSecret, newMailLocal, MAIL_LOCAL_RE, PROVIDERS, parseYoutubeFeed, websubVerified, YT_CHANNEL_RE };
