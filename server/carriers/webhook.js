'use strict';
/**
 * The webhook carrier (plan T18 step 5): a webhook source is pushed to, never polled. A signed POST to
 * /hooks/<watch id> (server/webhook-sources.js) runs the check with the delivery as its input; the extraction reads
 * the body: parsed JSON as the document when the sender said JSON, the text otherwise.
 *
 * Without a delivery (Check now) there is nothing to read: carriers/index.js answers watch.webhook_awaited first.
 */
const crypto = require('crypto');

function createWebhookCarrier() {
    return {
        name: 'webhook',
        async run({ input }) {
            const text = Buffer.isBuffer(input.body) ? input.body.toString('utf8') : String(input.body || '');
            const contentType = input.content_type || 'application/octet-stream';
            let document;
            if (/\bjson\b/i.test(contentType)) {
                try { document = JSON.parse(text); } catch { return { state: 'parse_error', error_code: 'unreadable', detail: 'the delivery said JSON but its body is not JSON' }; }
            }
            return {
                state: 'ok', body: text, content_type: contentType, ...(document !== undefined ? { document } : {}),
                bytes: Buffer.byteLength(text), raw_body_hash: crypto.createHash('sha256').update(text).digest('hex'),
            };
        },
    };
}

module.exports = { createWebhookCarrier };
