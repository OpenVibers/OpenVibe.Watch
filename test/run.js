#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails
 * if any of them fails. They use temp PGlite databases, generated RSA keys and stub subscribers
 * on random ports; none of them needs the network or a running OpenVibe.Network.
 *
 *   npm test                   # everything
 *   npm test -- publish sse    # only files whose name contains one of the words
 *   npm test -- --strict       # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
// 180 s per file: every test that boots the service stands up its own PGlite (a WASM PostgreSQL whose first
// query is seconds of init), and on a loaded machine — the CI shards and the local check run side by side — a
// file that takes ~30 s idle can pass 60 s. Same 180 s as Host's PGlite suite; a hung file still dies.
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 180000, pad: 32, parallel: 1 });
