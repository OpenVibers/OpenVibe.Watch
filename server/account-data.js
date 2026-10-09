'use strict';

/**
 * Account export and deletion → Watch (ADR-033; openvibe-sdk/account-data). What Watch holds about a person:
 *
 *   watches       their watches (owner_sub), with everything that hangs under a watch: its check runs, observations
 *                 and conditional-GET state. Exported (the watch definitions, and how many checks and observations
 *                 each has) and deleted whole.
 *   web_sessions  their sign-in sessions on openvibe.watch (hashed cookie tokens): deleted, never exported.
 *
 * The watches go in extraErase, not the table map: their rows are found by watch id, so the children go first.
 * updated_by on someone else's watch (a staff edit) becomes NULL. No secret is exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'web_sessions', subject: 'subject', file: null },
    { table: 'watches', subject: 'updated_by', file: null, erase: { anonymize: {} } },
];

async function extraExport(db, subject) {
    const watches = await db.many(`SELECT w.id, w.project_id, w.name, w.status, w.source, w.cadence, w.extraction, w.comparison, w.condition,
            w.action, w.budget, w.retention, w.labels, w.last_check_at, w.last_success_at, w.last_state, w.created_at, w.updated_at, w.deleted_at,
            (SELECT count(*)::int FROM check_runs c WHERE c.watch_id = w.id) AS check_runs,
            (SELECT count(*)::int FROM observations o WHERE o.watch_id = w.id) AS observations
        FROM watches w WHERE w.owner_sub = $1 ORDER BY w.created_at DESC LIMIT 5000`, [subject]);
    return watches.length ? [{ name: 'watches.json', content: watches }] : [];
}

async function extraErase(t, subjects, counts) {
    const mine = '(SELECT id FROM watches WHERE owner_sub = ANY($1::text[]))';
    counts.add(counts.erased, 'observations', await t.exec(`DELETE FROM observations WHERE watch_id IN ${mine}`, [subjects]));
    counts.add(counts.erased, 'check_runs', await t.exec(`DELETE FROM check_runs WHERE watch_id IN ${mine}`, [subjects]));
    counts.add(counts.erased, 'watch_endpoint_state', await t.exec(`DELETE FROM watch_endpoint_state WHERE watch_id IN ${mine}`, [subjects]));
    counts.add(counts.erased, 'watches', await t.exec('DELETE FROM watches WHERE owner_sub = ANY($1::text[])', [subjects]));
}

/** The account-data handle for Watch's database (server/db.js). */
function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'watch', tables: TABLES, extraExport, extraErase, log });
}

module.exports = { create, TABLES, TOPICS };
