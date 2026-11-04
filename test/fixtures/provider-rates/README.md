# Recorded provider price documents

These are the two official price documents trimmed to a few records, recorded on 2026-11-04. The tests parse
them and never fetch: `test/provider-rates.test.js`.

| File | Live source | What was kept |
|---|---|---|
| `deepinfra-models.json` | `https://api.deepinfra.com/models/list` (documented in `https://api.deepinfra.com/openapi.json`) | three token-priced models (one with an active `discount` and a `rate_per_input_token_cached` multiplier) and one embeddings model with a different pricing type, so the parser's skip path is real |
| `featherless-models.json` | `https://api.featherless.ai/v1/models` | four models, including a gated one (its published price is still evidence) and an audio-output model |

The live documents are public and keyless. Nothing was changed except dropping the other records and fields the
parser does not read; no prices were edited. The malformed case is built in the test by changing one price to `"n/a"`,
so there is no recorded document that could be mistaken for a real one.
