import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import { encode, decode, memoryChainCache, chainKey } from '../src/lib/chain-cache';
import { withCallerClass } from '../src/lib/context';
import { Bulkhead } from '../src/lib/resilience';
import { ChainError } from '../src/services/stellar/errors';

setupTestEnv();

test('codec round-trips Market, ResolutionState and i128 values losslessly', () => {
  const sample = {
    marketId: 42n,
    reserves: [1000000000n, 2000000000n],
    hash: Buffer.from('f4b58d4ac4068163f34bd9486f0563c70873afa5f64e915ab7e85af7dee15e4e', 'hex'),
    status: { tag: 'Resolved', values: [{ tag: 'Yes' }] },
    name: 'Test Market',
  };

  const encoded = encode(sample);
  const decoded = decode<typeof sample>(encoded);

  assert.equal(decoded.marketId, 42n);
  assert.equal(decoded.reserves[0], 1000000000n);
  assert.equal(decoded.reserves[1], 2000000000n);
  assert.ok(Buffer.isBuffer(decoded.hash));
  assert.equal(decoded.hash.toString('hex'), sample.hash.toString('hex'));
  assert.deepEqual(decoded.status, sample.status);
  assert.equal(decoded.name, sample.name);
});

test('second read within TTL is served from cache with cached true and the original ledger', async () => {
  const cache = memoryChainCache();
  let loadCount = 0;

  const loader = async () => {
    loadCount++;
    return { value: { reserveYes: 100n }, ledger: 12345 };
  };

  const read1 = await cache.get('k1', { ttlMs: 5000, tags: ['market:1'] }, loader);
  assert.equal(read1.cached, false);
  assert.equal(read1.ledger, 12345);
  assert.equal(read1.value.reserveYes, 100n);
  assert.equal(loadCount, 1);

  const read2 = await cache.get('k1', { ttlMs: 5000, tags: ['market:1'] }, loader);
  assert.equal(read2.cached, true);
  assert.equal(read2.ledger, 12345);
  assert.equal(read2.value.reserveYes, 100n);
  assert.equal(loadCount, 1);
});

test('100 concurrent misses trigger exactly one loader call', async () => {
  const cache = memoryChainCache();
  let loadCount = 0;

  const loader = async () => {
    loadCount++;
    await new Promise((r) => setTimeout(r, 20));
    return { value: 'coalesced-data', ledger: 500 };
  };

  const reads = await Promise.all(
    Array.from({ length: 100 }, () =>
      cache.get('k-concurrent', { ttlMs: 5000, tags: ['market:5'] }, loader),
    ),
  );

  assert.equal(loadCount, 1);
  for (const r of reads) {
    assert.equal(r.value, 'coalesced-data');
    assert.equal(r.ledger, 500);
  }
});

test('invalidateTag forces a reload on the next read', async () => {
  const cache = memoryChainCache();
  let loadCount = 0;

  const loader = async () => {
    loadCount++;
    return { value: `val-${loadCount}`, ledger: 1000 + loadCount };
  };

  const r1 = await cache.get('k-tag', { ttlMs: 5000, tags: ['market:10'] }, loader);
  assert.equal(r1.value, 'val-1');
  assert.equal(loadCount, 1);

  await cache.invalidateTag('market:10');

  const r2 = await cache.get('k-tag', { ttlMs: 5000, tags: ['market:10'] }, loader);
  assert.equal(r2.value, 'val-2');
  assert.equal(r2.cached, false);
  assert.equal(loadCount, 2);
});

test('a load that started before invalidation and returns an older ledger is not cached', async () => {
  const cache = memoryChainCache();

  // Invalidate at ledger 200
  await cache.invalidateTag('market:20', 200);

  // Read returns older ledger 199
  const r1 = await cache.get(
    'k-stale',
    { ttlMs: 5000, tags: ['market:20'] },
    async () => ({ value: 'stale-value', ledger: 199 }),
  );

  assert.equal(r1.cached, false);
  assert.equal(cache.stats().staleRejects, 1);

  // Next read should miss and not serve the rejected older entry
  let secondLoaded = false;
  const r2 = await cache.get(
    'k-stale',
    { ttlMs: 5000, tags: ['market:20'] },
    async () => {
      secondLoaded = true;
      return { value: 'fresh-value', ledger: 205 };
    },
  );

  assert.equal(secondLoaded, true);
  assert.equal(r2.value, 'fresh-value');
});

test('contract errors are negatively cached only for the negative TTL', async () => {
  const cache = memoryChainCache();
  let calls = 0;

  const loader = async () => {
    calls++;
    throw new ChainError('MarketNotFound', 'MarketNotFound');
  };

  await assert.rejects(
    async () => cache.get('k-notfound', { ttlMs: 5000, tags: ['market:404'] }, loader),
    (err: any) => err.contractError === 'MarketNotFound',
  );
  assert.equal(calls, 1);

  // Second call within negative TTL hits negative cache without calling loader
  await assert.rejects(
    async () => cache.get('k-notfound', { ttlMs: 5000, tags: ['market:404'] }, loader),
    (err: any) => err.contractError === 'MarketNotFound',
  );
  assert.equal(calls, 1);
});

test('higher caller class promotes a queued public load to avoid priority inversion (#300)', async () => {
  const cache = memoryChainCache();
  const bh = new Bulkhead('rpc-read', 2, {
    critical: { weight: 8, reserved: 1, maxQueue: 8, maxWaitMs: 15_000 },
    agent: { weight: 4, reserved: 0, maxQueue: 8, maxWaitMs: 15_000 },
    interactive: { weight: 3, reserved: 0, maxQueue: 8, maxWaitMs: 10_000 },
    public: { weight: 2, reserved: 0, maxQueue: 8, maxWaitMs: 5_000 },
    background: { weight: 1, reserved: 0, maxQueue: 8, maxWaitMs: 30_000 },
  });

  // Occupy the single non-reserved slot with an unrelated public call so the next public load queues.
  let releaseBlocker!: () => void;
  const blocker = withCallerClass('public', () =>
    bh.run(() => new Promise<void>((r) => { releaseBlocker = r; })),
  );

  let loadCalls = 0;
  const load = () =>
    bh.run(async () => {
      loadCalls++;
      return { value: `loaded-${loadCalls}`, ledger: 999 };
    });

  // Public caller starts first, queues in bulkhead (not started yet).
  const pubPromise = withCallerClass('public', () => cache.get('k-promote', { ttlMs: 5000, tags: [] }, load));
  await new Promise((r) => setTimeout(r, 10));

  // Critical caller joins: promotes and uses critical's reserved slot immediately.
  const critPromise = withCallerClass('critical', () => cache.get('k-promote', { ttlMs: 5000, tags: [] }, load));

  const [pubRes, critRes] = await Promise.all([pubPromise, critPromise]);
  assert.equal(pubRes.value, 'loaded-1');
  assert.equal(critRes.value, 'loaded-1');
  assert.equal(cache.stats().promoted, 1);

  releaseBlocker();
  await blocker;
});
