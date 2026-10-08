'use strict';
/**
 * Sign-in sessions for the public site, kept in Watch's own database (migration 0002).
 *
 * The browser holds an opaque random token in an httpOnly cookie (server/auth/sso.js sets it); this
 * module stores only sha256(token), so a database read never hands out a live session. The row names
 * the canonical subject (usr_…/agt_…) the watches belong to — the same authority the API scopes
 * ownership by. The person's Network access token is never stored: it is verified once at sign-in and
 * discarded, because the site acts on the registry in-process, not as the person over Network.
 */
const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;   // at most one last_seen_at write a minute per session

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function createSessions({ db, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS }) {
    const st = {
        insert: db.prepare(`INSERT INTO web_sessions (id, subject, username, display_name, role, created_at, last_seen_at, expires_at, revoked_at)
            VALUES (@id, @subject, @username, @display_name, @role, @created_at, @last_seen_at, @expires_at, NULL)`),
        get: db.prepare('SELECT * FROM web_sessions WHERE id = ?'),
        touch: db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?'),
        revoke: db.prepare('UPDATE web_sessions SET revoked_at = ? WHERE id = ?'),
        prune: db.prepare('DELETE FROM web_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL'),
    };

    /** A fresh opaque token; only its hash is stored. */
    const newToken = () => crypto.randomBytes(32).toString('base64url');

    /**
     * Create a session for a verified person. Returns the cookie token (shown once, never stored).
     * The subject is required: a session with nobody's subject owns nothing and is refused.
     */
    async function create({ subject, username = null, displayName = null, role = null }) {
        if (typeof subject !== 'string' || !subject) throw new Error('a session needs a subject');
        const token = newToken();
        const t = now();
        await st.insert.run({
            id: hash(token), subject,
            username: username == null ? null : String(username).slice(0, 64),
            display_name: displayName == null ? null : String(displayName).slice(0, 80),
            role: role == null ? null : String(role).slice(0, 32),
            created_at: t, last_seen_at: t, expires_at: t + ttlMs,
        });
        return token;
    }

    /**
     * The session a cookie token names, or null when it is unknown, expired or revoked. A live
     * session past its touch interval has last_seen_at moved (best effort: a failed write never
     * refuses a request).
     */
    async function resolve(token) {
        if (!token || typeof token !== 'string') return null;
        const row = await st.get.get(hash(token));
        if (!row) return null;
        if (row.revoked_at != null) return null;
        const t = now();
        if (Number(row.expires_at) <= t) return null;
        if (t - Number(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
            try { await st.touch.run(t, row.id); } catch { /* the session is still valid */ }
        }
        return row;
    }

    /** End one session (sign-out): the cookie token names it. */
    async function revoke(token) {
        if (!token) return false;
        const out = await st.revoke.run(now(), hash(token));
        return out.changes > 0;
    }

    /** Drop expired and revoked rows (called hourly from server/index.js). */
    async function prune(at = now()) {
        return (await st.prune.run(at)).changes;
    }

    /** The viewer shape the pages read (never includes the token). */
    function viewer(row) {
        if (!row) return { kind: 'anonymous' };
        return {
            kind: 'user',
            subject: row.subject,
            username: row.username || null,
            displayName: row.display_name || row.username || 'you',
            role: row.role || 'user',
        };
    }

    return { create, resolve, revoke, prune, viewer, hash, DEFAULT_TTL_MS };
}

module.exports = { createSessions, DEFAULT_TTL_MS };
