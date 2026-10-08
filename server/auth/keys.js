'use strict';
/**
 * The Network's RS256 signing key, fetched once from the configured JWKS URL and kept fresh by
 * openvibe-sdk/auth's JWKS client. The site needs it to verify the person's Network session token
 * during the OAuth code exchange (server/auth/sso.js): a token that does not verify for
 * `openvibe.network` with a real subject never becomes a session.
 *
 * The SDK keeps one client per URL (last good keys through an outage, backoff, rotations, unref'd
 * timer). This is a thin shim so the SSO middleware can call `verifyUser`, and nothing the SDK says
 * about a failed key fetch (it names the internal JWKS URL) leaves the process: a key that has not
 * loaded is answered as 'signing key not loaded yet'.
 */
const sdk = require('openvibe-sdk/auth');

const KEY_UNAVAILABLE = 'signing key not loaded yet';
const DOES_NOT_VERIFY = 'token does not verify';

function publicReason(err) {
    const code = err && err.code;
    if (!code || code === 'token.no_key') return code ? KEY_UNAVAILABLE : DOES_NOT_VERIFY;
    return (err.message && String(err.message).slice(0, 200)) || DOES_NOT_VERIFY;
}

const jwksUrl = (config) => (config.jwksUrl || `${config.networkInternalUrl || config.networkUrl}/api/.well-known/jwks`);

function createKeyStore({ config, fetchImpl = globalThis.fetch, log = console }) {
    const url = jwksUrl(config);
    const client = sdk.jwksClient(url, { fetch: fetchImpl, log });

    // The SDK's `now` is a NUMBER of milliseconds; a function disables every expiry check.
    const asMs = (v) => (typeof v === 'function' ? v() : (typeof v === 'number' ? v : Date.now()));

    /** Fetch (or wait out the backoff window) once at boot. */
    async function ensure() {
        try { await client.keys(); } catch (err) { log.warn(`[watch] JWKS unavailable: ${err && err.message || err}`); }
    }
    function loaded() { return client.status().ready === true; }

    /**
     * Verify a person's (session) token: { ok, claims } or { ok: false, code, reason, expired }.
     * `reason` is one of two fixed public strings; the SDK's own text (the JWKS URL, the fetch error)
     * is logged, never returned.
     */
    async function verifyUser(token, { issuer, audience, now = Date.now() } = {}) {
        try {
            const claims = await sdk.verifyUserToken(token, { jwks: url, issuer, audience, now: asMs(now), log });
            return { ok: true, claims };
        } catch (err) {
            const code = err && err.code;
            log.warn(`[watch] user token rejected (${code || 'error'}):`, (err && err.message) || err);
            return { ok: false, reason: publicReason(err), code, expired: code === 'token.expired' };
        }
    }

    return { ensure, loaded, verifyUser, client, stop: () => client.stop() };
}

module.exports = { createKeyStore, jwksUrl };
