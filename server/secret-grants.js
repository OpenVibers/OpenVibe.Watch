'use strict';
/**
 * Who may use a named secret (plan T18). A watch names its secrets by environment variable and Watch reads the value
 * at use time, never storing it:
 *
 *   source.auth.env     WATCH_CRED_*   a source's credential, sent with the watch's own request
 *   action.secret_env   WATCH_HOOK_*   the key a webhook action signs its delivery with
 *
 * The NAME alone must not be a capability. Without a grant, anyone could create a watch that names an operator's
 * credential, point it at a URL of their own and receive the credential. They could also have their deliveries signed
 * with another receiver's key and replay them there. So the operator grants each name, in WATCH_SECRET_GRANTS (JSON):
 *
 *   {"WATCH_CRED_ACME": {"owners": ["usr_…"], "origins": ["https://api.acme.example"]},
 *    "WATCH_HOOK_ALEX": {"owners": ["usr_…"]}}
 *
 * A credential is used only by a granted owner and sent only to a granted origin (scheme, host and port, exactly). A
 * webhook key is used only by a granted owner. A name with no grant is usable by nobody, and that is the default.
 * The registry checks when a watch is saved (the API and the form say why), and the carriers and the action worker
 * check again at use, because a grant can be withdrawn. Malformed JSON grants nothing.
 */

// A person (usr_) or one of their agents (agt_) may own a watch, so either may hold a grant.
const USER = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME = /^WATCH_(CRED|HOOK)_[A-Z0-9_]{2,60}$/;

function originOf(u) {
    try {
        const x = new URL(String(u));
        return x.protocol === 'https:' || x.protocol === 'http:' ? x.origin : null;
    } catch { return null; }
}

/** WATCH_SECRET_GRANTS → { name: { owners: Set, origins: Set } }. Anything malformed is dropped (never widened). */
function parseGrants(raw, log = console) {
    if (raw == null || String(raw).trim() === '') return {};
    let v;
    try { v = JSON.parse(raw); } catch {
        log.warn('[watch] WATCH_SECRET_GRANTS is not JSON: no watch can use a named secret');
        return {};
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
        log.warn('[watch] WATCH_SECRET_GRANTS must be an object of grants: no watch can use a named secret');
        return {};
    }
    const out = {};
    for (const [name, g] of Object.entries(v)) {
        if (!NAME.test(name) || !g || typeof g !== 'object') continue;
        const owners = (Array.isArray(g.owners) ? g.owners : []).map(String).filter((o) => USER.test(o));
        const origins = (Array.isArray(g.origins) ? g.origins : []).map(originOf).filter(Boolean);
        out[name] = { owners: new Set(owners), origins: new Set(origins) };
    }
    return out;
}

function createSecretGrants({ grants = {} } = {}) {
    /** null when `owner` may use `name` (a credential: toward `url`), else why not, in one line. */
    function refusal(name, owner, url = undefined) {
        const g = grants[name];
        if (!g) return `${name} is not granted to any owner (WATCH_SECRET_GRANTS)`;
        if (!g.owners.has(String(owner || ''))) return `${name} is not granted to this owner`;
        if (url !== undefined) {
            const o = originOf(url);
            if (!o || !g.origins.has(o)) return `${name} may not be sent to ${o || 'that URL'}`;
        }
        return null;
    }

    /** The named secrets of a watch (request-shaped) its owner may not use: [{ path, reason }], empty when all are. */
    function check(owner, rec) {
        const out = [];
        const source = rec && rec.source;
        const auth = source && source.auth;
        if (auth && auth.mode && auth.mode !== 'none' && auth.env) {
            const why = refusal(auth.env, owner, source.url || '');
            if (why) out.push({ path: '/source/auth/env', reason: why });
        }
        (Array.isArray(rec && rec.action) ? rec.action : []).forEach((a, i) => {
            if (a && a.kind === 'webhook' && a.secret_env) {
                const why = refusal(a.secret_env, owner);
                if (why) out.push({ path: `/action/${i}/secret_env`, reason: why });
            }
        });
        return out;
    }

    /** The environment a carrier may read for this watch: its own credential, if granted toward its own origin. */
    function viewFor(watch, env) {
        const source = watch && watch.source;
        const auth = source && source.auth;
        if (!auth || !auth.env || !env) return {};
        return refusal(auth.env, watch.owner, source.url || '') ? {} : { [auth.env]: env[auth.env] };
    }

    return { refusal, check, viewFor };
}

module.exports = { parseGrants, createSecretGrants, originOf };
