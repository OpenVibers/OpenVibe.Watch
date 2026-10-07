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
 * This release carries the pull rungs only:
 *
 *   http  feed  api   implemented here (step 3)
 *   event webhook     step 5
 *   run               step 6
 *   node              step 7
 *
 * A kind whose carrier is not built yet is accepted by the registry (a watch may be defined before
 * its transport exists) but is NEVER fetched: choose() answers `watch.carrier_unavailable`, the
 * check is recorded as `skipped`, and no request leaves this process. That is what keeps a
 * half-built rung from silently turning into polling.
 */
const { createHttpCarrier } = require('./http');
const { createFeedCarrier } = require('./feed');
const { createApiCarrier } = require('./api');

/** The documented order. A source kind fixes its carrier; this is the order a watch would prefer. */
const PREFERENCE = ['event', 'webhook', 'http', 'feed', 'api'];

/** The step of plan T18 that carries each kind this release does not. */
const LATER = {
    event: { step: 5, note: 'an event source is delivered by OpenVibe.Events, never polled' },
    webhook: { step: 5, note: 'a webhook source is delivered to /internal/hooks/, never polled' },
    run: { step: 6, note: 'browser polling goes through OpenVibe.Run only after every cheaper rung was unavailable' },
    node: { step: 7, note: 'a node probe observes a local/LAN thing through OpenVibe.Node' },
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

function createCarriers({ fetcher, config, log = console }) {
    const carriers = {
        http: createHttpCarrier({ fetcher, config, log }),
        feed: createFeedCarrier({ fetcher, config, log }),
        api: createApiCarrier({ fetcher, config, log }),
    };

    /**
     * choose(watch) → { name, run } | { unavailable: { code, carrier, detail } }.
     * Never fetches, never throws.
     */
    function choose(watch) {
        const kind = watch && watch.source ? watch.source.kind : null;
        const carrier = carriers[kind];
        if (!carrier) return { unavailable: unavailable(kind) };
        return { name: carrier.name, run: carrier.run };
    }

    return { choose, carriers, PREFERENCE, LATER };
}

module.exports = { createCarriers, PREFERENCE, LATER, unavailable };
