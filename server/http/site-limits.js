'use strict';
/**
 * The public site's own write budgets, with the same numbers as the API's per-actor limits
 * (server/api/actor-limits.js): making or changing a watch is 30 a minute / 600 an hour, and a manual
 * check is 10 a minute / 120 an hour, counted per signed-in subject. The site renders a friendly page
 * when a budget is spent instead of the API's problem+json, but the numbers are one policy, stated
 * once here and in the README.
 *
 * Counters live in this process: a restart forgets them, exactly like the API's.
 */
const BUDGETS = {
    'watch.write': { minute: 30, hour: 3600 },
    'watch.check.run': { minute: 10, hour: 7200 },
};

function createSiteLimits({ now = () => Date.now() } = {}) {
    const counters = new Map();   // `${name} ${actor}` -> { minute: [start, n], hour: [start, n] }

    /** Count one action; { ok, retryAfter } — retryAfter in seconds when refused. */
    function take(name, actor) {
        const budget = BUDGETS[name];
        if (!budget || !actor) return { ok: true };
        const t = now();
        const key = `${name} ${actor}`;
        let c = counters.get(key);
        if (!c) { c = {}; counters.set(key, c); }
        for (const window of ['minute', 'hour']) {
            const span = window === 'minute' ? 60_000 : 3_600_000;
            const cell = c[window];
            if (!cell || t - cell[0] >= span) c[window] = [t, 1];
            else cell[1] += 1;
            if (c[window][1] > budget[window]) {
                return { ok: false, retryAfter: Math.max(1, Math.ceil((c[window][0] + span - t) / 1000)) };
            }
        }
        return { ok: true };
    }

    return { take, BUDGETS };
}

module.exports = { createSiteLimits, BUDGETS };
