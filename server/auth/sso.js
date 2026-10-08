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
 * The OAuth half rides openvibe-sdk/auth's own helpers (startAuthorization / readCallback /
 * exchangeCode), so the PKCE, state and token-endpoint rules are the SDK's, not a hand copy.
 */
const express = require('express');
const sdk = require('openvibe-sdk/auth');
const cache = require('openvibe-shared/cache-policy');

const SESSION_COOKIE = 'watch_session';
const FLOW_COOKIE = 'watch_oauth';
const HINT_COOKIE = 'ov_sso_hint';
const FLOW_TTL_MS = 10 * 60 * 1000;

/** Same-site relative paths only (never protocol-relative, never another origin). */
function sanitizeNext(next) {
    // Browsers drop tab/newline and read a backslash as "/": "/<TAB>/evil.com" would leave the site.
    if (typeof next === 'string' && /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
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

function createSso({ config, keys, sessions, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const cookieBase = () => ({ sameSite: 'lax', secure: config.cookies.secure, httpOnly: true, path: '/' });

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

        r.get('/login', async (req, res) => {
            const next = sanitizeNext(req.query.next);
            const started = await sdk.startAuthorization({
                network: config.networkUrl,
                clientId: config.oauth.clientId,
                redirectUri: config.oauth.redirectUri,
                scope: config.oauth.scope,
                state: sdk.createState(),
            });
            res.cookie(FLOW_COOKIE, JSON.stringify({ state: started.state, verifier: started.codeVerifier, next }), flowCookie());
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            return res.redirect(started.url);
        });

        r.get('/callback', async (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            let flow = null;
            try { flow = JSON.parse(req.cookies[FLOW_COOKIE] || 'null'); } catch { flow = null; }
            res.clearCookie(FLOW_COOKIE, { ...cookieBase(), path: '/auth' });
            const next = flow ? sanitizeNext(flow.next) : '/';
            const query = new URLSearchParams();
            for (const [k, v] of Object.entries(req.query)) query.set(k, String(v));
            let code;
            try {
                ({ code } = sdk.readCallback(`/auth/callback?${query.toString()}`, { expectedState: flow && flow.state }));
            } catch (err) {
                return res.status(400).type('text/plain').send('Sign-in was not completed. Please try again.');
            }
            if (!flow || typeof flow.verifier !== 'string') {
                return res.status(400).type('text/plain').send('Sign-in was not started in this browser. Please try again.');
            }
            let token;
            try {
                const data = await sdk.exchangeCode({
                    code,
                    redirectUri: config.oauth.redirectUri,
                    codeVerifier: flow.verifier,
                    clientId: config.oauth.clientId,
                    clientSecret: config.oauth.clientSecret || undefined,
                    tokenUrl: `${config.networkInternalUrl}/oauth/token`,
                    network: config.networkUrl,
                    fetch: fetchImpl,
                });
                token = data.access_token;
            } catch (err) {
                log.warn(`[sso] code exchange failed: ${(err && err.code) || (err && err.status) || err}`);
                return res.status(502).type('text/plain').send('Sign-in failed: OpenVibe.Network did not accept the sign-in code. Please try again.');
            }
            try {
                const claims = await verifySessionToken(token);
                const session = await sessions.create({
                    subject: claims.subject_id,
                    username: typeof claims.username === 'string' ? claims.username : null,
                    displayName: typeof claims.display_name === 'string' ? claims.display_name : null,
                    role: typeof claims.role === 'string' ? claims.role : null,
                });
                setSessionCookie(res, session);
                return res.redirect(next);
            } catch (err) {
                log.warn(`[sso] sign-in refused: ${(err && err.code) || (err && err.message) || err}`);
                return res.status(401).type('text/plain').send('Sign-in failed: that account cannot be signed in here.');
            }
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
            const q = req.query.next ? `?next=${encodeURIComponent(sanitizeNext(req.query.next))}` : '';
            return res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Sign out</title><meta name="viewport" content="width=device-width,initial-scale=1">`
                + `<form method="post" action="/auth/logout${q}" style="font:16px system-ui;margin:3em auto;max-width:24em;text-align:center">`
                + `<p>Sign out of OpenVibe.Watch?</p><button type="submit">Sign out</button> <a href="/">Cancel</a></form>`);
        });
        r.post('/logout', (req, res, next) => (sameOriginRequest(req) ? next() : res.status(403).type('text/plain').send('Sign-out must come from this site.')));
        r.all('/logout', async (req, res) => {
            const token = req.cookies && req.cookies[SESSION_COOKIE];
            if (token) { try { await sessions.revoke(token); } catch { /* the cookie is cleared anyway */ } }
            clearSessionCookie(res);
            return res.redirect(303, sanitizeNext(req.query.next));
        });

        r.get('/me', (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            // No cookie at all is a guest, not an error: the shared navbar asks on every page view.
            const c = req.cookies || {};
            if (!c[SESSION_COOKIE] && !req.get('authorization')) return res.json({ user: null });
            const v = req.viewer;
            if (!v || v.kind !== 'user') return res.status(401).json({ error: 'Not signed in' });
            return res.json({ user: { username: v.username, display_name: v.displayName, subject_id: v.subject, role: v.role } });
        });
        return r;
    }

    return { middleware, routes, verifySessionToken, SESSION_COOKIE, FLOW_COOKIE };
}

module.exports = { createSso, sanitizeNext, parseCookies, SESSION_COOKIE, FLOW_COOKIE, HINT_COOKIE };
