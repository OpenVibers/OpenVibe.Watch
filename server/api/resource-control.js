'use strict';
/**
 * Watch's control API (ADR-048, plan T13 step 10): POST /api/v1/resources/control — one
 * common.resource-control-request@1 from a first-party service (OpenVibe.Services) holding watch.resource.control,
 * acting for the person in on_behalf_of, on a watch.watch named by its OVRN. The answer is a
 * common.resource-control-result@1 (200 for every outcome; a malformed request is a 400 problem).
 *
 *   suspend   pause the watch: nothing is checked until it resumes        (registry.patch → watch.watch.paused)
 *   resume    make a paused watch active again                             (registry.patch → watch.watch.updated)
 *   delete    remove it, exactly as DELETE /api/v1/watches/:id does        (registry.remove → watch.watch.removed)
 *
 * Any other action is refused `control.unsupported_action`. Only the watch's owner may act on it (on_behalf_of names
 * them; a watch of another person is refused as not found, never confirmed to exist), and only inside the project the
 * OVRN names. `dry_run` decides and explains without applying. The first answer per (caller, project,
 * idempotency_key) is kept in watch_control_log and returned for a repeat; the same key with another request is
 * refused `control.idempotency_conflict`.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');

const SERVICE = 'watch';
const CAPABILITY = 'watch.resource.control';
const ACTIONS = { suspend: 'paused', resume: 'active' };
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const digestOf = (request) => crypto.createHash('sha256')
    .update(canonical({ ...request, idempotency_key: undefined, confirmation_id: undefined, trace_id: undefined })).digest('hex');

function resourceControlRouter({ db, auth, registry, now = () => Date.now() }) {
    const router = express.Router();
    const guard = auth.requireCap(CAPABILITY);
    const json = express.json({ limit: '16kb' });
    const iso = () => new Date(now()).toISOString();
    const result = (request, state, extra = {}) => ({ action: request.action, ...(request.resource ? { resource: request.resource } : {}), state, at: iso(), ...extra });
    const problem = (status, code, detail) => ({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail });

    async function decide(request, principal) {
        const parsed = contracts.resources.parse(request.resource || '');
        if (!parsed || parsed.service !== SERVICE || parsed.type !== 'watch') {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no watch named ${request.resource || request.resource_kind}`) });
        }
        if (!(request.action in ACTIONS) && request.action !== 'delete') {
            return result(request, 'refused', { problem: problem(422, 'control.unsupported_action', `a watch takes suspend, resume and delete, not ${request.action}`) });
        }
        const person = request.on_behalf_of;
        if (!person || person.type !== 'user' || !USER_SUBJECT_RE.test(String(person.id || ''))) {
            return result(request, 'refused', { problem: problem(403, 'control.no_person', 'on_behalf_of must name the person who owns the watch') });
        }
        const owner = { subject: person.id };
        const row = await registry.get(parsed.id, owner);
        if (!row || row.deleted_at || row.project_id !== parsed.project_id || parsed.project_id !== request.project_id) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no watch named ${request.resource} of this person in this project`) });
        }
        if (request.action === 'delete') {
            if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: 'delete the watch' } });
            await registry.remove(row.id, owner);
            return result(request, 'done', { result: { deleted: true } });
        }
        const target = ACTIONS[request.action];
        if (row.status === target) return result(request, 'done', { result: { status: row.status, changed: false } });
        if (request.action === 'resume' && row.status !== 'paused') {
            return result(request, 'refused', { problem: problem(409, 'control.not_paused', `a ${row.status} watch is not resumed here; edit it on openvibe.watch`) });
        }
        if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: `make the watch ${target}` } });
        const updated = await registry.patch(row.id, { status: target }, owner);
        return result(request, 'done', { result: { status: updated.status, changed: true } });
    }

    router.post('/api/v1/resources/control', guard, json, async (req, res, next) => {
        try {
            if (req.principal.kind !== 'service' || !/^svc:/.test(req.principal.sub)) {
                return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party`, ctx: req.ov });
            }
            const request = req.body;
            const check = contracts.resources.checkControlRequest(request || {});
            if (!check.valid) return contracts.http.sendProblem(res, 400, 'control.bad_request', { detail: JSON.stringify(check.errors).slice(0, 500), ctx: req.ov });
            const caller = req.principal.sub;
            const digest = digestOf(request);
            const seen = await db.prepare('SELECT digest, response FROM watch_control_log WHERE caller = ? AND project_id = ? AND idempotency_key = ?')
                .get(caller, request.project_id, request.idempotency_key);
            if (seen) {
                if (seen.digest !== digest) return contracts.http.sendProblem(res, 409, 'control.idempotency_conflict', { detail: 'this idempotency_key was used for another request', ctx: req.ov });
                return res.json(typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response);
            }
            const answer = await decide(request, req.principal);
            await db.prepare(`INSERT INTO watch_control_log (caller, project_id, idempotency_key, digest, response, created_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(caller, request.project_id, request.idempotency_key, digest, JSON.stringify(answer), now());
            return res.json(answer);
        } catch (err) { return next(err); }
    });

    return router;
}

module.exports = { resourceControlRouter, CAPABILITY, digestOf };
