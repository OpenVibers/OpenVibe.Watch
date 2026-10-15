'use strict';
/**
 * Watch actions (plan T18 step 4): what a fired condition sets in motion.
 *
 *   const actions = createActions({ db, config, notifications, now, log });
 *   await actions.queue({ watch, run, owner, value, previousValue, observedAt })   inside settle()'s transaction
 *   actions.start(); actions.stop(); await actions.tick(); await actions.status(); await actions.recent(watchId)
 *
 * queue() writes one action_runs row per action of the watch, in the SAME transaction as the check run that fired, so
 * a trigger queues each of its actions exactly once (UNIQUE (check_run_id, action_index)) and never without its run.
 *
 * Delivery, by kind:
 *   notification   the owner gets one OpenVibe notification through Network (openvibe-sdk/notifications, type
 *                  WATCH_TRIGGERED): the watch's name, the value and a link to the watch page. A person who switched
 *                  the category off is Network's decision and counts as sent; an owner Network does not know (a
 *                  deleted account) is `skipped`. A refusal retries after 1, 5 and 30 minutes, 2 and 6 hours, then
 *                  `failed`. Network keeps no idempotency record for a push, so a lost answer can repeat one: at least
 *                  once. A watch owned by an agent or a service has no one to notify: `skipped`.
 *   event          `watch.watch.triggered` is emitted with every firing, in the run's own commit, so that action is
 *                  `sent` as it is queued (it needs a person as owner, as the event does). Any other event type is not
 *                  declared in Watch's manifest: `unavailable`.
 *   webhook        a POST of the firing (webhookFor below) to the action's https URL through the SSRF guard
 *                  (server/net/post.js), signed with the key its secret_env names exactly as OpenVibe.Events signs a
 *                  delivery (openvibe-sdk/events signDeliveryHeaders: X-OpenVibe-Timestamp + X-OpenVibe-Signature-V2,
 *                  which a receiver checks with the SDK's verifier). X-OpenVibe-Delivery-Id (`<check run>.<action
 *                  index>`) is the same on every attempt, so a receiver can drop a repeat. 2xx is `sent`. 410 and a URL
 *                  the guard refuses are `failed` at once. Anything else is retried on the same backoff, then `failed`.
 *                  The key must be granted to the watch's owner (WATCH_SECRET_GRANTS, server/secret-grants.js) and
 *                  set (32 characters or more), checked when it is queued and again at delivery: otherwise
 *                  `unavailable`.
 *   actor-task     a task for the owner on OpenVibe.Actor (server/actor.js): the action's brief, with the firing as
 *                  context, under the owner's own allowance (Watch names them in X-OV-Subject; Actor records Watch as
 *                  `via`), at most the action's budget_usd. The idempotency key `watch.<check run>.<action index>`
 *                  makes a retried delivery the same task. Created is `sent` (the task id is recorded). A request
 *                  Actor refuses as invalid (over the tier's budget, an unknown agent) is `failed` at once; anything
 *                  else, including an allowance spent for the day, is retried on the backoff. It needs a person as
 *                  owner: an agent- or service-owned watch is `skipped`.
 *   actor-agent    runs one of the owner's personal agents on Actor with a note and bounded firing context.
 *                  A missing agent or allowance refusal fails this firing; a service error retries.
 *   run-job        one OpenVibe.Run job for the owner in the watch's project (server/run-jobs.js): the action's
 *                  run.job-create-request@1 fields, with the firing under args[firing_arg] when it names one. Watch
 *                  submits as itself, the owner in X-OV-Subject and the project in X-OV-Project (project delegation,
 *                  ADR-003 amendment 2026-10-12), so Run bills the project, checks the owner is still an admin or
 *                  owner of it, makes the owner the requester and records Watch as via. The idempotency key
 *                  `watch.<check run>.<action index>` makes a retried delivery the same job. Created (or the same
 *                  job again) is `sent` with the job id. A refusal that cannot change on a retry (400, 403, 404, 409,
 *                  413, 422: an invalid job, a project the owner may no longer use, over the project's caps) is
 *                  `failed` at once; anything else, Run or Network unreachable included, is retried on the backoff.
 *                  It needs a person as owner and a project: otherwise `skipped` / `unavailable`.
 *   codes-run      a coding task on OpenVibe.Codes for the owner, on the owner's own machine (server/codes-tasks.js):
 *                  the action's brief with the firing as context, in the repository it names. Watch starts it as itself
 *                  with the owner in X-OV-Subject (Contracts 0.162 codes.task.start); the key
 *                  `watch.<check run>.<action index>` makes a retried delivery the same task. Created (or the same task
 *                  again) is `sent` with the task's page. A refusal a retry cannot change (400, 403, 404, 409 — the owner
 *                  has not used openvibe.codes/run yet, codes.no_project — 413, 422) is `failed` at once; anything
 *                  else is retried on the backoff. It needs a person as owner: an agent- or service-owned watch is
 *                  `skipped`.
 *
 * The worker claims due rows with a short lease (FOR UPDATE SKIP LOCKED, next_attempt_at moved past the lease), so
 * two processes never deliver one row at the same time, and a process that dies mid-delivery leaves the row to the
 * next tick after the lease. Without the Network OAuth client secret there is no token to push with: rows wait and
 * status() says delivery is off.
 */

const { SecretRefused } = require('./project-secrets');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_ID = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const LEASE_MS = 2 * 60_000;
const TITLE_MAX = 120;
const MESSAGE_MAX = 300;
const LATER = new Set();
// Run's answers that a retry cannot change: the job is invalid, over the project's caps, or the owner may no longer
// act in the project (403 project.not_delegated / capability.denied).
const RUN_FINAL = new Set([400, 403, 404, 409, 413, 422]);
const JOB_FIELDS = ['class', 'artifact', 'args', 'limits', 'egress', 'ttl_ms'];
const TASK_MAX = 20000;
const TRIGGERED = 'watch.watch.triggered';
const MIN_HOOK_SECRET = 32;
// A URL the guard refuses (server/net/guard.js) will be refused on every attempt: the delivery fails at once.
const REFUSED_URL = new Set(['bad_url', 'port_refused', 'address_refused']);

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A value as a person reads it in one line. */
function valueText(v) {
    if (v == null) return 'no value';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
}

/** The notification a fired watch sends its owner (network.notification-push-request@1 fields). */
function notificationFor({ config, watch, run, action, value, previousValue, observedAt }) {
    const now = valueText(value);
    const before = previousValue === undefined || previousValue === null ? null : valueText(previousValue);
    return {
        type: 'WATCH_TRIGGERED',
        service: 'watch',
        category: action.category || 'service',
        priority: action.priority || 'normal',
        icon: '👁',
        title: clip(`“${watch.name}” fired`, TITLE_MAX),
        message: clip(before !== null && before !== now ? `${now} (was ${before})` : now, MESSAGE_MAX),
        url: `${config.baseUrl}/watches/${encodeURIComponent(watch.id)}`,
        rich_content: { watch_id: watch.id, check_run_id: run.id, observed_at: observedAt ? new Date(observedAt).toISOString() : null },
    };
}

/** The body a webhook action POSTs: the firing, as the watch.watch.triggered event states it. */
function webhookFor({ config, watch, run, value, previousValue, observedAt }) {
    return {
        type: TRIGGERED,
        watch: { id: watch.id, name: watch.name, url: `${config.baseUrl}/watches/${encodeURIComponent(watch.id)}` },
        check_run_id: run.id,
        condition: watch.condition || null,
        observation: {
            observed_at: observedAt ? new Date(observedAt).toISOString() : null,
            value: value === undefined ? null : value,
            previous_value: previousValue === undefined ? null : previousValue,
        },
    };
}

/** The task an actor-task action gives Actor: its brief, then what fired, so the agent knows why it was woken. */
function actorTaskFor({ config, watch, action, value, previousValue, observedAt }) {
    const context = actorContextFor({ config, watch, value, previousValue, observedAt });
    const brief = String(action.brief || '').trim();
    return `${brief.slice(0, TASK_MAX - context.length - 2)}\n\n${context}`;
}

/** A codes-run action's prompt: the brief, then the firing (at most Codes' 8000 characters). */
function codesTaskFor({ config, watch, action, value, previousValue, observedAt }) {
    const context = actorContextFor({ config, watch, value, previousValue, observedAt }, 1500);
    const brief = String(action.brief || '').trim();
    return `${brief.slice(0, 8000 - context.length - 2)}\n\n${context}`;
}

function actorContextFor({ config, watch, value, previousValue, observedAt }, maxLength = Infinity) {
    const now = valueText(value);
    const before = previousValue === undefined || previousValue === null ? null : valueText(previousValue);
    const when = observedAt ? new Date(observedAt).toISOString() : 'just now';
    const first = `Context: your watch “${watch.name}” fired at ${when}.`;
    const last = `Watch: ${config.baseUrl}/watches/${encodeURIComponent(watch.id)}`;
    const valueLine = `Value: ${now}${before !== null && before !== now ? ` (was ${before})` : ''}.`;
    const room = Math.max(0, maxLength - first.length - last.length - 2);
    return [first, valueLine.length > room ? `${valueLine.slice(0, Math.max(0, room - 1))}…` : valueLine, last].join('\n').slice(0, maxLength);
}

/**
 * The run.job-create-request@1 body a run-job action submits (without its idempotency key): the action's job fields,
 * and the firing under args[firing_arg] when the action names one.
 */
function runJobFor({ config, watch, run, action, value, previousValue, observedAt }) {
    const job = {};
    for (const k of JOB_FIELDS) if (action[k] !== undefined && action[k] !== null) job[k] = action[k];
    if (action.firing_arg) {
        job.args = {
            ...(job.args || {}),
            [action.firing_arg]: {
                watch_id: watch.id,
                watch_url: `${config.baseUrl}/watches/${encodeURIComponent(watch.id)}`,
                check_run_id: run.id,
                observed_at: observedAt ? new Date(observedAt).toISOString() : null,
                value: value === undefined ? null : value,
                previous_value: previousValue === undefined ? null : previousValue,
            },
        };
    }
    return job;
}

function actorAgentInputFor(args) {
    const note = typeof args.action.note === 'string' ? args.action.note : '';
    const prefix = note ? `${note}\n\n` : '';
    return prefix + actorContextFor(args, 8000 - prefix.length);
}

function createActions({ db, config, notifications = null, post = null, actor = null, run: runJobs = null, codes = null, projectSecrets = null, now = () => Date.now(), log = console }) {
    // Read at each use, not once: what a process was started with is what it enforces, for rows queued before it too.
    const grants = () => config.secretGrants;
    const enabled = Boolean(notifications) && config.actions.enabled;
    let timer = null;
    let busy = null;

    const st = {
        insert: db.prepare(`INSERT INTO action_runs (watch_id, check_run_id, action_index, kind, owner_sub, request, state, last_error, created_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (check_run_id, action_index) DO NOTHING`),
        claim: db.prepare(`SELECT rid, watch_id, check_run_id, action_index, kind, owner_sub, request, attempts FROM action_runs
            WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, rid LIMIT ? FOR UPDATE SKIP LOCKED`),
        lease: db.prepare('UPDATE action_runs SET attempts = attempts + 1, next_attempt_at = ? WHERE rid = ?'),
        finish: db.prepare('UPDATE action_runs SET state = ?, last_error = ?, finished_at = ? WHERE rid = ?'),
        retry: db.prepare('UPDATE action_runs SET next_attempt_at = ?, last_error = ? WHERE rid = ?'),
        counts: db.prepare(`SELECT COUNT(*) FILTER (WHERE state = 'queued') AS queued, COUNT(*) FILTER (WHERE state = 'failed') AS failed,
            COUNT(*) FILTER (WHERE state = 'sent') AS sent FROM action_runs`),
        recent: db.prepare(`SELECT check_run_id, action_index, kind, state, attempts, last_error, created_at, finished_at FROM action_runs
            WHERE watch_id = ? ORDER BY rid DESC LIMIT ?`),
    };

    /** One row per action of the watch, for the run that fired. Call inside the run's transaction. */
    async function queue({ watch, run, owner, value, previousValue, observedAt }) {
        const list = Array.isArray(watch.action) ? watch.action : [];
        const at = now();
        for (let i = 0; i < list.length; i++) {
            const action = list[i] || {};
            const kind = String(action.kind || '');
            let state = 'queued', error = null, request = {};
            if (kind === 'notification') {
                if (USER_SUBJECT.test(String(owner || ''))) request = notificationFor({ config, watch, run, action, value, previousValue, observedAt });
                else { state = 'skipped'; error = 'watch.action_no_person: the watch belongs to an agent or a service, not a person'; }
            } else if (kind === 'event') {
                if (action.event_type !== TRIGGERED) { state = 'unavailable'; error = `watch.action_unavailable: ${action.event_type || 'an event'} is not an event Watch declares (only ${TRIGGERED})`; }
                else if (!USER_SUBJECT.test(String(owner || ''))) { state = 'skipped'; error = `watch.action_no_person: ${TRIGGERED} names a person, and this watch belongs to an agent or a service`; }
                else { state = 'sent'; error = 'emitted with the check run'; }
            } else if (kind === 'webhook' && action.secret_ref) {
                // A project secret (ADR-056): Network signs at delivery; the project's grant to watch decides then.
                if (!watch.project_id || !watch.project_env) { state = 'unavailable'; error = 'watch.action_secret_unavailable: a project secret needs the watch to name its project'; }
                else request = { url: action.url, secret_ref: action.secret_ref, project_id: watch.project_id, project_env: watch.project_env, body: webhookFor({ config, watch, run, value, previousValue, observedAt }) };
            } else if (kind === 'webhook') {
                const why = grants() ? grants().refusal(action.secret_env, owner) : `${action.secret_env} is not granted to any owner`;
                if (why) { state = 'unavailable'; error = `watch.action_secret_not_granted: ${why}`; }
                else request = { url: action.url, secret_env: action.secret_env, body: webhookFor({ config, watch, run, value, previousValue, observedAt }) };
            } else if (kind === 'actor-task') {
                if (USER_SUBJECT.test(String(owner || ''))) {
                    request = { task: actorTaskFor({ config, watch, action, value, previousValue, observedAt }), budget_usd: action.budget_usd == null ? null : action.budget_usd };
                } else { state = 'skipped'; error = 'watch.action_no_person: an Actor task runs under a person\'s allowance, and this watch belongs to an agent or a service'; }
            } else if (kind === 'actor-agent') {
                if (USER_SUBJECT.test(String(owner || ''))) {
                    request = { agent_id: action.agent_id, input: actorAgentInputFor({ config, watch, action, value, previousValue, observedAt }) };
                } else { state = 'skipped'; error = 'watch.action_no_person: an Actor agent runs for a person, and this watch belongs to an agent or a service'; }
            } else if (kind === 'run-job') {
                if (!USER_SUBJECT.test(String(owner || ''))) { state = 'skipped'; error = 'watch.action_no_person: a Run job is started for a person in their project, and this watch belongs to an agent or a service'; }
                else if (!PROJECT_ID.test(String(watch.project_id || ''))) { state = 'unavailable'; error = 'watch.project_required: a run-job action is billed to the watch\'s project, and this watch names none'; }
                else request = { project_id: watch.project_id, job: runJobFor({ config, watch, run, action, value, previousValue, observedAt }) };
            } else if (kind === 'codes-run') {
                if (USER_SUBJECT.test(String(owner || ''))) request = { repo: String(action.repo || ''), prompt: codesTaskFor({ config, watch, action, value, previousValue, observedAt }) };
                else { state = 'skipped'; error = 'watch.action_no_person: a coding task runs on a person\'s own machine, and this watch belongs to an agent or a service'; }
            } else if (LATER.has(kind)) {
                state = 'unavailable'; error = `watch.action_unavailable: ${kind} actions are a later step (plan T18)`;
            } else {
                state = 'unavailable'; error = `watch.action_unavailable: unknown action kind ${kind || '(none)'}`;
            }
            await st.insert.run(watch.id, run.id, i, kind || 'unknown', String(owner || ''), JSON.stringify(request), state, error, at, state === 'queued' ? null : at);
        }
    }

    /** The signature headers: the operator-granted key secret_env names, or Network's signature with the project secret. */
    async function webhookSignature(row, request, body) {
        if (request.secret_ref) {
            if (!projectSecrets) return { refused: 'watch.action_secret_unavailable: project secrets are not configured in this Watch' };
            const t = Math.floor(now() / 1000);
            try {
                const { signature } = await projectSecrets.sign({ project_id: request.project_id, environment: request.project_env, name: request.secret_ref, message: `${t}.${body}` });
                return { headers: { 'X-OpenVibe-Timestamp': String(t), 'X-OpenVibe-Signature-V2': `t=${t},v2=${signature}` } };
            } catch (err) {
                if (err instanceof SecretRefused) return { refused: `watch.action_secret_not_granted: ${err.message}` };
                throw err;   // Network unreachable: the worker's backoff tries again
            }
        }
        const why = grants() ? grants().refusal(request.secret_env, row.owner_sub) : 'no grants';
        if (why) return { refused: `watch.action_secret_not_granted: ${why}` };
        const secret = config.secrets ? config.secrets[request.secret_env] : null;
        if (!secret || String(secret).length < MIN_HOOK_SECRET) {
            return { refused: `watch.action_secret_missing: ${request.secret_env} is not set (${MIN_HOOK_SECRET} characters or more)` };
        }
        return { headers: signDeliveryHeaders(body, String(secret), { now: now() }) };
    }

    async function deliverWebhook(row, request, attempt) {
        const body = JSON.stringify(request.body);
        const signed = await webhookSignature(row, request, body);
        if (signed.refused) return { state: 'unavailable', error: signed.refused };
        if (!post) throw Object.assign(new Error('webhook delivery is not configured in this process'), { code: 'webhook_unconfigured' });
        const headers = {
            ...signed.headers,
            'X-OpenVibe-Event-Type': TRIGGERED,
            'X-OpenVibe-Delivery-Id': `${row.check_run_id}.${row.action_index}`,
            'X-OpenVibe-Delivery-Attempt': String(attempt),
        };
        let res;
        try {
            res = await post(request.url, { headers, body });
        } catch (err) {
            if (err && REFUSED_URL.has(err.code)) return { state: 'failed', error: `watch.action_url_refused: ${err.message}` };
            throw err;
        }
        if (res.status >= 200 && res.status < 300) return { state: 'sent', error: null };
        if (res.status === 410) return { state: 'failed', error: 'watch.action_gone: the receiver answered 410 Gone' };
        throw Object.assign(new Error(`the receiver answered ${res.status}`), { code: `http_${res.status}` });
    }

    async function deliverActorTask(row, request) {
        if (!actor) throw Object.assign(new Error('Actor delivery is not configured in this process'), { code: 'actor_unconfigured' });
        try {
            const task = await actor.create({
                subjectId: row.owner_sub, task: request.task, budgetUsd: request.budget_usd,
                idempotencyKey: `watch.${row.check_run_id}.${row.action_index}`,
            });
            return { state: 'sent', error: `Actor task ${task.id || '(no id)'}` };
        } catch (err) {
            // Actor answered that this request can never succeed: over the tier's budget, an unknown agent, invalid.
            if (err && (err.status === 422 || err.status === 400)) return { state: 'failed', error: `watch.action_refused: ${err.code || err.status}: ${String(err.detail || err.message || '').slice(0, 200)}` };
            throw err;
        }
    }

    async function deliverActorAgent(row, request) {
        if (!actor) throw Object.assign(new Error('Actor delivery is not configured in this process'), { code: 'actor_unconfigured' });
        try {
            const task = await actor.runAgent({ subjectId: row.owner_sub, agentId: request.agent_id, input: request.input });
            return { state: 'sent', error: `Actor task ${task.id || '(no id)'}` };
        } catch (err) {
            if (err && err.status === 404 && err.code === 'actor.agent.not_found') return { state: 'failed', error: `watch.action_refused: ${err.code}: this agent was not found for the watch owner` };
            if (err && (err.status === 429 || err.status === 400 || err.status === 422 || (err.status === 403 && /(?:limit|free.tier|over_tier)/i.test(String(err.code || ''))))) {
                return { state: 'failed', error: `watch.action_refused: ${err.code || err.status}: ${String(err.detail || err.message || '').slice(0, 200)}` };
            }
            throw err;
        }
    }

    async function deliverRunJob(row, request) {
        if (!runJobs) throw Object.assign(new Error('Run delivery is not configured in this process'), { code: 'run_unconfigured' });
        try {
            const job = await runJobs.submit({
                subjectId: row.owner_sub, projectId: request.project_id, job: request.job,
                idempotencyKey: `watch.${row.check_run_id}.${row.action_index}`,
            });
            return { state: 'sent', error: `Run job ${job.id || '(no id)'}${job.created ? '' : ' (already started)'}` };
        } catch (err) {
            if (err && RUN_FINAL.has(err.status)) return { state: 'failed', error: `watch.action_refused: ${err.code || err.status}: ${String(err.detail || err.message || '').slice(0, 200)}` };
            throw err;
        }
    }

    async function deliverCodesRun(row, request) {
        if (!codes) throw Object.assign(new Error('Codes delivery is not configured in this process'), { code: 'codes_unconfigured' });
        try {
            const task = await codes.start({ subjectId: row.owner_sub, repo: request.repo, prompt: request.prompt, idempotencyKey: `watch.${row.check_run_id}.${row.action_index}` });
            return { state: 'sent', error: `Codes task ${task.id || '(no id)'}${task.url ? ` ${task.url}` : ''}${task.created ? '' : ' (already started)'}` };
        } catch (err) {
            if (err && RUN_FINAL.has(err.status)) return { state: 'failed', error: `watch.action_refused: ${err.code || err.status}: ${String(err.detail || err.message || '').slice(0, 200)}` };
            throw err;
        }
    }

    async function deliver(row, attempt) {
        const request = typeof row.request === 'string' ? JSON.parse(row.request) : row.request;
        if (row.kind === 'webhook') return await deliverWebhook(row, request, attempt);
        if (row.kind === 'actor-task') return await deliverActorTask(row, request);
        if (row.kind === 'actor-agent') return await deliverActorAgent(row, request);
        if (row.kind === 'run-job') return await deliverRunJob(row, request);
        if (row.kind === 'codes-run') return await deliverCodesRun(row, request);
        if (row.kind !== 'notification') return { state: 'unavailable', error: `watch.action_unavailable: ${row.kind}` };
        const out = await notifications.push({ subjectId: row.owner_sub, ...request });
        if (out.sent) return { state: 'sent', error: out.skipped ? 'delivered; the person switched this category off' : null };
        return { state: 'skipped', error: 'watch.action_owner_unknown: Network does not know this owner (a deleted account?)' };
    }

    /** One pass: claim due rows under a lease, deliver each, record the outcome. Returns counts. */
    async function tick() {
        if (!enabled) return { enabled: false };
        if (busy) return await busy;
        busy = (async () => {
            const out = { sent: 0, skipped: 0, retried: 0, failed: 0 };
            const at = now();
            const rows = await db.tx(async () => {
                const due = await st.claim.all(at, config.actions.batch);
                for (const r of due) await st.lease.run(at + LEASE_MS, r.rid);
                return due;
            });
            for (const r of rows) {
                const attempt = Number(r.attempts) + 1;
                try {
                    const res = await deliver(r, attempt);
                    await st.finish.run(res.state, res.error, now(), r.rid);
                    if (res.state === 'sent') out.sent++;
                    else if (res.state === 'failed') out.failed++;
                    else out.skipped++;
                } catch (err) {
                    const why = String((err && (err.code || err.message)) || err).slice(0, 300);
                    if (attempt >= BACKOFF_MS.length + 1) {
                        await st.finish.run('failed', why, now(), r.rid);
                        out.failed++;
                        log.warn(`[actions] ${r.watch_id}: ${r.kind} gave up after ${attempt} attempts: ${why}`);
                    } else {
                        await st.retry.run(now() + BACKOFF_MS[attempt - 1], why, r.rid);
                        out.retried++;
                    }
                }
            }
            return out;
        })();
        try { return await busy; } finally { busy = null; }
    }

    function start() {
        if (timer || !enabled) return;
        timer = setInterval(() => { tick().catch((err) => log.warn(`[actions] tick: ${err.message}`)); }, config.actions.tickMs);
        timer.unref?.();
    }
    async function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        if (busy) await busy.catch(() => {});
    }

    async function status() {
        const c = await st.counts.get();
        return { enabled, queued: Number(c.queued) || 0, failed: Number(c.failed) || 0, sent: Number(c.sent) || 0 };
    }

    async function recent(watchId, limit = 10) {
        return (await st.recent.all(watchId, limit)).map((r) => ({
            check_run_id: r.check_run_id, kind: r.kind, state: r.state, attempts: Number(r.attempts),
            error: r.last_error || null,
            created_at: new Date(Number(r.created_at)).toISOString(),
            finished_at: r.finished_at == null ? null : new Date(Number(r.finished_at)).toISOString(),
        }));
    }

    return { queue, tick, start, stop, status, recent, enabled };
}

module.exports = { createActions, notificationFor, webhookFor, actorTaskFor, actorAgentInputFor, runJobFor, BACKOFF_MS, RUN_FINAL };
