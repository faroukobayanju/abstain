# Abstain

Abstain is a pre-trade execution gate for agentic trading systems. It fetches strategy and market evidence from Nexus, evaluates ten deterministic checks, and returns `EXECUTE`, `ABSTAIN`, or `NO_TRADE`. Every evaluation is written to a publicly verifiable SHA-256 receipt chain before the API responds.

Abstain never places orders and never holds funds. Its job is narrower: decide whether a proposed action is allowed, explain the decision, and leave evidence that can be independently checked.

## Quick start

```bash
npm ci
npm test

ABSTAIN_WRITE_KEY=local-test-key \
COMMIT_SHA="$(git rev-parse HEAD)" \
ABSTAIN_NOW=1789689600000 \
npm run dev
```

In another terminal:

```bash
curl -s -X POST http://localhost:3000/v1/evaluate \
  -H 'content-type: application/json' \
  -H 'x-abstain-key: local-test-key' \
  -d '{"symbol":"BTC/USDT","side":"BUY","notional":15000,"policy":"strict"}' | jq

curl -s http://localhost:3000/v1/verify | jq
```

Replay mode is the default. It uses committed Nexus fixtures and an in-memory receipt store, so local evaluation needs no Nexus or Redis credentials. Local `/v1/ready` intentionally returns `503` with `durable:false`; production refuses writes unless Redis is configured.

## Documentation

- [Build your first verifiable evaluation](docs/tutorial-getting-started.md) — start locally and inspect a receipt from end to end.
- [How to test and deploy Abstain](docs/how-to-test-and-deploy.md) — run offline gates, configure production, and verify a deployment.
- [HTTP API and configuration reference](docs/reference-api.md) — endpoints, request shapes, environment variables, limits, and errors.
- [Why Abstain uses a fail-closed receipt chain](docs/explanation-receipt-chain.md) — design rationale, concurrency model, and trade-offs.
- [Submission verification evidence](submission/verification/README.md) — reviewer-focused reproduction steps.
- [Fixture provenance](fixtures/README.md) — which evidence is recorded or synthetic.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the 147-test offline suite. |
| `npm run typecheck` | Type-check without emitting JavaScript. |
| `npm run build` | Compile production JavaScript into `dist/`. |
| `npm run dev` | Build and start the local server on port 3000. |
| `npm run chart` | Regenerate the with-gate/without-gate replay evidence. |
| `npm run frontier` | Regenerate the policy frontier evidence. |
| `npm run record` | Re-record Nexus fixtures; requires live Nexus credentials. |

## Core guarantees

- The decision path is deterministic and contains no LLM call.
- Missing, malformed, mismatched, or unavailable evidence cannot become permission to trade.
- Production cannot write receipts to process-local memory.
- Concurrent writers cannot fork the receipt chain.
- Duplicate non-HOLD signals cannot be authorized twice.
- Anyone can read receipts and recompute the chain without credentials.

## License and rights

See [submission/RIGHTS.md](submission/RIGHTS.md).
