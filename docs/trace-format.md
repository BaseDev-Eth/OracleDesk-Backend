# Pinned Document and Trace Format Specification

OracleDesk pins verifiable artefacts to IPFS:
1. **Question Documents**: committed on-chain through `market_core.agent_create_market(question_hash, meta_uri, ...)`
2. **Reasoning Traces**: committed on-chain through `reasoning_registry.publish_trace(trace_hash, ipfs_cid, ...)`

---

## 1. Versioning Policy

Every pinned document includes explicit metadata:
- `schemaVersion`: an integer version number (e.g. `1` for TraceDocV1, `2` for QuestionDocV2).
- `kind`: document discriminator (e.g. `'oracledesk.trace'`, `'oracledesk.question'`, `'oracledesk.trace.enc'`).

Any semantic change, added required field, or removed field bumps `schemaVersion`.
Legacy unversioned documents are permanently identified as `schemaVersion: 0` in API responses and continue to verify by their exact sha256 byte hash.

---

## 2. Canonical JSON Serialization

To ensure consistent cryptographic hashing across different runtimes and languages, OracleDesk follows strict JSON canonicalization:
1. Object keys are sorted lexicographically (UTF-8 code units) at every level.
2. No unnecessary whitespace is added (`separators=(',', ':')`).
3. Floating point numbers use standard shortest round-trip formatting.
4. Optional fields are explicitly set to `null` rather than omitted, preserving identical key sets across all code paths.
5. Strict checks reject `undefined`, functions, symbols, `Date` objects, and non-finite numbers (`NaN`, `Infinity`).

> [!IMPORTANT]
> Verifiers must check hashes against the **raw fetched bytes** from IPFS, rather than parsing and re-serializing the JSON. Re-serializing in other languages or engines can cause float or unicode differences.

---

## 3. Reasoning Trace Document (v1)

JSON Schema URL: `https://api.oracledesk.io/api/v1/schemas/trace/v1.json`

```json
{
  "schemaVersion": 1,
  "kind": "oracledesk.trace",
  "traceId": "11111111-1111-1111-1111-111111111111",
  "agentType": "MARKET_MAKER",
  "decisionType": "MARKET_CREATION",
  "action": "create_market",
  "market": {
    "backendId": "22222222-2222-2222-2222-222222222222",
    "onChainId": "0"
  },
  "probabilityEstimate": 0.65,
  "marketProbability": 0.5,
  "edge": 0.15,
  "confidenceInterval": {
    "lower": 0.55,
    "upper": 0.75
  },
  "sourcesUsed": [
    {
      "source": "FRED",
      "weight": 0.8,
      "signal": "Federal funds futures imply 25bps cut",
      "rawValue": 0.75
    }
  ],
  "betFraction": null,
  "betSizeUsdc": null,
  "hedgeConditions": [
    "CPI YoY exceeds 3.0%"
  ],
  "agentWallet": null,
  "createdAt": "2026-10-17T00:00:00.000Z"
}
```

---

## 4. Confidential Trace Envelope (`oracledesk.trace.enc` v1)

When `TRACE_CONFIDENTIAL=true`, full traces are encrypted with XChaCha20-Poly1305 before pinning.

```json
{
  "kind": "oracledesk.trace.enc",
  "schemaVersion": 1,
  "alg": "XChaCha20-Poly1305",
  "kid": "kek-2026-10",
  "plaintextHash": "89b51fa16ce70...",
  "public": {
    "traceId": "11111111-1111-1111-1111-111111111111",
    "agentType": "MARKET_MAKER",
    "decisionType": "MARKET_CREATION",
    "market": {
      "backendId": "22222222-2222-2222-2222-222222222222",
      "onChainId": "0"
    },
    "probabilityEstimate": 0.65,
    "marketProbability": 0.5,
    "edge": 0.15,
    "previewSources": [
      {
        "source": "FRED",
        "weight": 0.8,
        "signal": "Federal funds futures imply 25bps cut",
        "rawValue": 0.75
      }
    ],
    "createdAt": "2026-10-17T00:00:00.000Z"
  },
  "nonce": "<base64 24 bytes>",
  "ciphertext": "<base64 ciphertext and 16-byte Poly1305 tag>"
}
```

- **AEAD Associated Data**: Canonical JSON bytes of the envelope excluding `nonce` and `ciphertext`.
- **Public Verifiability**:
  1. The on-chain `trace_hash` in `reasoning_registry` equals `sha256(pinned_bytes)` (the canonical envelope bytes).
  2. Entitled users unwrap the per-trace data key and decrypt the ciphertext to verify `sha256(plaintext) === envelope.plaintextHash`.

---

## 5. Question Document (v2)

JSON Schema URL: `https://api.oracledesk.io/api/v1/schemas/question/v2.json`

```json
{
  "schemaVersion": 2,
  "kind": "oracledesk.question",
  "question": "Will the Federal Reserve cut the target policy rate by 25bps or more at the Dec 2026 FOMC meeting?",
  "category": "FED",
  "contractCategory": "Macro",
  "closeTime": 1798761600,
  "resolutionSource": "FRED",
  "resolutionSpecHash": "a1b2c3d4...",
  "backendMarketId": "22222222-2222-2222-2222-222222222222"
}
```

## Recalibration fields (#244)

For TRADER traces, the `forecast` block (the ensemble) may carry:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `forecast.raw.p` | number | Ensemble probability before recalibration |
| `forecast.raw.ci` | `{ lower, upper }` | Ensemble 90% interval before recalibration |
| `forecast.calibration` | object \| null | `{ mapId, version, category, applied }` of the map behind `probabilityEstimate`; `applied: false` when recalibration is disabled |

`probabilityEstimate` and `confidenceInterval` are the values the trade was
sized on (after recalibration when applied). The database also stores
`rawProbabilityEstimate` per trace; it is not part of the pinned document.
Readers must treat all three fields as optional: traces written before #244
do not have them.

## Citation validation fields (#304)

To distinguish signals provided to the model (`sourcesUsed`) from signals the
model actually cited and passed output-side citation validation, traces may
carry the following optional, backwards-compatible fields (old traces without
them remain valid):

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `citedSourceIds` | `string[]` (optional) | Deduplicated signal-store ids that were cited in accepted forecast adjustments/rationale and verified against the rendered input set. |
| `provenance.llm[].citationCheck` | `{ version: 1, checked: number, issueCodes: Record<string, number>, action: "ACCEPTED" \| "STRIPPED" \| "REJECTED" }` (optional) | Aggregate counts and deterministic remediation action from the citation validator (counts only, never raw model or signal text). |
| `forecast.members[].detail.citedSignalIds` | `string[]` (optional) | Accepted cited signal-store ids for the published LLM forecast sample. |
| `forecast.members[].detail.rejectedAdjustments` | `Array<{ signal_id, delta, why, reasons }>` (optional) | Invalid adjustments stripped for `UNKNOWN_ID` or `QUARANTINED_ID`. |

When all hedge conditions fail citation validation, the trace falls back to
default hedge conditions with `provenance.llm[]` recording
`{ source: "default", reason: "CITATION_REJECTED", citationCheck }`.
