'use strict';
/**
 * The agent's step (design 2026-11-07): OpenVibe.Watch publishes a watch as one step of the agent's timeline —
 * agent.step.started when it is waiting for its next check, agent.step.updated when a check settles, and
 * agent.step.ended when the watch stops. The payload is a title, an outcome and a link: never the page's body,
 * the condition's value or the watch's own source payload.
 *
 * One watch is one step (step_id is the watch's wch_ id), so a watch that checks every few minutes does not fill
 * the Dock with one entry per check; each check brings the same entry forward.
 */
const { envelope } = require('./envelope');

const AGENT_TOPICS = Object.freeze({
    started: 'agent.step.started',
    updated: 'agent.step.updated',
    ended: 'agent.step.ended',
});

const PERSON_OWNER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS_OPEN = 'waiting';
const WHERE = 'On the network';
const WHY = 'it checks the page from our side, on your schedule, and only tells you when it changes';

/** One watch → the agent's step: its name, its state and its page. Never the page, the value or the condition. */
function agentStepOf(watch, { status = STATUS_OPEN, startedAt = null, endedAt = null, reason = null, costUsd = null, baseUrl = 'https://openvibe.watch', transition = null } = {}) {
    const id = watch.id;
    const base = String(baseUrl || 'https://openvibe.watch').replace(/\/+$/, '');
    return {
        step_id: id,
        mode: 'watch',
        product: 'watch',
        ref: id,
        title: `Watching ${watch.name || 'a page'}`,
        status,
        started_at: new Date(startedAt == null ? Date.now() : startedAt).toISOString(),
        ended_at: status === 'waiting' ? null : (endedAt == null ? null : new Date(endedAt).toISOString()),
        placement: { where: WHERE, why: WHY },
        cost_usd: typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null,
        link: `${base}/watches/${encodeURIComponent(id)}`,
        reason: status === 'failed' || status === 'stopped' ? (reason == null ? null : String(reason).slice(0, 240)) : null,
        // The orchestrating mode's sentence when it hands over to the watch ("Waiting for CI on #167 (Watch, 4 min)…"),
        // when it gives us one; a check's own update keeps it out of the sentence.
        transition: transition == null ? null : String(transition).slice(0, 240),
    };
}

/**
 * Write the watch's agent step, in the caller's transaction (the same one as the watch change). A watch owned by
 * an agent (agt_…) or a service has no person to show it to and publishes nothing.
 */
async function emitAgentStep(outbox, watch, { topic, now = () => Date.now(), ...rest } = {}) {
    const owner = watch && (watch.owner_sub || watch.owner);
    if (!outbox || !watch || !PERSON_OWNER.test(String(owner || ''))) return null;
    const event_type = AGENT_TOPICS[topic];
    if (!event_type) return null;
    return await outbox.emit(envelope({
        event_type,
        actor: { type: 'user', id: owner },
        subject: { type: 'user', id: owner },
        visibility: 'internal',
        priority: topic === 'ended' ? 'important' : 'low',
        payload: agentStepOf(watch, rest),
    }, 'watch', now));
}

module.exports = { AGENT_TOPICS, agentStepOf, emitAgentStep, PERSON_OWNER, STATUS_OPEN };
