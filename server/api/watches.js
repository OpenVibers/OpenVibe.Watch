'use strict';
/**
 * The watch registry API (one capability per route; every answer is scoped to the acting subject).
 *
 *   watch.watch.read
 *     GET    /api/v1/watches?status=&project_id=&before=&limit=   the acting subject's watches
 *     GET    /api/v1/watches/:id
 *   watch.watch.manage
 *     POST   /api/v1/watches              create (source, extraction, condition and action required)
 *     PATCH  /api/v1/watches/:id          change fields; pause/resume through status
 *     POST   /api/v1/watches/:id/pause    status = paused
 *     POST   /api/v1/watches/:id/resume   status = active (and re-armed)
 *     DELETE /api/v1/watches/:id          soft delete (observations stay resolvable)
 *
 * Another owner's watch is 404, never 403: an id must not confirm that someone else's watch exists.
 * Errors are problem+json (http.sendProblem): watch.not_found, watch.invalid (422 from the released
 * watch.watch-request@1 validator), watch.exists (409, never used by this route shaping but kept
 * for the same shape as Sources), and the per-actor limit's 429.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { CAPS } = require('../auth');
const { RegistryError, STATUSES } = require('../registry');

function watchesRouter({ registry, auth, limits }) {
    const router = express.Router();
    const read = [auth.requireCap(CAPS.read), limits.reads('watch.read')];
    const manage = [auth.requireCap(CAPS.manage), limits.budget('watch.write')];

    const fail = (res, req, err) => {
        if (err instanceof RegistryError) {
            const status = err.code === 'watch.internal' ? 500 : (err.code === 'watch.exists' ? 409 : 422);
            return http.sendProblem(res, status, err.code, { detail: err.message, ctx: req.ov });
        }
        throw err;
    };
    const notFound = (res, req) => http.sendProblem(res, 404, 'watch.not_found', { detail: 'no such watch', ctx: req.ov });

    router.get('/api/v1/watches', read, async (req, res) => {
        const status = req.query.status ? String(req.query.status) : null;
        if (status && !STATUSES.includes(status)) {
            return http.sendProblem(res, 400, 'watch.bad_query', { detail: `status must be one of ${STATUSES.join('|')}`, ctx: req.ov });
        }
        const before = /^wch_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const rows = await registry.all(req.principal, {
            status,
            project_id: req.query.project_id ? String(req.query.project_id) : null,
            before,
            limit,
        });
        // The answer is exactly watch.watch-result@1 ("{ watches }"), so the page cursor is the last
        // watch's own id: `GET /api/v1/watches?before=<that id>` is the next page (wch_ ids are ULIDs,
        // i.e. creation order).
        res.json({ watches: rows.map(registry.view) });
    });

    router.get('/api/v1/watches/:id', read, async (req, res) => {
        const row = await registry.get(req.params.id, req.principal);
        if (!row) return notFound(res, req);
        res.json({ watch: registry.view(row) });
    });

    router.post('/api/v1/watches', manage, async (req, res) => {
        try {
            const row = await registry.create(req.body, req.principal);
            res.status(201).json({ watch: registry.view(row) });
        } catch (err) { fail(res, req, err); }
    });

    router.patch('/api/v1/watches/:id', manage, async (req, res) => {
        try {
            const row = await registry.patch(req.params.id, req.body, req.principal);
            if (!row) return notFound(res, req);
            res.json({ watch: registry.view(row) });
        } catch (err) { fail(res, req, err); }
    });

    /** pause/resume are the two status changes a person makes by name. */
    const setStatus = (status) => async (req, res) => {
        try {
            const row = await registry.patch(req.params.id, { status }, req.principal);
            if (!row) return notFound(res, req);
            res.json({ id: row.id, status: row.status });
        } catch (err) { fail(res, req, err); }
    };
    router.post('/api/v1/watches/:id/pause', manage, setStatus('paused'));
    router.post('/api/v1/watches/:id/resume', manage, setStatus('active'));

    router.delete('/api/v1/watches/:id', manage, async (req, res) => {
        try {
            const out = await registry.remove(req.params.id, req.principal);
            if (!out) return notFound(res, req);
            res.json(out);
        } catch (err) { fail(res, req, err); }
    });

    return router;
}

module.exports = { watchesRouter };
