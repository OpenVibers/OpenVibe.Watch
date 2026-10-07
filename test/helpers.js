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
async function boot({ env = {}, worker = 'off', lookupImpl, tokenClient, now, log = silent, limitsNow = null, allowPrivate = true } = {}) {
    // A stub Network JWKS serving the generated signing key, so the SDK's JWKS client has something real
    // to fetch and verify against (no test touches the internet). Its URL is overridable via env.
    const jwksSite = await site({ '/api/.well-known/jwks': () => ({ body: JSON.stringify({ keys: [publicJwk] }) }) });
    const config = load({
        NODE_ENV: 'test',
        PORT: '0',
        OV_NETWORK_JWKS_URL: `${jwksSite.origin}/api/.well-known/jwks`,
        WATCH_WORKER: worker,
        WATCH_ALLOW_PRIVATE_HOSTS: allowPrivate ? '127.0.0.1' : '',
        WATCH_HOST_MIN_INTERVAL_MS: '0',
        WATCH_FETCH_TIMEOUT_MS: '1500',
        WATCH_TICK_MS: '50',
        ...env,
    });
    // One database per boot (PGlite, or WATCH_TEST_STORE=pg: the containers), dropped when the boot stops.
    const testdb = await require('./db').testDb();
    const h = await start({ config, db: testdb.db, log, lookupImpl, tokenClient, limitsNow, ...(now ? { now } : {}) });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    return { ...h, base, jwksSite, async stop() { await h.close(); await testdb.close(); await jwksSite.close(); } };
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
        cadence: { every_sec: 60, jitter_sec: 0 },
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
