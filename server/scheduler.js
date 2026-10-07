'use strict';
/**
 * In-process scheduler: every WATCH_TICK_MS, start checks for active watches whose next_due_at and
 * not_before have passed, oldest due first, up to WATCH_MAX_CONCURRENT checks at a time. The due
 * query is the one the migration's partial index serves, and check.run() itself refuses a second
 * check of a watch already in flight (so a manual check and a scheduled one never overlap).
 *
 * Copied from OpenVibe.Sources/server/scheduler.js with Watch's due query (watches, not sources;
 * cadence IS NOT NULL, since a source pushed to by an event or webhook never polls).
 */
function createScheduler({ db, check, config, now = () => Date.now(), log = console }) {
    const due = db.prepare(`SELECT id FROM watches WHERE status = 'active' AND deleted_at IS NULL AND cadence IS NOT NULL
        AND next_due_at <= @now AND not_before <= @now ORDER BY next_due_at, id LIMIT @limit`);
    let timer = null;
    const running = new Set();

    async function tick() {
        const free = config.worker.maxConcurrent - running.size;
        if (free <= 0) return [];
        const ids = (await due.all({ now: now(), limit: free + running.size })).map(r => r.id).filter(id => !running.has(id)).slice(0, free);
        for (const id of ids) {
            running.add(id);
            check.run(id, { trigger: 'schedule' })
                .catch(err => log.error(`[scheduler] ${id}: ${err.stack || err}`))
                .finally(() => running.delete(id));
        }
        return ids;
    }

    function start() {
        if (timer) return;
        timer = setInterval(async () => { try { await tick(); } catch (err) { log.error(`[scheduler] tick: ${err.message}`); } }, config.worker.tickMs);
        timer.unref?.();
    }

    async function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        // let checks in flight finish (each is bounded by the fetch timeout)
        const deadline = Date.now() + 15000;
        while (running.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    }

    return { start, stop, tick, running: () => Boolean(timer), active: () => [...running] };
}

module.exports = { createScheduler };
