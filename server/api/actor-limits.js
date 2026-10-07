'use strict';
/**
 * Per-actor rate limits on /api/v1 (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * Every API route takes a token and one capability (auth.js); the limits count requests by the
 * principal that passed that guard (req.principal.sub: svc:watch, a person's usr_…, an app:app_…),
 * before the route does any work. Watch's own worker (the scheduler, the carriers, the outbox
 * relay) runs in this process and never goes through HTTP, so nothing here can slow a check.
 *
 *   Reads (watch.watch.read, watch.observation.read) take WATCH_LIMITS_MINUTE / WATCH_LIMITS_HOUR,
 *   120 and 3000, for an app or module (app:…, mod:…). A first-party service (svc:…) is not counted
 *   on reads: the public site and an agent's runtime read for many people, and one budget for the
 *   whole service would refuse real people's work.
 *
 *   Writes (watch.watch.manage) and manual checks (watch.check.run) are counted for every principal
 *   with the budgets below: a person creating watches from a page, or a service nudging a check.
 *
 * Past a limit the route answers 429 problem+json `rate_limited` with Retry-After; the refusal is
 * logged once and counted in watch_rate_limited_total{limit,window}. Counters live in this process:
 * a restart forgets them. Never limited: /api/health, /api/ready, /release.json, /metrics and the
 * home page.
 */
const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;

function actor(req) {
    const p = req.principal;
    if (p && typeof p.sub === 'string' && p.sub) return p.sub;
    return defaultActor(req);
}

/** Counted on reads: anything but a first-party service (an app or module acting as itself). */
function countedRead(req) {
    const p = req.principal;
    return !(p && FIRST_PARTY.test(String(p.sub)));
}

/** The writes, each with its numbers per principal (a minute, an hour). */
const BUDGETS = {
    // Creating, changing, pausing or deleting a watch is a deliberate act by a person or a service
    // acting for one: a form every few seconds at most.
    'watch.write': { minute: 30, hour: 600 },
    // A manual check spends the watched site's bandwidth now (the per-host spacing still applies),
    // so it is rarer than a write and always bounded by the watch's own cadence.
    'watch.check.run': { minute: 10, hour: 120 },
};

/**
 * limits(name, own) middleware, plus limits.reads(name) (the defaults on a counted read) and
 * limits.budget(name) (one of BUDGETS).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'watch_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor,
        now,
        onLimited(e) {
            // The actor is a principal (or an address), never a token.
            log.warn(`[limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return function actorReadLimit(req, res, next) { return countedRead(req) ? limit(req, res, next) : next(); };
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createActorLimits, actor, countedRead, BUDGETS };
