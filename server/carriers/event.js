'use strict';
/**
 * The event carrier (plan T18 step 5): an event source is pushed to, never polled. OpenVibe.Events delivers an event
 * that matches the watch (server/event-sources.js), and the check runs with it as its input. The extraction reads the
 * event as its document: { event_type, event_id, timestamp, subject, payload } (`payload.version`, for example).
 *
 * Without an event (Check now) there is nothing to read: carriers/index.js answers watch.event_awaited before this runs.
 */
const crypto = require('crypto');

function createEventCarrier() {
    return {
        name: 'event',
        async run({ input }) {
            const document = {
                event_type: input.event_type,
                event_id: input.event_id,
                timestamp: input.timestamp || null,
                subject: input.subject || null,
                payload: input.payload === undefined ? null : input.payload,
            };
            const body = JSON.stringify(document);
            return {
                state: 'ok', document, body, content_type: 'application/json',
                bytes: Buffer.byteLength(body), raw_body_hash: crypto.createHash('sha256').update(body).digest('hex'),
            };
        },
    };
}

module.exports = { createEventCarrier };
