'use strict';
/**
 * Project delegation (ADR-003 amendment 2026-10-12), for a watch that names a project: Watch acts for the watch's owner
 * inside that project.
 *
 *   const projects = createProjects(client, { networkUrl });   // client: openvibe-sdk/core createClient with Watch's token
 *   await projects.check(projectId, subjectId)   → { ok } (an admin or owner of the unarchived project), throws when Network cannot answer
 *
 *   const run = createRunJobs(client, { baseUrl });
 *   await run.submit({ subjectId, projectId, job, idempotencyKey })   → { id, state, created }
 *
 * check() reads the person's membership from Network (GET /internal/projects/:project/members/:subject, capability
 * network.project.member.read) when a watch is saved with a project. It is a courtesy to the person, who learns at
 * once that they cannot use that project; OpenVibe.Run asks Network again before every job, which is the check that
 * counts. submit() POSTs a run.job-create-request@1 body to Run with Watch's own token (run.job.submit, audience
 * openvibe.run), the owner in X-OV-Subject and the project in X-OV-Project: the job is billed to the project, the
 * person is its requester and Run records Watch as via. The call is made once; the action worker retries on its own
 * backoff. Refusals arrive as openvibe-sdk OpenVibeError (status, code).
 */

const ADMIN_ROLES = new Set(['admin', 'owner']);

function createProjects(client, { networkUrl }) {
    async function check(projectId, subjectId) {
        let out;
        try {
            out = await client.json({
                service: 'network', baseUrl: networkUrl, audience: 'openvibe.network', method: 'GET',
                path: `/internal/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(subjectId)}`, retries: 0,
            });
        } catch (err) {
            if (err && err.status === 404) return { ok: false };
            throw err;
        }
        const ok = !!out && out.project_id === projectId && out.subject === subjectId && ADMIN_ROLES.has(out.role) && out.archived === false;
        return { ok };
    }
    return { check };
}

function createRunJobs(client, { baseUrl }) {
    async function submit({ subjectId, projectId, job, idempotencyKey }) {
        const out = await client.json({
            service: 'run', baseUrl, audience: 'openvibe.run', method: 'POST', path: '/api/v1/jobs',
            headers: { 'X-OV-Subject': subjectId, 'X-OV-Project': projectId }, json: { ...job, idempotency_key: idempotencyKey },
            retries: 0, idempotencyKey: false,
        });
        const j = (out && out.job) || {};
        return { id: j.id || null, state: j.state || null, created: !!(out && out.created) };
    }
    return { submit };
}

module.exports = { createProjects, createRunJobs, ADMIN_ROLES };
