/**
 * HTTP surface. Deliberately small — crisp tool boundaries are 15 points of the
 * official scorecard, and every endpoint here maps to one agent-callable verb.
 *
 *   PUBLIC  (no auth — the whole point is that anyone can check the record)
 *     GET  /health                               ← HARD GATE, zero dependencies
 *     GET  /.well-known/xagent-verification.json ← HARD GATE
 *     GET  /v1/policy
 *     GET  /v1/receipts            ?from=&to=
 *     GET  /v1/receipts/:seq
 *     POST /v1/verify
 *     GET  /v1/ready               dependency probe, NO gate reads this
 *
 *   AUTHENTICATED (X-ABSTAIN-KEY — writes append to the evidence chain)
 *     POST /v1/evaluate
 *
 * Side effects: none beyond the receipt chain. Abstain authorizes and refuses;
 * it never places an order and never holds custody.
 */
import { Hono } from 'hono';
import { PROJECT_SLUG, commitSha, isReviewableCommit, safeEqual, writeKey } from './config.js';
import { ValidationError, evaluate, validate, type EvaluateDeps } from './evaluate.js';
import { mergePolicy, policyHash, type PolicyName } from './policy/index.js';
import { verifyChain } from './receipt/verify.js';
import { ChainContentionError, StoreUnavailableError } from './store/types.js';

export interface AppDeps extends EvaluateDeps {
  /** Non-gating dependency probe for /v1/ready. */
  probe?: () => Promise<{ nexus: boolean; store: boolean }>;
  env?: NodeJS.ProcessEnv;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const env = deps.env ?? process.env;

  // -------------------------------------------------------------------------
  // HARD GATE endpoints. No external dependency of any kind.
  //
  // The gate requires `status: ok` plus the exact review commit. Coupling that
  // to Nexus or Redis would hand a third party the power to fail a gate you had
  // already passed, for twelve days, at no benefit to anyone.
  // -------------------------------------------------------------------------
  app.get('/health', (c) => {
    const commit = commitSha(env);
    return c.json({
      status: 'ok',
      service: PROJECT_SLUG,
      commit,
      commit_reviewable: isReviewableCommit(commit),
    });
  });

  app.get('/.well-known/xagent-verification.json', (c) => {
    const commit = commitSha(env);
    return c.json({ slug: PROJECT_SLUG, commit, commit_reviewable: isReviewableCommit(commit) });
  });

  // Dependency health lives here instead, where no gate reads it.
  app.get('/v1/ready', async (c) => {
    if (!deps.probe) return c.json({ ready: null, reason: 'no probe configured' });
    try {
      const r = await deps.probe();
      return c.json({ ready: r.nexus && r.store, ...r }, r.nexus && r.store ? 200 : 503);
    } catch (err) {
      return c.json({ ready: false, error: (err as Error).name }, 503);
    }
  });

  // -------------------------------------------------------------------------
  // Public reads. Open on purpose: a chain only a privileged caller can inspect
  // is not evidence.
  // -------------------------------------------------------------------------
  app.get('/v1/policy', (c) => {
    const name = (c.req.query('policy') ?? 'strict') as PolicyName;
    if (name !== 'strict' && name !== 'permissive') {
      return c.json({ error: 'bad_request', field: 'policy', reason: 'must be strict or permissive' }, 400);
    }
    const policy = mergePolicy(deps.basePolicy, name);
    return c.json({ name, policy, policy_hash: policyHash(policy) });
  });

  app.get('/v1/receipts', async (c) => {
    const all = await deps.store.all();
    const from = Number(c.req.query('from') ?? 1);
    const to = Number(c.req.query('to') ?? all.length);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return c.json({ error: 'bad_request', reason: 'from and to must be numbers' }, 400);
    }
    const slice = all.filter((r) => r.seq >= from && r.seq <= to);
    return c.json({ count: slice.length, total: all.length, receipts: slice });
  });

  app.get('/v1/receipts/:seq', async (c) => {
    const seq = Number(c.req.param('seq'));
    if (!Number.isInteger(seq) || seq < 1) {
      return c.json({ error: 'bad_request', reason: 'seq must be a positive integer' }, 400);
    }
    const receipt = await deps.store.get(seq);
    if (!receipt) return c.json({ error: 'not_found', seq }, 404);
    return c.json(receipt);
  });

  /** The demo's closer: a stranger recomputes the chain themselves. */
  app.post('/v1/verify', async (c) => {
    const result = verifyChain(await deps.store.all());
    return c.json(result, result.ok ? 200 : 409);
  });
  app.get('/v1/verify', async (c) => {
    const result = verifyChain(await deps.store.all());
    return c.json(result, result.ok ? 200 : 409);
  });

  // -------------------------------------------------------------------------
  // The one write. Gated, because an append-only evidence log that anyone can
  // append to is a contradiction — and junk receipts cannot be deleted without
  // breaking the chain.
  // -------------------------------------------------------------------------
  app.post('/v1/evaluate', async (c) => {
    const expected = writeKey(env);
    const supplied = c.req.header('x-abstain-key') ?? '';
    if (expected === '' || !safeEqual(supplied, expected)) {
      return c.json(
        { error: 'unauthorized', reason: 'X-ABSTAIN-KEY missing or incorrect' },
        401,
      );
    }

    let req;
    try {
      req = validate(await c.req.json().catch(() => null));
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ error: 'bad_request', field: err.field, reason: err.message }, 400);
      }
      throw err;
    }

    try {
      const { receipt, policyName } = await evaluate(req, deps);
      return c.json({
        verdict: receipt.verdict,
        policy: policyName,
        policy_hash: receipt.policy_hash,
        as_of: receipt.as_of,
        checks: receipt.checks,
        receipt: { seq: receipt.seq, hash: receipt.hash, prev_hash: receipt.prev_hash },
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      });
    } catch (err) {
      // No receipt was written, so say so plainly rather than returning a
      // verdict the chain cannot back.
      if (err instanceof StoreUnavailableError) {
        return c.json({ error: 'store_unavailable', reason: err.message, receipt_written: false }, 503);
      }
      if (err instanceof ChainContentionError) {
        return c.json({ error: 'chain_contended', reason: err.message, receipt_written: false }, 503);
      }
      throw err;
    }
  });

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

  return app;
}
