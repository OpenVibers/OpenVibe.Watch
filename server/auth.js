'use strict';
/**
 * Authentication and capability checks. Watch serves two kinds of caller, and every API route is
 * guarded by exactly ONE capability (server/api/*.js):
 *
 *   a service   an RS256 client-credentials token from OpenVibe.Network (audience openvibe.watch,
 *               sub svc:… / app:… / mod:…), verified offline against Network's JWKS
 *               (openvibe-sdk/auth, one client per URL, kept fresh and served through an outage).
 *               Its `cap` claim is judged by openvibe-contracts' own grant rule (an exact id or a
 *               `family.*` grant; capability.unknown for an id the release does not know). The
 *               watch.* capabilities are released, so the library decides every one of them.
 *
 *   a person    the bearer token of a signed-in user (sub usr_…) or agent (sub agt_…), verified
 *               with openvibe-sdk/auth verifyUserToken for the same issuer and audience. Such a
 *               token carries no capability list: watches are user-defined resources and the guard
 *               that matters is ownership — every route scopes to the acting subject, and another
 *               owner's watch answers 404 (registry.js). A person may therefore use all four watch
 *               capabilities, on their own watches only.
 *
 * X-OV-Subject, presented by a first-party service (svc:…) that acts for a person (the public site
 * going through Network/Services, or an agent's runtime), names the subject a route acts for; the
 * watch it creates is owned by that person and its reads are scoped to them. An app:… or mod:…
 * principal is a third party and may never name one, exactly as in OpenVibe.Deals.
 */
const { serviceAuth, capabilities, http } = require('openvibe-contracts');
const { jwksClient, verifyUserToken } = require('openvibe-sdk/auth');

const CAPS = Object.freeze({
    read: 'watch.watch.read',
    manage: 'watch.watch.manage',
    observations: 'watch.observation.read',
    run: 'watch.check.run',
});

/** Service-side principals: their token carries `cap` and is judged by the capability rule. */
const SERVICE_SUB = /^(svc|app|mod):/;
/** A person (usr_…) or an agent (agt_…) subject: the token is the identity, ownership is the authority. */
const PERSON_SUB = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;

function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

/** Payload of an (unverified) token, used only to pick the verifier — never to decide anything. */
function tokenPayload(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

function createAuth({ config, log = console }) {
    const headerKid = (token) => { try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { return null; } };

    /** { ok, claims } or { ok: false, code, reason }. The SDK's error names the internal JWKS URL: logged, never answered. */
    async function verifyService(token) {
        const kid = headerKid(token);
        let keys;
        try { keys = await jwksClient(config.jwksUrl, { log }).keysForKid(kid); } catch (err) {
            log.error(`[auth] Network keys unavailable: ${(err && err.message) || err}`);
            return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        }
        const byKid = kid ? keys.filter((k) => k.kid === kid) : [];
        let last = { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        for (const k of byKid.length ? byKid : keys) {
            last = serviceAuth.verifyServiceToken(token, { publicKey: k.key, issuer: config.issuer, audience: config.audience });
            if (last.ok || last.code !== 'token.bad_signature') return last;
        }
        return last;
    }

    /** { ok, claims } or { ok: false, code, reason, status }. Every token rule is the SDK's verifyUserToken. */
    async function verifyUser(token) {
        try {
            const claims = await verifyUserToken(token, { jwks: config.jwksUrl, issuer: config.issuer, audience: config.audience });
            return { ok: true, claims };
        } catch (err) {
            const code = (err && err.code) || 'token.malformed';
            const status = Number(err && err.status) === 503 || code === 'token.no_key' ? 503 : 401;
            return { ok: false, code: status === 503 ? 'token.unavailable' : code, reason: status === 503 ? 'signing key not loaded yet' : ((err && err.message) || 'token rejected'), status };
        }
    }

    /**
     * Express guard: one capability. Sets req.principal = { sub, kind, role, cap, jti, subject }.
     * `kind` is 'service' or 'person'; `subject` is the person a trusted service acts for (else null).
     */
    function requireCap(id) {
        return async function capGuard(req, res, next) {
            const ctx = req.ov;
            const h = String(req.headers.authorization || '');
            if (!h.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service or user token is required', ctx });
            const token = h.slice(7).trim();
            const payload = tokenPayload(token);
            if (!payload || typeof payload.sub !== 'string') return http.sendProblem(res, 401, 'token.malformed', { detail: 'not a signed JWT', ctx });

            if (SERVICE_SUB.test(payload.sub)) {
                // The keys come from the SDK's JWKS client (one per URL, started at boot: the last good keys through a
                // Network outage, a rotation honoured on an unknown kid); every token rule is openvibe-contracts'
                // verifyServiceToken (identity.service-token-claims@1, sandbox refused, issuer, audience, expiry).
                let r;
                try { r = await verifyService(token); } catch (err) { return next(err); }
                if (!r.ok) return http.sendProblem(res, r.code === 'token.unavailable' ? 503 : 401, r.code, { detail: r.reason, ctx });
                const claims = r.claims;
                const c = checkCapability(claims, id);
                if (!c.allowed) return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx });
                req.principal = { sub: claims.sub, kind: 'service', role: null, cap: claims.cap, jti: claims.jti, subject: null };
            } else {
                // A person or an agent: usr_…/agt_… only. verifyUserToken refuses a service principal, a typed token
                // (typ/purpose) and every rule this service does not serve.
                const r = await verifyUser(token);
                if (!r.ok) return http.sendProblem(res, r.status === 503 ? 503 : 401, r.code, { detail: r.reason, ctx });
                const claims = r.claims;
                req.principal = { sub: claims.sub, kind: 'person', role: claims.role || null, cap: null, jti: claims.jti || null, subject: null };
            }

            // X-OV-Subject: only a first-party service may name the person it acts for, and only a
            // usr_…/agt_… subject; the watch is then owned by and scoped to that subject.
            const named = req.get('x-ov-subject');
            if (named) {
                if (req.principal.kind !== 'service' || !/^svc:/.test(req.principal.sub)) {
                    return http.sendProblem(res, 403, 'watch.subject_not_delegated', { detail: 'only a first-party service token may name the person it acts for (X-OV-Subject)', ctx });
                }
                if (!PERSON_SUB.test(String(named))) return http.sendProblem(res, 400, 'watch.subject_invalid', { detail: 'X-OV-Subject must be a usr_… or agt_… subject id', ctx });
                req.principal.subject = String(named);
            }
            return next();
        };
    }

    return { requireCap, verifyService, verifyUser };
}

/** The subject a route acts for: the person a trusted service names, else the caller itself. */
function ownerOf(principal) {
    return (principal && (principal.subject || principal.sub)) || null;
}

module.exports = { CAPS, createAuth, checkCapability, ownerOf, SERVICE_SUB, PERSON_SUB };
