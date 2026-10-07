'use strict';
/**
 * Checks, observations and check runs (one capability per route).
 *
 *   watch.check.run
 *     POST /api/v1/watches/:id/check    run one check now, outside the cadence
 *   watch.observation.read
 *     GET  /api/v1/watches/:id/observations?before=&limit=   newest first, cursor by rid
 *     GET  /api/v1/watches/:id/checks?before=&limit=         the check runs, newest first
 *
 * A manual check of a watch that is paused, disabled or failed is refused with 409: it is recorded
 * as `disabled` in the check runs, and nothing is fetched. A source whose carrier is a later step
 * (event, webhook, node, run) answers 422 watch.carrier_unavailable — also without fetching.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { CAPS } = require('../auth');

function checksRouter({ registry, check, observations, auth, limits }) {
    const router = express.Router();
    const read = [auth.requireCap(CAPS.observations), limits.reads('watch.read')];
    const runNow = [auth.requireCap(CAPS.run), limits.budget('watch.check.run')];

    const notFound = (res, req) => http.sendProblem(res, 404, 'watch.not_found', { detail: 'no such watch', ctx: req.ov });
    const before = (q) => (/^\d{1,18}$/.test(String(q || '')) ? Number(q) : null);
    const pageLimit = (q, d = 50, max = 200) => Math.min(Math.max(parseInt(q, 10) || d, 1), max);

    /** The watch must exist and belong to the acting subject before anything else happens. */
    const owned = async (req, res) => {
        const row = await registry.get(req.params.id, req.principal);
        if (!row) { notFound(res, req); return null; }
        return row;
    };

    router.post('/api/v1/watches/:id/check', runNow, async (req, res) => {
        const row = await owned(req, res);
        if (!row) return;
        const out = await check.run(row.id, { trigger: 'manual' });
        if (!out) return notFound(res, req);
        if (out.busy) return http.sendProblem(res, 409, 'watch.busy', { detail: 'a check of this watch is already running', ctx: req.ov });
        if (out.disabled) return http.sendProblem(res, 409, 'watch.disabled', { detail: `the watch is ${row.status}: resume it first`, ctx: req.ov });
        if (out.unavailable) return http.sendProblem(res, 422, out.unavailable.code, { detail: out.unavailable.detail, ctx: req.ov });
        return res.json(check.runView(out.run));
    });

    router.get('/api/v1/watches/:id/observations', read, async (req, res) => {
        const row = await owned(req, res);
        if (!row) return;
        const limit = pageLimit(req.query.limit);
        const rows = await observations.list(row.id, { before: before(req.query.before), limit });
        res.json({
            observations: rows.map(observations.view),
            next_before: rows.length === limit ? rows[rows.length - 1].rid : null,
        });
    });

    router.get('/api/v1/watches/:id/checks', read, async (req, res) => {
        const row = await owned(req, res);
        if (!row) return;
        const limit = pageLimit(req.query.limit);
        const rows = await check.list(row.id, { before: before(req.query.before), limit });
        res.json({
            checks: rows.map(check.runView),
            next_before: rows.length === limit ? rows[rows.length - 1].rid : null,
        });
    });

    return router;
}

module.exports = { checksRouter };
