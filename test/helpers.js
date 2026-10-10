'use strict';
/**
 * Shared test fixtures: a generated Network signing key, service and user token minting, a booted
 * Watch service on a random port with a temp database, and stub HTTP servers standing in for the
 * pages, feeds and APIs being watched. Nothing here touches the internet.
 */
const crypto = require('crypto');
const nodeHttp = require('http');
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');
const { start } = require('../server/index');
const { startNetwork } = require('./helpers/network');

const ISSUER = 'https://openvibe.network';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const publicJwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });

const silent = { log() {}, warn() {}, error(...a) { if (process.env.DEBUG) console.error(...a); } };

/** A service principal's token (svc:…), the shape OpenVibe.Network signs for client credentials. */
function serviceToken(slug, cap, { aud = 'openvibe.watch', exp = Math.floor(Date.now() / 1000) + 300, key = privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: `svc:${slug}`, actor_type: 'service', aud: [aud], cap, ns: [], iat: now, exp,
        jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
    }, key);
}

/** A signed-in person's (usr_…) or agent's (agt_…) bearer token, for audience openvibe.watch. */
function userToken(sub, { aud = 'openvibe.watch', role = 'member', exp = Math.floor(Date.now() / 1000) + 300, key = privateKey, extra = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub, aud: [aud], iat: now, exp, jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
        role, ...(/^usr_/.test(sub) ? { subject_id: sub } : {}), ...extra,
    }, key);
}

/** A fresh usr_… subject id (a person), for tests that need an owner. */
const newUser = () => require('openvibe-contracts').ids.newId('user');
/** A fresh agt_… subject id (an agent), for tests that need one. */
const newAgent = () => require('openvibe-contracts').ids.newId('agent');

/**
 * Boot Watch; the scheduler is off unless worker: 'on'. Loopback is allowlisted for the stubs unless
 * the caller says otherwise (a test of the SSRF guard boots with allowPrivate: false).
 * log: Watch's logger (default silent); limitsNow: the per-actor limiter's clock (default the wall clock).
 */
async function boot({ env = {}, worker = 'off', lookupImpl, tokenClient, now, log = silent, limitsNow = null, allowPrivate = true, accountSend = null } = {}) {
    // A stub Network JWKS serving the generated signing key, so the SDK's JWKS client has something real
    // to fetch and verify against (no test touches the internet). Its URL is overridable via env.
    const jwksSite = await site({ '/api/.well-known/jwks': () => ({ body: JSON.stringify({ keys: [publicJwk] }) }) });
    // A stand-in Network for the site's sign-in (token endpoint + PKCE), signing with the same key the
    // JWKS above serves. OV_NETWORK_ISSUER keeps the API's expected issuer while OV_NETWORK_URL points
    // the authorize/token endpoints here, so existing service/user tokens still verify unchanged.
    const network = await startNetwork({ privateKey, issuer: ISSUER });
    const config = load({
        NODE_ENV: 'test',
        PORT: '0',
        BASE_URL: 'https://openvibe.watch',
        COOKIE_SECURE: 'false',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: ISSUER,
        OV_NETWORK_JWKS_URL: `${jwksSite.origin}/api/.well-known/jwks`,
        OV_OAUTH_CLIENT_ID: 'watch',
        OV_OAUTH_CLIENT_SECRET: 'watch-secret',
        WATCH_WORKER: worker,
        WATCH_ALLOW_PRIVATE_HOSTS: allowPrivate ? '127.0.0.1' : '',
        WATCH_HOST_MIN_INTERVAL_MS: '0',
        WATCH_FETCH_TIMEOUT_MS: '1500',
        WATCH_TICK_MS: '50',
        ...env,
    });
    // One database per boot (PGlite, or WATCH_TEST_STORE=pg: the containers), dropped when the boot stops.
    const testdb = await require('./db').testDb();
    const h = await start({ config, db: testdb.db, log, lookupImpl, tokenClient, limitsNow, accountSend, ...(now ? { now } : {}) });
    const base = `http://127.0.0.1:${h.server.address().port}`;

    /** A session cookie for a person, as /auth/callback would have set it. */
    async function signIn(user) {
        const token = await h.sessions.create({
            subject: user.subject, username: user.username || null,
            displayName: user.display_name || user.username || null, role: user.role || null,
        });
        return `watch_session=${token}`;
    }

    /**
     * The whole browser sign-in, over HTTP: /auth/login → Network /oauth/authorize → /auth/callback,
     * with the stand-in Network issuing the code against the PKCE challenge the site generated.
     */
    async function login(user, { next = '/watches' } = {}) {
        const start = await get(`/auth/login?next=${encodeURIComponent(next)}`);
        const loc = new URL(start.headers.get('location'));
        const flow = (start.headers.getSetCookie ? start.headers.getSetCookie() : [start.headers.get('set-cookie')])
            .map((c) => c && c.split(';')[0]).find((c) => c && c.startsWith('watch_oauth='));
        const code = network.issueCode(user, loc.searchParams.get('code_challenge'));
        const cb = await get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flow });
        const cookies = cb.headers.getSetCookie ? cb.headers.getSetCookie() : [cb.headers.get('set-cookie')];
        const session = cookies.map((c) => c && c.split(';')[0]).find((c) => c && c.startsWith('watch_session='));
        return { status: cb.status, location: cb.headers.get('location'), cookie: session, start };
    }

    /** The HTTP client every site test uses: a page or a form, as a person (or nobody). */
    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as) {
            const c = await signIn(o.as);
            headers.cookie = headers.cookie ? `${c}; ${headers.cookie}` : c;
        }
        if (o.cookie) headers.cookie = o.cookie;
        if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams({ ...o.form }).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const method = o.method || (body !== undefined ? 'POST' : 'GET');
        // A form write comes from this site unless the test says otherwise (the cross-site case).
        if (method !== 'GET' && method !== 'HEAD' && !headers.origin && !headers.Origin) headers.origin = o.origin || base;
        if (o.origin) headers.origin = o.origin;
        const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        return { status: res.status, headers: res.headers, location: res.headers.get('location'), text, buffer: buf, json() { return JSON.parse(text); } };
    }

    return { ...h, base, jwksSite, network, signIn, login, get, async stop() { await h.close(); await testdb.close(); await jwksSite.close(); await network.close(); } };
}

async function request(base, method, p, { token, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
}

/**
 * A stub website. routes: { '/path': (req, res, ctx) => void | { status, headers, body, delayMs } }.
 * Every request is recorded with its method, headers and arrival time.
 */
async function site(routes = {}) {
    const requests = [];
    const server = nodeHttp.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://stub');
        requests.push({ path: url.pathname, search: url.search, method: req.method, headers: req.headers, at: Date.now() });
        const handler = routes[url.pathname] || routes['*'];
        if (!handler) { res.statusCode = 404; res.end('not found'); return; }
        const out = await handler(req, res, { url, count: requests.filter(r => r.path === url.pathname).length });
        if (!out || res.writableEnded) return;
        if (out.delayMs) await new Promise(r => setTimeout(r, out.delayMs));
        if (res.destroyed) return;
        res.writeHead(out.status || 200, out.headers || {});
        res.end(out.body === undefined ? '' : out.body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        origin,
        requests,
        hits: (p) => requests.filter(r => r.path === p),
        routes,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
}

/** A valid http watch body pointing at a stub (every field the released contract requires). */
function watchDef(overrides = {}) {
    return {
        name: 'Stub watch',
        source: { kind: 'http', url: 'https://example.org/page', format: null },
        cadence: { every_sec: 900, jitter_sec: 0 },
        extraction: { kind: 'text' },
        condition: { op: 'changed' },
        action: [{ kind: 'notification', category: 'service', priority: 'normal' }],
        ...overrides,
    };
}

function rss(items) {
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Stub</title>${items.map(i =>
        `<item><title>${i.title}</title><link>${i.link}</link><guid isPermaLink="false">${i.guid}</guid>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}<description>${i.description || ''}</description></item>`).join('')}</channel></rss>`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function suite(name) {
    const tests = [];
    const t = (n, fn) => tests.push([n, fn]);
    t.run = async () => {
        let failed = 0;
        for (const [n, fn] of tests) {
            try { await fn(); console.log(`  ok   ${n}`); } catch (err) { failed++; console.log(`  FAIL ${n}\n${err.stack}`); }
        }
        console.log(`${name}: ${tests.length - failed}/${tests.length} passed`);
        if (failed) process.exit(1);
    };
    return t;
}

module.exports = {
    ISSUER, privateKey, publicKey, silent, serviceToken, userToken, newUser, newAgent, boot, request, site,
    watchDef, rss, sleep, suite,
};
