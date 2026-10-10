'use strict';
/** Watch's authority resource index (ADR-048): non-deleted watches for OpenVibe.Services. */
const express = require('express');
const contracts = require('openvibe-contracts');

const SERVICE = 'watch';
const KIND = 'watch.watch';
const CAPABILITY = 'watch.resource.read';
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Only the public fields allowed by common.resource-summary@1 leave this table. */
function watchSummary(row) {
    const summary = {
        id: row.id, kind: KIND, service: SERVICE,
        ...(PROJECT_ID_RE.test(String(row.project_id || '')) ? { project_id: row.project_id } : {}),
        ...(USER_SUBJECT_RE.test(String(row.owner_sub || '')) ? { owner: { type: 'user', id: row.owner_sub } } : {}),
        name: row.name, state: row.status,
        created_at: new Date(Number(row.created_at)).toISOString(),
        updated_at: new Date(Number(row.updated_at)).toISOString(),
    };
    const ovrn = contracts.resources.nameOf(summary);
    return ovrn ? { ...summary, ovrn } : summary;
}

/** Host's opaque [kind, id] cursor shape, with the id as the keyset position. */
const encodeCursor = (id) => Buffer.from(JSON.stringify([KIND, id])).toString('base64url');
function decodeCursor(raw) {
    let value;
    try { value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(value) && value.length === 2 && value[0] === KIND &&
        typeof value[1] === 'string' && /^wch_[0-9A-HJKMNP-TV-Z]{26}$/.test(value[1]) ? value[1] : null;
}

function filtersOf(query) {
    const project = typeof query.project === 'string' && query.project !== '' ? query.project : null;
    if (project && !PROJECT_ID_RE.test(project)) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) {
            return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        }
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, limit, cursor };
}

function resourceIndexRouter({ db, auth }) {
    const router = express.Router();
    const guard = auth.requireCap(CAPABILITY);
    // requireCap verifies the token and its capability. Person tokens can pass other Watch guards,
    // so this first-party index also checks the verified principal after the shared guard.
    const firstParty = (req, res, next) => {
        if (req.principal.kind === 'service' && /^svc:/.test(req.principal.sub)) return next();
        return contracts.http.sendProblem(res, 403, 'capability.denied', {
            detail: `${CAPABILITY} is first-party and not granted to this principal`, ctx: req.ov,
        });
    };
    const bad = (req, res, detail) => contracts.http.sendProblem(res, 400, 'resources.bad_query', { detail, ctx: req.ov });
    const unknown = (req, res, name) => contracts.http.sendProblem(res, 404, 'resources.unknown_resource', {
        detail: `no resource named ${name}`, ctx: req.ov,
    });

    router.get('/api/v1/resources', guard, firstParty, async (req, res) => {
        const filters = filtersOf(req.query);
        if (filters.error) return bad(req, res, filters.error);
        if (filters.kind && filters.kind !== KIND) return res.json({ resources: [], next_cursor: null });
        const clauses = ['deleted_at IS NULL'];
        const args = [];
        if (filters.project) { clauses.push('project_id = ?'); args.push(filters.project); }
        if (filters.cursor) { clauses.push('id > ?'); args.push(filters.cursor); }
        args.push(filters.limit + 1);
        const rows = await db.prepare(`SELECT id, project_id, owner_sub, name, status, created_at, updated_at
            FROM watches WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`).all(...args);
        const resources = rows.slice(0, filters.limit).map(watchSummary);
        const next_cursor = rows.length > filters.limit ? encodeCursor(resources[resources.length - 1].id) : null;
        return res.json({ resources, next_cursor });
    });

    router.get('/api/v1/resources/:ovrn', guard, firstParty, async (req, res) => {
        const name = String(req.params.ovrn);
        const parsed = contracts.resources.parse(name);
        if (!parsed || parsed.service !== SERVICE || parsed.type !== 'watch') return unknown(req, res, name);
        const row = await db.prepare(`SELECT id, project_id, owner_sub, name, status, created_at, updated_at
            FROM watches WHERE id = ? AND deleted_at IS NULL`).get(parsed.id);
        const summary = row && watchSummary(row);
        if (!summary || summary.ovrn !== name) return unknown(req, res, name);
        return res.json(summary);
    });

    return router;
}

module.exports = { resourceIndexRouter, watchSummary, filtersOf, encodeCursor, SERVICE, KIND, CAPABILITY, DEFAULT_LIMIT, MAX_LIMIT };
