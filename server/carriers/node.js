'use strict';
/**
 * The node carrier (plan T18 step 7): a check made FROM the owner's own machine, of something on that machine's own
 * network (a NAS's status page, a printer, a port on the router), through OpenVibe.Bot and the machine's OpenVibe Node
 * (the computer plugin's read-only `probe`). Watch never reaches the person's network itself.
 *
 *   source: { kind: 'node', node_id: 'dev_…', probe: { target: 'http(s)://…' | 'tcp://host:port', timeout_s? } }
 *
 * An http(s) probe states its body (one GET from the machine, no redirect followed): the body and content type are
 * extracted like any page, and a status other than 200/203 is an http_error. A tcp probe states the document
 * { open, ms, error? } (as JSON too, so json and jsonpath extractions read it). The owner must be a person: Bot acts
 * only for a machine's owner.
 */
const { sha256 } = require('../util');

const PERSON = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const base = { http_status: null, bytes: null, raw_body_hash: null, etag: null, last_modified: null, body: null, content_type: null, detail: null, error_code: null, notBefore: null };

function createNodeCarrier({ machines }) {
    return {
        name: 'node',
        run: async ({ watch, owner }) => {
            if (!machines) return { ...base, state: 'disabled', error_code: 'node_unavailable', detail: 'Watch has no OpenVibe.Bot client here (no service credentials)' };
            if (!PERSON.test(String(owner || ''))) return { ...base, state: 'disabled', error_code: 'node_person_only', detail: 'a node source checks from a person\'s own machine: the watch must belong to a person' };
            const { node_id: machineId, probe } = watch.source;
            let answer;
            try {
                answer = await machines.probe({ subjectId: owner, machineId, probe });
            } catch (err) {
                const code = err && err.code ? String(err.code) : 'node_unreachable';
                const offline = code === 'bot.device_offline';
                return { ...base, state: offline ? 'timeout' : 'http_error', error_code: code, detail: String((err && (err.detail || err.message)) || 'OpenVibe.Bot did not answer').slice(0, 500) };
            }
            if (!answer || answer.result !== 'ack' || !answer.data) {
                return { ...base, state: answer && answer.result === 'expired' ? 'timeout' : 'http_error', error_code: `node_${(answer && answer.result) || 'no_answer'}`, detail: String((answer && answer.reason) || 'the machine did not answer the probe').slice(0, 500) };
            }
            const d = answer.data;
            if (typeof d.open === 'boolean') {
                // `status` says it in words, so a condition can compare it ({ op: 'eq', value: 'down' }).
                const document = { open: d.open, status: d.open ? 'up' : 'down', ms: Number.isFinite(d.ms) ? d.ms : null, ...(d.error ? { error: String(d.error) } : {}) };
                const body = JSON.stringify(document);
                return { ...base, state: 'ok', document, body, content_type: 'application/json', bytes: body.length, raw_body_hash: sha256(body) };
            }
            const body = typeof d.body === 'string' ? d.body : '';
            const out = { ...base, http_status: Number.isInteger(d.status) ? d.status : null, content_type: d.content_type || null, etag: d.etag || null, last_modified: d.last_modified || null, bytes: body.length };
            if (out.http_status !== 200 && out.http_status !== 203) return { ...out, state: 'http_error', error_code: `http_${out.http_status}`, detail: `HTTP ${out.http_status} from ${probe.target} (seen from the machine)` };
            return { ...out, state: 'ok', body, raw_body_hash: sha256(body) };
        },
    };
}

module.exports = { createNodeCarrier };
