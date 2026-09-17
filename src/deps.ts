/**
 * Wire the app from environment.
 *
 *   UPSTASH_REDIS_REST_URL + _TOKEN present ──▶ RedisStore  (durable, atomic CAS)
 *   otherwise                               ──▶ MemoryStore (ephemeral)
 *
 *   NEXUS_MODE=live  + NEXUS_API_KEY        ──▶ real gateway
 *   otherwise                               ──▶ cassette replay
 *
 * Replay + memory is the reviewer's path: clone, `npm test`, reproduce every
 * receipt with no API key and no Redis.
 */
import { readFileSync } from 'node:fs';
import { NexusClient } from './nexus/client.js';
import { TtlCache } from './nexus/fetch-all.js';
import { MemoryStore } from './store/memory.js';
import { RedisStore } from './store/redis.js';
import { UpstashRest } from './store/upstash.js';
import type { ReceiptStore } from './store/types.js';
import type { Policy } from './types.js';
import type { AppDeps } from './app.js';

export function loadBasePolicy(path = 'policy.base.json'): Policy {
  return JSON.parse(readFileSync(path, 'utf8')) as Policy;
}

export function buildStore(env: NodeJS.ProcessEnv = process.env): {
  store: ReceiptStore;
  durable: boolean;
} {
  const url = env['UPSTASH_REDIS_REST_URL'];
  const token = env['UPSTASH_REDIS_REST_TOKEN'];
  if (url && token) {
    return { store: new RedisStore(new UpstashRest({ url, token })), durable: true };
  }
  return { store: new MemoryStore(), durable: false };
}

export function buildDeps(env: NodeJS.ProcessEnv = process.env): AppDeps {
  const { store, durable } = buildStore(env);
  const client = new NexusClient({
    mode: env['NEXUS_MODE'] === 'live' ? 'live' : 'replay',
    ...(env['NEXUS_API_KEY'] ? { apiKey: env['NEXUS_API_KEY'] } : {}),
  });

  // Replay determinism: a cassette's signal timestamp is frozen while wall
  // clock advances, so SIGNAL_STALE would fail on every replayed decision.
  // Pinning `now` is the same as-of discipline the market checks already use.
  const pinned = env['ABSTAIN_NOW'];

  return {
    client,
    store,
    ...(pinned ? { now: () => Number(pinned) } : {}),
    cache: new TtlCache(60_000),
    basePolicy: loadBasePolicy(env['POLICY_PATH'] ?? 'policy.base.json'),
    accountEquity: Number(env['ACCOUNT_EQUITY'] ?? 100_000),
    env,
    probe: async () => {
      const metrics = await client.call('get_strategy_metrics');
      let storeOk = true;
      try {
        await store.head();
      } catch {
        storeOk = false;
      }
      return { nexus: metrics.ok, store: storeOk && (durable || true) };
    },
  };
}
