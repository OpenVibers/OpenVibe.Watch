'use strict';
/**
 * OpenVibe.Actor, for a watch's actor-task and actor-agent actions: run work FOR the watch's owner.
 *
 *   const actor = createActorTasks(client, { baseUrl });       // client: openvibe-sdk/core createClient with Watch's token
 *   await actor.create({ subjectId, task, budgetUsd, idempotencyKey })  → { id, state }
 *   await actor.runAgent({ subjectId, agentId, input })                 → { id, state }
 *
 * POST <actor>/api/v1/tasks with Watch's own token (actor.task.create, audience openvibe.actor), or
 * POST <actor>/api/v1/me/agents/:agentId/run (actor.agent.run), with the owner in
 * X-OV-Subject: Actor makes the task the person's (their allowance, their daily budget, their task list) and records
 * Watch as `via` (Actor#25). The idempotency key makes a retried delivery the same task, never a second one. The call
 * is made once; the action worker retries on its own backoff. Actor's refusals arrive as openvibe-sdk OpenVibeError
 * (status, code).
 */

function createActorTasks(client, { baseUrl }) {
    const post = (path, subjectId, json) => client.json({
        service: 'actor', baseUrl, audience: 'openvibe.actor', method: 'POST', path,
        headers: { 'X-OV-Subject': subjectId }, json, retries: 0, idempotencyKey: false,
    });
    async function create({ subjectId, task, budgetUsd = null, idempotencyKey }) {
        const json = { task, idempotency_key: idempotencyKey, ...(budgetUsd == null ? {} : { budget: { per_task_usd: budgetUsd } }) };
        const out = await post('/api/v1/tasks', subjectId, json);
        return { id: out && out.id, state: out && out.state };
    }
    async function runAgent({ subjectId, agentId, input }) {
        const out = await post(`/api/v1/me/agents/${encodeURIComponent(agentId)}/run`, subjectId, { input });
        return { id: out && (out.task_id || (out.task && out.task.id) || out.id), state: out && out.state };
    }
    return { create, runAgent };
}

module.exports = { createActorTasks };
