'use strict';
/**
 * The usage carrier (plan AD.37, Contracts 0.450.0; the owner, 11-21: "detect your usage limit and … use that on Watch or
 * other platforms … if the weekly reset's coming up and there's still usage available … get every ounce of your
 * usage"): the owner's coding agents' plan windows, as OpenVibe.Codes reads them from their machines.
 *
 *   source: { kind: 'usage', agent?: 'claude-code' | 'codex' | …, window?: '5h' | 'week' | 'any' }
 *
 * The check states the document
 *   { windows: [{ agent, window, used_pct, left_pct, resets_at, hours_to_reset }],
 *     agent, window, used_pct, left_pct, resets_at, hours_to_reset }        ← the chosen window, at the top
 * so a condition reads `left_pct >= 15` and `hours_to_reset <= 12` (json/jsonpath extraction). The chosen window: the one
 * that resets soonest with room left among those the source names; none left: the soonest one. Watch asks Codes with its
 * own token for the owner (X-OV-Subject); the watch must belong to a person.
 */
const { sha256 } = require('../util');

const PERSON = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const base = { http_status: null, bytes: null, raw_body_hash: null, etag: null, last_modified: null, body: null, content_type: null, detail: null, error_code: null, notBefore: null };

/** A plan window's name as the source names them: '5h' for any five-hour window, 'week' for a weekly one. */
function windowKind(name) {
    const n = String(name || '').toLowerCase();
    if (/5\s*h|five|session|hour/.test(n)) return '5h';
    if (/week|7\s*d|seven/.test(n)) return 'week';
    return n.slice(0, 20) || 'window';
}

/** The person's usage view from Codes → the flat windows, newest reading wins. */
function windowsOf(view, now) {
    const out = [];
    for (const a of (view && Array.isArray(view.agents) ? view.agents : [])) {
        for (const w of (Array.isArray(a.windows) ? a.windows : [])) {
            const used = Number.isFinite(Number(w.pct)) ? Number(w.pct)
                : Number.isFinite(Number(w.used)) && Number(w.limit) > 0 ? (Number(w.used) / Number(w.limit)) * 100 : null;
            const at = Date.parse(String(w.resets_at || ''));
            if (used == null) continue;
            const resetPassed = Number.isFinite(at) && at <= now;
            const usedPct = Math.max(0, Math.min(100, resetPassed ? 0 : used));
            out.push({
                agent: String(a.agent || ''), window: windowKind(w.name), used_pct: Math.round(usedPct * 10) / 10, left_pct: Math.round((100 - usedPct) * 10) / 10,
                resets_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
                hours_to_reset: Number.isFinite(at) ? Math.max(0, Math.round(((at - now) / 3600e3) * 10) / 10) : null,
            });
        }
    }
    return out;
}

function choose(windows, { agent = null, window = 'any' } = {}) {
    const pool = windows.filter((w) => (!agent || w.agent === agent) && (!window || window === 'any' || w.window === window));
    if (!pool.length) return null;
    const soon = (a, b) => (a.hours_to_reset ?? Infinity) - (b.hours_to_reset ?? Infinity) || b.left_pct - a.left_pct;
    const roomy = pool.filter((w) => w.left_pct > 0).sort(soon);
    return roomy[0] || pool.slice().sort(soon)[0];
}

function createUsageCarrier({ codes, now = Date.now }) {
    return {
        name: 'usage',
        run: async ({ watch, owner }) => {
            if (!codes || typeof codes.usage !== 'function') return { ...base, state: 'disabled', error_code: 'usage_unavailable', detail: 'Watch has no OpenVibe.Codes client here (no service credentials)' };
            if (!PERSON.test(String(owner || ''))) return { ...base, state: 'disabled', error_code: 'usage_person_only', detail: 'a usage source reads a person\'s own plan windows: the watch must belong to a person' };
            let view;
            try { view = await codes.usage(owner); } catch (err) {
                const status = err && Number.isInteger(err.status) ? err.status : null;
                return { ...base, state: status === 429 ? 'rate_limited' : 'http_error', http_status: status, error_code: (err && err.code) ? String(err.code) : 'usage_unreachable', detail: String((err && (err.detail || err.message)) || 'OpenVibe.Codes did not answer').slice(0, 500) };
            }
            const windows = windowsOf(view, now());
            const src = watch && watch.source ? watch.source : {};
            const pick = choose(windows, { agent: src.agent || null, window: src.window || 'any' });
            const document = { windows, agent: null, window: null, used_pct: null, left_pct: null, resets_at: null, hours_to_reset: null, ...(pick || {}) };
            if (!windows.length) document.note = 'no machine of yours has reported a plan window yet (OpenVibe Link reads them every few minutes)';
            const body = JSON.stringify(document);
            return { ...base, state: 'ok', document, body, content_type: 'application/json', bytes: body.length, raw_body_hash: sha256(body) };
        },
    };
}

module.exports = { createUsageCarrier, windowsOf, choose, windowKind };
