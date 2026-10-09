'use strict';
/**
 * OpenVibe.Watch configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/watch.env in production); see .env.example for the documented list.
 *
 * load(env) is pure so tests can build a config without touching process.env. `env` is also kept
 * as config.secrets: a watch source's credential is read from it by environment-variable NAME at
 * fetch time and never stored, logged or returned.
 *
 * The carrier preference order is binding (plan T18): webhook/event → ETag/Last-Modified → feed →
 * API → and only then browser polling through OpenVibe.Run. `run` below is where that last rung
 * lives; nothing in this release executes it (steps 5-7).
 */
const pkg = require('../package.json');

const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const list = (v, d) => (v == null || v === '' ? d : String(v).split(',').map(s => s.trim()).filter(Boolean));
const strip = (v) => String(v || '').replace(/\/$/, '');

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4730);
    const networkUrl = strip(env.OV_NETWORK_URL || 'https://openvibe.network');
    const networkInternalUrl = strip(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000');
    // The JWKS the SDK's client (openvibe-sdk/auth jwksClient) fetches, caches and keeps fresh; one URL,
    // since the SDK keeps one client per URL. Defaults to Network's internal JWKS.
    const jwksUrl = strip(env.OV_NETWORK_JWKS_URL || `${networkInternalUrl}/api/.well-known/jwks`);
    const baseUrl = strip(env.BASE_URL || (isProduction ? 'https://openvibe.watch' : `http://localhost:${port}`));
    return {
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        serviceId: 'watch',
        baseUrl,
        // The public site is behind nginx (and Cloudflare): trust the proxy's forwarded address, as the
        // API's own limits and same-origin checks need the real client. 0 disables it (tests).
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,

        networkUrl,
        networkInternalUrl,
        jwksUrl,
        issuer: strip(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        // The issuer a person's Network session token carries (sign-in); the same Network as the API's.
        networkIssuer: strip(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        audience: 'openvibe.watch',
        // Per-actor limits (server/api/actor-limits.js): the API reads one app or module may make per
        // minute and per hour. Writes and manual checks set their own numbers there.
        limits: {
            minute: Math.max(1, int(env.WATCH_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.WATCH_LIMITS_HOUR, 3000)),
        },
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'watch',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            // The site's redirect (BASE_URL + /auth/callback) and the scope and audience a person's
            // Network session token is verified for. The scope is 'profile': the site asks for nothing
            // beyond who the person is, because it acts on its own registry, not on Network.
            redirectUri: strip(env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`),
            scope: env.OV_OAUTH_SCOPE || 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        // The site's session cookie: Secure in production (https), off in development and tests.
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '' },

        events: {
            url: strip(env.EVENTS_URL || ''),
            relayIntervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            // OpenVibe.Events → Watch (ADR-033 account export and deletion, server/account-data.js): the secret(s) that
            // sign a delivery to POST /internal/events (comma-separated for rotation, 32+ characters each; unset → 503,
            // and no subscription is created at boot).
            secrets: String(env.WATCH_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
        },

        // The check worker: every WATCH_TICK_MS, start checks for active watches whose turn has come.
        worker: {
            enabled: env.WATCH_WORKER !== 'off',
            tickMs: int(env.WATCH_TICK_MS, 5000),
            maxConcurrent: int(env.WATCH_MAX_CONCURRENT, 8),
            // Longest wait between checks of a failing watch (exponential backoff cap).
            maxBackoffMs: int(env.WATCH_MAX_BACKOFF_MS, 6 * 3600 * 1000),
        },
        fetch: {
            userAgent: env.WATCH_USER_AGENT || `OpenVibeWatch/${pkg.version} (+https://openvibe.watch; Contact@OpenVibe.Network)`,
            timeoutMs: int(env.WATCH_FETCH_TIMEOUT_MS, 20000),
            maxBytes: int(env.WATCH_MAX_BYTES, 5 * 1024 * 1024),
            maxRedirects: int(env.WATCH_MAX_REDIRECTS, 5),
            // Minimum gap between any two requests to one host, whatever the watches say.
            hostMinIntervalMs: int(env.WATCH_HOST_MIN_INTERVAL_MS, 1000),
            allowedPorts: list(env.WATCH_ALLOWED_PORTS, ['80', '443']).map(Number),
            // Exact hostnames/IPs that may resolve to private or loopback addresses (tests and
            // deliberate on-host watches only). Empty in production.
            allowPrivateHosts: list(env.WATCH_ALLOW_PRIVATE_HOSTS, []),
        },
        observations: {
            // How many observations one check may record (a mapped feed or API can yield several
            // values; the cap keeps one pathological check from writing thousands of rows).
            maxPerCheck: int(env.WATCH_OBSERVATIONS_MAX_PER_CHECK, 100),
            // A snapshot is a capped copy of the body the value came from (observation.v1.json).
            snapshotMax: 8 * 1024,
        },
        retention: {
            // observations_days when the watch states none; a watch may override it (watch.watch@1).
            defaultDays: int(env.WATCH_RETENTION_DEFAULT_DAYS, 90),
        },

        // OpenVibe.Run (plan T14): the expensive last rung — browser polling — and never used before
        // steps 5-7 exist. WATCH_RUN_URL is Run's loopback port.
        run: {
            url: strip(env.WATCH_RUN_URL || 'http://127.0.0.1:4920'),
            oauth: {
                clientId: env.OV_OAUTH_CLIENT_ID || 'watch',
                clientSecret: env.WATCH_RUN_OAUTH_CLIENT_SECRET || '',
            },
        },

        secrets: env,
    };
}

module.exports = { load };
