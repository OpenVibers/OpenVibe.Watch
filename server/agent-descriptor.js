'use strict';
// What openvibe.watch tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the bearer-token API behind the site, the pages that
// explain how a watch works, llms.txt and the sitemap.
module.exports = {
    id: 'watch',
    name: 'OpenVibe.Watch',
    purpose: 'Persistent, user-defined observations: a watch says what to observe (a page, a feed, an API, a webhook, an OpenVibe event), when to check it and which value to compare, and tells you when the condition fires.',
    home: 'https://openvibe.watch',
    site: 'openvibe.watch',
    api: '/api/v1',
    docs: '/how-it-works',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
