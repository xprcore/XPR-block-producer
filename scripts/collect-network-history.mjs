import fs from 'node:fs/promises';

const RPC_ENDPOINTS = [
  'https://proton.protonuk.io',
  'https://api-xprnetwork-main.saltant.io'
];
const OUT = new URL('../data/network-history.json', import.meta.url);
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BLOCKS = 20;

async function rpc(path, body) {
  let last;
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const res = await fetch(endpoint + path, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'accept': 'application/json'},
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
      return await res.json();
    } catch (e) { last = e; }
  }
  throw last ?? new Error('RPC unavailable');
}

function ms(ts) {
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000;
  const n = Date.parse(String(ts || ''));
  return Number.isFinite(n) ? n : null;
}

function txs(block) { return Array.isArray(block?.transactions) ? block.transactions : []; }
function txStatus(tx) {
  const s = String(tx?.status ?? tx?.trx?.status ?? '').toLowerCase();
  if (['executed','included','success','executed_trx'].includes(s)) return 'success';
  if (['soft_fail','hard_fail','expired','failed','failure'].includes(s)) return 'failure';
  return null;
}

async function main() {
  const info = await rpc('/v1/chain/get_info', {});
  const head = Number(info.head_block_num);
  const lib = Number(info.last_irreversible_block_num);
  const nums = Array.from({length: BLOCKS}, (_, i) => head - i).filter(n => n > 0);
  const blocks = (await Promise.all(nums.map(n => rpc('/v1/chain/get_block', {block_num_or_id:n}).catch(() => null))))
    .filter(Boolean).sort((a,b) => Number(b.block_num)-Number(a.block_num));
  if (!blocks.length) throw new Error('No blocks returned');

  let txCount = 0, success = 0, failure = 0;
  const producers = [];
  const intervals = [];
  for (const block of blocks) {
    producers.push(block.producer || null);
    for (const tx of txs(block)) {
      txCount++;
      const status = txStatus(tx);
      if (status === 'success') success++;
      if (status === 'failure') failure++;
    }
  }
  for (let i=0;i<blocks.length-1;i++) {
    const a = ms(blocks[i].timestamp), b = ms(blocks[i+1].timestamp);
    const diff = Number(blocks[i].block_num)-Number(blocks[i+1].block_num);
    if (a != null && b != null && diff > 0) {
      const sec = (a-b)/1000/diff;
      if (sec >= 0 && sec < 300) intervals.push(sec);
    }
  }
  const newest = ms(blocks[0].timestamp), oldest = ms(blocks.at(-1).timestamp);
  const elapsed = newest != null && oldest != null && newest >= oldest ? (newest-oldest)/1000 : null;
  const avgBlockTime = intervals.length ? intervals.reduce((a,b)=>a+b,0)/intervals.length : null;
  const tps = elapsed > 0 ? txCount/elapsed : null;
  const known = success + failure;
  const successRate = known ? success/known*100 : null;
  const latest = blocks[0];
  const latestTxCount = txs(latest).length;
  const latestBlockTime = intervals[0] ?? null;
  const latestNetWords = txs(latest).reduce((sum, tx) => sum + (Number(tx?.net_usage_words ?? tx?.trx?.net_usage_words ?? 0) || 0), 0);
  const netLimit = Number(info.block_net_limit || 0);
  const utilization = netLimit > 0 ? (latestNetWords * 8 / netLimit) * 100 : null;

  let finality = null;
  if (lib > 0 && head >= lib) {
    try {
      const libBlock = await rpc('/v1/chain/get_block', {block_num_or_id:lib});
      const ht = ms(info.head_block_time), lt = ms(libBlock.timestamp);
      if (ht != null && lt != null) finality = Math.max(0,(ht-lt)/1000);
    } catch {}
  }

  const point = {
    ts: Date.now(), block: head, producer: info.head_block_producer || latest.producer || null,
    blockTime: avgBlockTime, currentBlockTime: latestBlockTime, tps,
    utilization, successRate,
    failureRate: successRate == null ? null : 100-successRate,
    txPerBlock: blocks.length ? txCount/blocks.length : null,
    finality, validatorCounts: {}, activeProducers: producers.filter(Boolean)
  };

  let payload = {version:1, source:'github-actions', sampleIntervalSeconds:300, points:[]};
  try { payload = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
  const cutoff = Date.now() - MAX_AGE_MS;
  const points = Array.isArray(payload.points) ? payload.points.filter(p => Number(p?.ts) >= cutoff) : [];
  const map = new Map(points.map(p => [String(p.block || p.ts), p]));
  map.set(String(point.block), point);
  const merged = [...map.values()].sort((a,b)=>Number(a.ts)-Number(b.ts));
  await fs.writeFile(OUT, JSON.stringify({...payload, version:1, source:'github-actions', sampleIntervalSeconds:300, points:merged}, null, 2) + '\n');
  console.log(`saved ${merged.length} network history points; head ${head}`);
}

main().catch(err => { console.error(err); process.exit(1); });
