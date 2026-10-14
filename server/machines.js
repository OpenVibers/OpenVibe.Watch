'use strict';
/**
 * A person's own machine on OpenVibe.Bot, for a watch's `node` source (plan T18 step 7, contracts 0.167.0).
 *
 *   const machines = createMachines(client, { baseUrl });   // client: openvibe-sdk/core createClient with Watch's token
 *   await machines.probe({ subjectId, machineId, probe })   → bot.command-result@1 ({ result, data?, reason?, code? })
 *
 * probe() POSTs one `probe` (bot.command@1: { target, timeout_s }) to Bot's machine API with Watch's own token
 * (bot.computer.control, audience openvibe.bot) and the watch's owner in X-OV-Subject. Bot sends it only to that person's
 * own machine, only where they turned on "Let my watches check things from this computer", and Watch may send nothing
 * but probes. The machine itself reaches only its own network (private, loopback or link-local addresses). A refusal by
 * Bot arrives as openvibe-sdk OpenVibeError (status, code); the machine's own refusal is result "nack" with a reason.
 */

function createMachines(client, { baseUrl }) {
    async function probe({ subjectId, machineId, probe: value }) {
        const body = { kind: 'probe', value: { target: value.target, ...(Number.isInteger(value.timeout_s) ? { timeout_s: value.timeout_s } : {}) }, ms: 45000 };
        return await client.json({
            service: 'bot', baseUrl, audience: 'openvibe.bot', method: 'POST', path: `/api/v1/machines/${encodeURIComponent(machineId)}/commands`,
            headers: { 'X-OV-Subject': subjectId }, json: body, retries: 0, idempotencyKey: false,
        });
    }
    return { probe };
}

module.exports = { createMachines };
