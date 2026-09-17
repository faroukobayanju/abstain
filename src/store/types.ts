/**
 * Receipt store contract and the compare-and-set append.
 *
 * THE BUG THIS EXISTS TO PREVENT:
 *
 *   t  REQ A                    REQ B                  STORE
 *   ─  ──────────────────────   ────────────────────   ─────────────
 *   1  read head → seq=41                              head=41
 *   2                           read head → seq=41     head=41
 *   3  write seq=42 prev=h41                           head=42  ✓
 *   4                           write seq=42 prev=h41  head=42  ✗ FORK
 *
 * Two receipts claim seq 42 and /v1/verify reports divergence on honest data —
 * the one endpoint that closes the demo failing on the product's own record.
 * Vercel Functions run concurrent invocations, so this is not theoretical; the
 * interleave happens across the `await` on the head read.
 *
 * Fix: hashing stays in Node (sha256; Redis Lua only offers sha1), and the
 * write is an atomic compare-and-set against the head. A loser retries against
 * the new head rather than overwriting.
 */
import { GENESIS, sealReceipt, type Receipt, type ReceiptBody } from '../receipt/schema.js';

export interface Head {
  seq: number;
  hash: string;
}

export interface ReceiptStore {
  head(): Promise<Head | null>;
  /**
   * Commit `receipt` only if the head is still `expected`.
   * Returns false when another writer won the race — never throws for contention.
   */
  compareAndAppend(expected: Head | null, receipt: Receipt): Promise<boolean>;
  get(seq: number): Promise<Receipt | null>;
  all(): Promise<Receipt[]>;
}

export class ChainContentionError extends Error {
  constructor(attempts: number) {
    super(`receipt chain head contended after ${attempts} attempts`);
    this.name = 'ChainContentionError';
  }
}

export class StoreUnavailableError extends Error {
  constructor(cause: string) {
    super(`receipt store unavailable: ${cause}`);
    this.name = 'StoreUnavailableError';
  }
}

export const MAX_CAS_ATTEMPTS = 5;

/**
 * Append a receipt, resolving contention by retrying against the fresh head.
 * A receipt is either fully committed or not written at all — there is no
 * partial state and no unlinked record.
 */
export async function appendReceipt(
  store: ReceiptStore,
  body: ReceiptBody,
  maxAttempts = MAX_CAS_ATTEMPTS,
): Promise<Receipt> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const head = await store.head();
    const seq = (head?.seq ?? 0) + 1;
    const prev = head?.hash ?? GENESIS;
    const receipt = sealReceipt(body, seq, prev);
    if (await store.compareAndAppend(head, receipt)) return receipt;
  }
  throw new ChainContentionError(maxAttempts);
}
