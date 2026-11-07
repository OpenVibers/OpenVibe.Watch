'use strict';
/**
 * The agent's step (design 2026-11-07): a watch is one step of the agent's timeline — waiting for its next check,
 * failed with the one-line reason, or stopped when the watch is paused or deleted. The payload is a title, an
 * outcome and a link: never the page's body, the value it extracted or the condition it compares.
 *
 *   node test/agent-step.test.js
 */
const assert = require('assert');
const { AGENT_TOPICS, agentStepOf, emitAgentStep } = require('../server/events/agent-step');
const FIXTURE = require('./fixtures/watch-agent-step.json');

const WATCH = {
    id: 'wch_01JAB2C3D4E5F6G7H8J9K0MNPS', name: 'Shoe price', owner_sub: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS', status: 'active',
    source: { kind: 'page', url: 'https://shop.example/private-page' },
    condition: { kind: 'changed' }, extraction: { kind: 'text', selector: '#price' },
};

assert.strictEqual(AGENT_TOPICS.started, 'agent.step.started');
assert.strictEqual(AGENT_TOPICS.updated, 'agent.step.updated');
assert.strictEqual(AGENT_TOPICS.ended, 'agent.step.ended');

const waiting = agentStepOf(WATCH, { status: 'waiting', startedAt: 1762000000000, baseUrl: 'https://openvibe.watch' });
assert.strictEqual(waiting.step_id, WATCH.id);
assert.strictEqual(waiting.mode, 'watch');
assert.strictEqual(waiting.product, 'watch');
assert.strictEqual(waiting.status, 'waiting');
assert.strictEqual(waiting.title, 'Watching Shoe price');
assert.strictEqual(waiting.link, `https://openvibe.watch/watches/${WATCH.id}`);
assert.strictEqual(waiting.ended_at, null, 'a waiting watch has not ended');
assert.ok(waiting.placement && waiting.placement.where && waiting.placement.why);
const raw = JSON.stringify(waiting);
assert.ok(!raw.includes('shop.example/private-page'), 'the page never travels');
assert.ok(!raw.includes('private-page'), 'not even a piece of it');
assert.ok(!raw.includes('"changed"'), 'the condition never travels');
assert.ok(!('source' in waiting) && !('condition' in waiting) && !('extraction' in waiting), 'no field for the page or the condition');

const failed = agentStepOf(WATCH, { status: 'failed', startedAt: 1762000000000, endedAt: 1762000005000, reason: 'the page answered 500', costUsd: 0.001 });
assert.strictEqual(failed.status, 'failed');
assert.strictEqual(failed.reason, 'the page answered 500');
assert.ok(failed.ended_at, 'a failed check says when it ended');
assert.strictEqual(failed.cost_usd, 0.001);

const stopped = agentStepOf(WATCH, { status: 'stopped', startedAt: 1762000000000, endedAt: 1762000010000, reason: 'the watch is paused' });
assert.strictEqual(stopped.status, 'stopped');
assert.strictEqual(stopped.reason, 'the watch is paused');

// The Act step that waits on CI hands over to Watch: this fixture is the payload Agent's timeline test replays.
assert.deepStrictEqual(agentStepOf({ id: FIXTURE.step_id, name: '#167 CI', owner_sub: WATCH.owner_sub }, {
    status: 'waiting', startedAt: Date.parse(FIXTURE.started_at), transition: FIXTURE.transition,
}), FIXTURE, 'the fixture the Actor transition test uses is exactly what this emitter writes');

(async () => {
    const rows = [];
    const outbox = { emit: async (env) => { rows.push(env); return env; } };
    await emitAgentStep(outbox, WATCH, { topic: 'started', status: 'waiting', startedAt: 1762000000000, now: () => 1762000000000 });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].event_type, 'agent.step.started');
    assert.strictEqual(rows[0].source, 'watch');
    assert.deepStrictEqual(rows[0].subject, { type: 'user', id: WATCH.owner_sub });
    assert.strictEqual(rows[0].visibility, 'internal');
    // An agent's own watch (agt_) has no person to show it to.
    await emitAgentStep(outbox, { ...WATCH, owner_sub: 'agt_01JAB2C3D4E5F6G7H8J9K0MNPS' }, { topic: 'started', status: 'waiting' });
    assert.strictEqual(rows.length, 1, 'an agent-owned watch publishes no person\'s step');
    console.log('watch agent step: one watch, one waiting step — never the page, the value or the condition');
    console.log('all passed');
})().catch((err) => { console.error(err); process.exit(1); });
