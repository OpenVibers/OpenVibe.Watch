'use strict';
/**
 * Sign in with OpenVibe.Network: OAuth 2 authorization code with PKCE (S256), as OAuth client `watch`.
 *
 *   GET  /auth/login      → Network /oauth/authorize?…&code_challenge_method=S256   (?next= a same-site path)
 *   GET  /auth/callback   → state check, server-side code exchange (client secret + code_verifier),
 *                           the token verified for openvibe.network, then a session row in Watch's
 *                           own database and an httpOnly cookie naming it
 *   GET  /auth/logout     → clear the cookie, revoke the session row
 *   GET  /auth/me         → { user } for the shared navbar (it cannot read the httpOnly cookie); { user: null } for a guest
 *
 * The browser never holds a Network token. The cookie carries an opaque random session token; the
 * database stores only its hash (server/sessions.js). The Network access token is verified once, at
 * the callback, and discarded: the site acts on the watch registry in-process as the person's
 * canonical subject (usr_…), never as the person over Network's API.
 *
 * The OAuth half is openvibe-sdk/sso's: the authorize URL, the code exchange and GET /auth/health
 * are the SDK's (createSsoClient), not a hand copy. The site keeps its database session, because the
 * browser must never hold a Network token. A lost or expired flow starts the sign-in once more by
 * itself (a two-minute ov_oauth_retry cookie, never a loop); when it cannot, the visitor gets a page
 * with "Try again" instead of a bare line of text.
 */
const crypto = require('crypto');
const express = require('express');
const { createSsoClient, failurePage } = require('openvibe-sdk/sso');
const cache = require('openvibe-shared/cache-policy');

const SESSION_COOKIE = 'watch_session';
const FLOW_COOKIE = 'watch_oauth';
const HINT_COOKIE = 'ov_sso_hint';
const RETRY_COOKIE = 'ov_oauth_retry';
const FLOW_TTL_MS = 10 * 60 * 1000;
const RETRY_TTL_MS = 2 * 60 * 1000;

/** This site's own origin (BASE_URL). */
function ownOrigins(config) {
    const out = new Set();
    try { if (config && config.baseUrl) out.add(new URL(config.baseUrl).origin); } catch { /* not a URL */ }
    return out;
}

/**
 * Same-site relative paths only (never protocol-relative, never another origin). An absolute URL on this site's own
 * origin counts as its path: the shared navbar's silent sign-in sends the whole page address, and until 2026-10-22
 * that landed on the home page.
 */
function sanitizeNext(next, config) {
    // Browsers drop tab/newline and read a backslash as "/": "/<TAB>/evil.com" would leave the site.
    if (typeof next === 'string' && /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
    if (typeof next === 'string' && /^https?:\/\//i.test(next)) {
        let u = null;
        try { u = new URL(next); } catch { return '/'; }
        if (!ownOrigins(config).has(u.origin)) return '/';
        next = `${u.pathname}${u.search}${u.hash}`;
    }
    if (typeof next !== 'string' || !/^\/(?!\/|\\)/.test(next) || next.length > 500) return '/';
    return next;
}

/** Parse a Cookie header into a plain object (express gives no parser and this is all we need). */
function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (!k) continue;
        let v = part.slice(i + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        // express's res.cookie percent-encodes the value; undo that so JSON flow cookies round-trip.
        try { v = decodeURIComponent(v); } catch { /* keep the raw value */ }
        out[k] = v;
    }
    return out;
}

/** Compare two strings in constant time (the state must match the browser that started the flow). */
function sameString(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function createSso({ config, keys, sessions, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const cookieBase = () => ({ sameSite: 'lax', secure: config.cookies.secure, httpOnly: true, path: '/' });
    const sdkSso = createSsoClient({
        site: 'watch',
        siteName: 'OpenVibe.Watch',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        issuer: config.networkIssuer,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        audience: config.oauth.sessionAudience,
        jwks: config.jwksUrl,
        secureCookies: config.cookies.secure,
        fetch: fetchImpl,
        log,
    });

    function setSessionCookie(res, token) {
        res.cookie(SESSION_COOKIE, token, { ...cookieBase(), maxAge: sessions.DEFAULT_TTL_MS });
        res.cookie(HINT_COOKIE, 'account', { sameSite: 'lax', secure: config.cookies.secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 3600 * 1000 });
    }
    function clearSessionCookie(res) {
        res.clearCookie(SESSION_COOKIE, cookieBase());
        res.cookie(HINT_COOKIE, 'guest', { sameSite: 'lax', secure: config.cookies.secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 3600 * 1000 });
    }

    /**
     * Verify the token the Network just minted: a session token for openvibe.network, carrying the
     * canonical subject. Anything else (a service token, a typed token, another audience) never
     * becomes a session. Returns the claims or throws.
     */
    async function verifySessionToken(token) {
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: config.oauth.sessionAudience, now: now() });
        if (!v.ok) throw Object.assign(new Error(v.reason || 'the Network token did not verify'), { status: 401, code: v.code });
        const claims = v.claims || {};
        if (typeof claims.subject_id !== 'string' || !/^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/.test(claims.subject_id)) {
            throw Object.assign(new Error('this account has no canonical subject yet; sign in again'), { status: 401, code: 'identity.no_subject' });
        }
        return claims;
    }

    /** req.viewer for every page: the signed-in person named by the session cookie, else anonymous. */
    function middleware() {
        return async (req, _res, next) => {
            req.cookies = parseCookies(req.headers.cookie);
            req.viewer = { kind: 'anonymous' };
            const token = req.cookies[SESSION_COOKIE];
            if (!token) return next();
            try {
                const row = await sessions.resolve(token);
                if (row) req.viewer = sessions.viewer(row);
            } catch (err) {
                log.warn(`[sso] session lookup failed: ${(err && err.message) || err}`);
            }
            return next();
        };
    }

    function routes() {
        const r = express.Router();
        const flowCookie = () => ({ ...cookieBase(), path: '/auth', maxAge: FLOW_TTL_MS });
        const retryCookie = () => ({ ...cookieBase(), path: '/auth', maxAge: RETRY_TTL_MS });

        /** A sign-in that cannot finish starts once more by itself; the second time it shows the page. */
        function retryOrExplain(req, res, target, { status = 400, title, text }) {
            if (parseCookies(req.headers.cookie)[RETRY_COOKIE] !== '1') {
                res.cookie(RETRY_COOKIE, '1', retryCookie());
                return res.redirect(`/auth/login${target && target !== '/' ? `?next=${encodeURIComponent(target)}` : ''}`);
            }
            res.clearCookie(RETRY_COOKIE, { ...cookieBase(), path: '/auth' });
            return res.status(status).type('html').send(failurePage({
                siteName: 'OpenVibe.Watch',
                title,
                text,
                retryHref: `/auth/login${target && target !== '/' ? `?next=${encodeURIComponent(target)}` : ''}`,
                backHref: target || '/',
            }));
        }

        r.get('/login', (req, res) => {
            const next = sanitizeNext(req.query.next, config);
            const started = sdkSso.authorizeUrl();
            res.cookie(FLOW_COOKIE, JSON.stringify({ state: started.state, verifier: started.verifier, next }), flowCookie());
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            return res.redirect(started.url);
        });

        r.get('/callback', async (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            let flow = null;
            try { flow = JSON.parse(req.cookies[FLOW_COOKIE] || 'null'); } catch { flow = null; }
            res.clearCookie(FLOW_COOKIE, { ...cookieBase(), path: '/auth' });
            const next = flow ? sanitizeNext(flow.next, config) : '/';
            if (req.query.error) {
                res.clearCookie(RETRY_COOKIE, { ...cookieBase(), path: '/auth' });
                log.warn(`[sso] sign-in not completed: ${String(req.query.error).slice(0, 120)}`);
                return retryOrExplain(req, res, next, {
                    title: 'Sign-in didn\'t finish',
                    text: `OpenVibe.Network did not complete the sign-in (${String(req.query.error).slice(0, 60)}). Try again; your account is fine.`,
                });
            }
            if (!flow || typeof flow.state !== 'string' || typeof flow.verifier !== 'string'
                || typeof req.query.code !== 'string' || !sameString(req.query.state, flow.state)) {
                return retryOrExplain(req, res, next, {
                    title: 'Sign-in didn\'t finish',
                    text: 'It took too long, or it started in another tab or app. Start it again and it will go through; your account is fine.',
                });
            }
            let data;
            try {
                data = await sdkSso.tokenGrant({
                    grant_type: 'authorization_code',
                    redirect_uri: config.oauth.redirectUri,
                    code: req.query.code,
                    code_verifier: flow.verifier,
                });
            } catch (err) {
                const error = (err && (err.error || err.code)) || '';
                if (error === 'invalid_client' || error === 'unauthorized_client' || (err && err.status === 401)) {
                    log.error(`[sso] the Network refuses this site's OAuth client (${error || err.status}): check OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET`);
                    return res.status(500).type('html').send(failurePage({
                        siteName: 'OpenVibe.Watch',
                        title: 'Sign-in isn\'t working on OpenVibe.Watch right now',
                        text: 'This is a problem on our side, not with your account, and it has been logged. Please try again a little later.',
                        retryHref: `/auth/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`,
                        backHref: next || '/',
                    }));
                }
                log.warn(`[sso] code exchange failed: ${(err && (err.message || err.status)) || err}`);
                if (err && err.status && err.status < 500) {
                    return retryOrExplain(req, res, next, {
                        title: 'Sign-in didn\'t finish',
                        text: 'It took too long, or it started in another tab or app. Start it again and it will go through; your account is fine.',
                    });
                }
                return res.status(502).type('html').send(failurePage({
                    siteName: 'OpenVibe.Watch',
                    title: 'OpenVibe.Network didn\'t answer',
                    text: 'Your account is fine: the sign-in service did not reply in time. Try again in a moment.',
                    retryHref: `/auth/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`,
                    backHref: next || '/',
                }));
            }
            if (!data || typeof data.access_token !== 'string') {
                return retryOrExplain(req, res, next, {
                    title: 'Sign-in didn\'t finish',
                    text: 'OpenVibe.Network did not send a session. Start the sign-in again; your account is fine.',
                });
            }
            try {
                const claims = await verifySessionToken(data.access_token);
                const session = await sessions.create({
                    subject: claims.subject_id,
                    username: typeof claims.username === 'string' ? claims.username : null,
                    displayName: typeof claims.display_name === 'string' ? claims.display_name : null,
                    role: typeof claims.role === 'string' ? claims.role : null,
                    avatarUrl: claims.avatar_url, profileColor: claims.profile_color,
                });
                setSessionCookie(res, session);
                res.clearCookie(RETRY_COOKIE, { ...cookieBase(), path: '/auth' });
                // No Clear-Site-Data here or on sign-out: Chrome holds such an answer (and the cookies it sets) until the
                // cache is cleared, which on phones left people on the account chooser with no session (2026-10-28).
                return res.redirect(next);
            } catch (err) {
                log.warn(`[sso] sign-in refused: ${(err && err.code) || (err && err.message) || err}`);
                return res.status(401).type('html').send(failurePage({
                    siteName: 'OpenVibe.Watch',
                    title: 'That account cannot sign in here',
                    text: 'OpenVibe.Network confirmed the account, but this site cannot use it. Try another account or contact us.',
                    retryHref: `/auth/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`,
                    backHref: next || '/',
                }));
            }
        });

        // GET /auth/health: does the Network accept this site's OAuth client? 503 only when it refuses it.
        r.get('/health', async (_req, res) => {
            const client = await sdkSso.checkClient();
            res.set('Cache-Control', 'no-store');
            return res.status(client === 'invalid' ? 503 : 200).json({ ok: client !== 'invalid', client });
        });

        // Sign-out ends the session, so another site must not be able to trigger it (a cross-site
        // <img src=/auth/logout>). A same-origin navigation or form, or the address bar (Sec-Fetch-Site
        // none), signs out directly; anything else gets a confirm button (POST).
        const sameOriginRequest = (req) => {
            const site = String(req.get('sec-fetch-site') || '');
            if (site) return site === 'same-origin' || (site === 'none' && req.method === 'GET');
            const origin = req.get('origin');
            if (origin) return origin === `${req.protocol}://${req.get('host')}` || origin === new URL(config.baseUrl).origin;
            return req.method === 'GET';
        };
        r.get('/logout', (req, res, next) => {
            if (sameOriginRequest(req)) return next();
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            const q = req.query.next ? `?next=${encodeURIComponent(sanitizeNext(req.query.next, config))}` : '';
            return res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Sign out</title><meta name="viewport" content="width=device-width,initial-scale=1">`
                + `<form method="post" action="/auth/logout${q}" style="font:16px system-ui;margin:3em auto;max-width:24em;text-align:center">`
                + `<p>Sign out of OpenVibe.Watch?</p><button type="submit">Sign out</button> <a href="/">Cancel</a></form>`);
        });
        r.post('/logout', (req, res, next) => (sameOriginRequest(req) ? next() : res.status(403).type('text/plain').send('Sign-out must come from this site.')));
        r.all('/logout', async (req, res) => {
            const token = req.cookies && req.cookies[SESSION_COOKIE];
            if (token) { try { await sessions.revoke(token); } catch { /* the cookie is cleared anyway */ } }
            clearSessionCookie(res);
            return res.redirect(303, sanitizeNext(req.query.next, config));
        });

        r.get('/me', (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            // No cookie at all is a guest, not an error: the shared navbar asks on every page view.
            const c = req.cookies || {};
            if (!c[SESSION_COOKIE] && !req.get('authorization')) return res.json({ user: null });
            const v = req.viewer;
            if (!v || v.kind !== 'user') return res.status(401).json({ error: 'Not signed in' });
            return res.json({ user: { username: v.username, display_name: v.displayName, subject_id: v.subject, role: v.role, avatar_url: v.avatarUrl || null, profile_color: v.profileColor || null } });
        });
        return r;
    }

    return { middleware, routes, verifySessionToken, SESSION_COOKIE, FLOW_COOKIE };
}

module.exports = { createSso, sanitizeNext, ownOrigins, parseCookies, SESSION_COOKIE, FLOW_COOKIE, HINT_COOKIE };
