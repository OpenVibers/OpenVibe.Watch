'use strict';
/**
 * The codes-run action (plan T18 actions, T16): a coding task on OpenVibe.Codes for the watch's owner, run on the
 * owner's own machine (openvibe.codes/run through OpenVibe.Run).
 *
 *   const codes = createCodesTasks(client, { baseUrl });   // client: openvibe-sdk/core createClient with Watch's token
 *   await codes.start({ subjectId, repo, prompt, idempotencyKey })   → { id, state, url, created }
 *
 * start() POSTs a codes.task-start-request@1 body to Codes (Contracts 0.162 codes.task.start, audience openvibe.codes)
 * with Watch's own token and the owner in X-OV-Subject. Codes starts it in the project of the owner's latest /run task,
 * shows Watch only the tasks Watch started, and lists it on the owner's /run page. The idempotency key makes a retried
 * delivery the same task. The call is made once; the action worker retries on its own backoff. Refusals arrive as
 * openvibe-sdk OpenVibeError (status, code).
 */

function createCodesTasks(client, { baseUrl }) {
    async function start({ subjectId, repo, prompt, idempotencyKey }) {
        const out = await client.json({
            service: 'codes', baseUrl, audience: 'openvibe.codes', method: 'POST', path: '/api/v1/tasks',
            headers: { 'X-OV-Subject': subjectId }, json: { repo, prompt, idempotency_key: idempotencyKey },
            retries: 0, idempotencyKey: false,
        });
        const t = (out && out.task) || {};
        return { id: t.id || null, state: t.state || null, url: t.url || null, created: !!(out && out.created) };
    }
    return { start };
}

module.exports = { createCodesTasks };
