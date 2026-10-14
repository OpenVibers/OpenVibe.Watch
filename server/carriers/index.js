'use strict';
/**
 * Carrier choice. The plan's preference order is binding:
 *
 *     webhook/event → ETag/Last-Modified → feed → API → and only then browser polling (through Run)
 *
 * The rungs are cheap to expensive, so a watch takes the first one its source makes possible: a
 * pushed event or webhook costs nothing, a conditional GET costs two headers, a feed and an API are
 * ordinary conditional GETs, and a Run check is an expensive browser/code execution. `source.kind`
 * fixes the carrier (migration 0001); PREFERENCE records the order the service is built around.
 *
 *   http  feed  api   implemented here (step 3)
 *   event             step 5: OpenVibe.Events delivers a matching event and the check reads it (carriers/event.js,
 *                     server/event-sources.js); a check with no event (Check now) answers watch.event_awaited
 *   webhook           step 5: a signed POST to /hooks/<watch id> runs the check with the delivery (carriers/webhook.js,
 *                     server/webhook-sources.js); a check with no delivery (Check now) answers watch.webhook_awaited
 *   node              step 7: a probe from the owner's own machine, through OpenVibe.Bot (carriers/node.js, contracts 0.167)
 *   run               step 6
 *
 * A kind whose carrier is not built yet is accepted by the registry (a watch may be defined before
 * its transport exists) but is NEVER fetched: choose() answers `watch.carrier_unavailable`, the
 * check is recorded as `skipped`, and no request leaves this process. That is what keeps a
 * half-built rung from silently turning into polling.
 */
const { createHttpCarrier } = require('./http');
const { createFeedCarrier } = require('./feed');
const { createApiCarrier } = require('./api');
const { createEventCarrier } = require('./event');
const { createWebhookCarrier } = require('./webhook');
const { createNodeCarrier } = require('./node');

/** The documented order. A source kind fixes its carrier; this is the order a watch would prefer. */
const PREFERENCE = ['event', 'webhook', 'http', 'feed', 'api', 'node'];

/** The step of plan T18 that carries each kind this release does not. */
const LATER = {
    run: { step: 6, note: 'browser polling goes through OpenVibe.Run only after every cheaper rung was unavailable' },
};

function unavailable(kind) {
    const later = LATER[kind] || { step: null, note: 'no carrier for this source kind' };
    return {
        code: 'watch.carrier_unavailable',
        carrier: kind,
        detail: later.step
            ? `a ${kind} source is not checked yet: the ${kind} carrier arrives in plan T18 step ${later.step} (${later.note}). Nothing was fetched.`
            : `no carrier handles a ${kind} source. Nothing was fetched.`,
    };
}

function createCarriers({ fetcher, config, log = console, machines = null }) {
    const carriers = {
        http: createHttpCarrier({ fetcher, config, log }),
        feed: createFeedCarrier({ fetcher, config, log }),
        api: createApiCarrier({ fetcher, config, log }),
        event: createEventCarrier(),
        webhook: createWebhookCarrier(),
        node: createNodeCarrier({ machines }),
    };

    /**
     * choose(watch, { input }) → { name, run } | { unavailable: { code, carrier, detail } }.
     * Never fetches, never throws. An event source runs only with the event that woke it.
     */
    function choose(watch, { input = null } = {}) {
        const kind = watch && watch.source ? watch.source.kind : null;
        if (kind === 'event' && !input) {
            return { unavailable: { code: 'watch.event_awaited', carrier: 'event', detail: `an event source is checked when a ${watch.source.pattern} event arrives from OpenVibe.Events. Nothing was fetched.` } };
        }
        if (kind === 'webhook' && !input) {
            return { unavailable: { code: 'watch.webhook_awaited', carrier: 'webhook', detail: 'a webhook source is checked when a signed delivery reaches its /hooks/ address. Nothing was fetched.' } };
        }
        const carrier = carriers[kind];
        if (!carrier) return { unavailable: unavailable(kind) };
        return { name: carrier.name, run: carrier.run };
    }

    return { choose, carriers, PREFERENCE, LATER };
}

module.exports = { createCarriers, PREFERENCE, LATER, unavailable };
