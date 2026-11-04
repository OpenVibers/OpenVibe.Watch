'use strict';
/**
 * Provider-rate evidence API (plan P6; only mounted when WATCH_PROVIDER_RATES=1, off by default).
 *
 *   watch.watch.read
 *     GET  /api/v1/provider-rates                          the two sources, their health and the pending count
 *     GET  /api/v1/provider-rates/sources
 *     GET  /api/v1/provider-rates/sources/:key
 *     GET  /api/v1/provider-rates/observations?latest=&source=&model=&token_class=&before=&limit=
 *     GET  /api/v1/provider-rates/changes?state=&source=&before=&limit=
 *     GET  /api/v1/provider-rates/changes/:id
 *   watch.watch.manage
 *     PATCH /api/v1/provider-rates/sources/:key          {enabled} — a person enables a source a person reviewed
 *     POST  /api/v1/provider-rates/changes/:id/approve   {note?} — a PERSON approves; records evidence only
 *     POST  /api/v1/provider-rates/changes/:id/reject    {note?}
 *   watch.check.run
 *     POST  /api/v1/provider-rates/sources/:key/refresh  fetch one source now (same code the worker runs)
 *
 * No route writes a rate card. An approval answers `applied: false`: OpenVibe.AI's operator applies the approved
 * observation to the catalog's supply rate card through AI's own path, so Watch never becomes a second authority.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { CAPS } = require('../auth');

const STATES = ['pending', 'approved', 'rejected'];

function providerRatesRouter({ providerRates, auth, limits }) {
    const router = express.Router();
    // Owner settings (D11): the module is always constructed now, so the switch is read live. Off, its routes are
    // the API's ordinary 404 and no source row is written; the first enabled request seeds the two sources.
    router.use(async (req, res, next) => {
        if (!providerRates.enabled) return next('router');
        try { await providerRates.init(); next(); } catch (err) { next(err); }
    });
    const read = [auth.requireCap(CAPS.read), limits.reads('watch.read')];
    const manage = [auth.requireCap(CAPS.manage), limits.budget('watch.write')];
    const runNow = [auth.requireCap(CAPS.run), limits.budget('watch.check.run')];

    const notFound = (res, req, what = 'provider-rate source') => http.sendProblem(res, 404, 'watch.rate_not_found', { detail: `no such ${what}`, ctx: req.ov });
    const pageLimit = (q, d = 100, max = 500) => Math.min(Math.max(parseInt(q, 10) || d, 1), max);
    const before = (q) => (/^\d{1,18}$/.test(String(q || '')) ? Number(q) : null);

    /** A decision is a person's: a service or an agent may watch and fetch, never approve. */
    function personOnly(req, res, next) {
        if (!req.principal || req.principal.kind !== 'person' || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(req.principal.sub || ''))) {
            return http.sendProblem(res, 403, 'watch.rate_person_only', {
                detail: 'a person approves or rejects a provider-rate change; a service or an agent may not', ctx: req.ov,
            });
        }
        next();
    }

    function noteOf(body) {
        if (body === undefined || body === null || body === '') return null;
        if (typeof body !== 'object' || Array.isArray(body)) return { error: 'the body must be an object with an optional note' };
        for (const k of Object.keys(body)) if (k !== 'note') return { error: `unknown field ${k}` };
        if (body.note === undefined || body.note === null) return { note: null };
        if (typeof body.note !== 'string' || body.note.length > 2000) return { error: 'note must be a string of at most 2000 characters' };
        return { note: body.note || null };
    }

    router.get('/api/v1/provider-rates', read, async (req, res) => {
        const rows = await providerRates.sources();
        res.json({
            sources: rows.map((r) => providerRates.sourceView(r)),
            pending_changes: await providerRates.pendingCount(),
        });
    });

    router.get('/api/v1/provider-rates/sources', read, async (req, res) => {
        res.json({ sources: (await providerRates.sources()).map((r) => providerRates.sourceView(r)) });
    });

    router.get('/api/v1/provider-rates/sources/:key', read, async (req, res) => {
        const row = await providerRates.source(req.params.key);
        if (!row) return notFound(res, req);
        res.json({ source: providerRates.sourceView(row) });
    });

    router.patch('/api/v1/provider-rates/sources/:key', manage, async (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return http.sendProblem(res, 422, 'watch.rate_invalid', { detail: 'body must be an object with enabled', ctx: req.ov });
        }
        for (const k of Object.keys(body)) {
            if (k !== 'enabled') return http.sendProblem(res, 422, 'watch.rate_invalid', { detail: `unknown field ${k}`, ctx: req.ov });
        }
        try {
            const row = await providerRates.setEnabled(req.params.key, body.enabled, req.principal);
            if (!row) return notFound(res, req);
            res.json({ source: providerRates.sourceView(row) });
        } catch (err) {
            if (err && err.code === 'watch.rate_invalid') return http.sendProblem(res, 422, err.code, { detail: err.message, ctx: req.ov });
            throw err;
        }
    });

    router.get('/api/v1/provider-rates/observations', read, async (req, res) => {
        const limit = pageLimit(req.query.limit);
        const latest = ['1', 'true'].includes(String(req.query.latest || ''));
        const rows = await providerRates.observations({
            latest,
            source: req.query.source ? String(req.query.source) : null,
            model: req.query.model ? String(req.query.model) : null,
            tokenClass: req.query.token_class ? String(req.query.token_class) : null,
            before: before(req.query.before),
            limit,
        });
        res.json({
            observations: rows.map(providerRates.observationView),
            next_before: !latest && rows.length === limit ? rows[rows.length - 1].rid : null,
        });
    });

    router.get('/api/v1/provider-rates/changes', read, async (req, res) => {
        const state = req.query.state ? String(req.query.state) : null;
        if (state && !STATES.includes(state)) {
            return http.sendProblem(res, 400, 'watch.rate_bad_query', { detail: `state must be ${STATES.join('|')}`, ctx: req.ov });
        }
        const limit = pageLimit(req.query.limit);
        const rows = await providerRates.changes({
            state, source: req.query.source ? String(req.query.source) : null, before: before(req.query.before), limit,
        });
        res.json({ changes: rows.map(providerRates.changeView), next_before: rows.length === limit ? rows[rows.length - 1].rid : null });
    });

    router.get('/api/v1/provider-rates/changes/:id', read, async (req, res) => {
        const row = await providerRates.change(req.params.id);
        if (!row) return notFound(res, req, 'rate change');
        res.json({ change: providerRates.changeView(row) });
    });

    router.post('/api/v1/provider-rates/sources/:key/refresh', runNow, async (req, res) => {
        const out = await providerRates.fetchNow(req.params.key, { trigger: 'manual' });
        if (!out) return notFound(res, req);
        if (out.busy) return http.sendProblem(res, 409, 'watch.rate_busy', { detail: 'a fetch of this source is already running', ctx: req.ov });
        if (out.disabled) return http.sendProblem(res, 409, 'watch.rate_disabled', { detail: 'the source is disabled: enable it first', ctx: req.ov });
        if (out.unavailable) return http.sendProblem(res, 422, 'watch.rate_unavailable', { detail: out.unavailable, ctx: req.ov });
        res.json(out);
    });

    /** Approve or reject one pending change. Both are the same decision path; only the state and event type differ. */
    function decision(choice) {
        return async (req, res) => {
            const body = noteOf(req.body);
            if (body.error) return http.sendProblem(res, 422, 'watch.rate_invalid', { detail: body.error, ctx: req.ov });
            try {
                const out = await providerRates.decide(req.params.id, choice, req.principal, { note: body.note });
                if (!out) return notFound(res, req, 'rate change');
                if (out.conflict) {
                    return http.sendProblem(res, 409, 'watch.rate_decided', {
                        detail: `this change was already ${out.conflict}`, ctx: req.ov,
                    });
                }
                res.json(out);
            } catch (err) {
                if (err && err.code === 'watch.rate_decided') return http.sendProblem(res, 409, err.code, { detail: err.message, ctx: req.ov });
                if (err && err.code === 'watch.rate_person_only') return http.sendProblem(res, 403, err.code, { detail: err.message, ctx: req.ov });
                if (err && err.code === 'watch.rate_invalid') return http.sendProblem(res, 422, err.code, { detail: err.message, ctx: req.ov });
                throw err;
            }
        };
    }

    router.post('/api/v1/provider-rates/changes/:id/approve', manage, personOnly, decision('approved'));
    router.post('/api/v1/provider-rates/changes/:id/reject', manage, personOnly, decision('rejected'));

    return router;
}

module.exports = { providerRatesRouter };
