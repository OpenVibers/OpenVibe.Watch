'use strict';
/** The defaults Watch used for its event envelopes before the SDK outbox owned delivery. */
const { ids } = require('openvibe-contracts');

function envelope({ event_type, subject, payload, visibility = 'internal', priority = 'important', actor, trace_id }, source, now) {
    const ms = now();
    const env = {
        event_id: ids.newId('event', ms), event_type, version: 1, source,
        actor: actor || { type: 'service', id: source },
        timestamp: new Date(ms).toISOString(), priority, visibility, subject, payload: payload || {},
    };
    if (trace_id && /^[0-9a-f]{32}$/.test(trace_id)) env.trace_id = trace_id;
    return env;
}

module.exports = { envelope };
