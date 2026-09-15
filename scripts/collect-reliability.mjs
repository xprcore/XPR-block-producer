import fs from 'node:fs/promises';

const OUT = new URL('../data/missed-blocks.json', import.meta.url);
const CHANNEL = 'proton_mainnet_reliability';
const CHANNEL_URL = 'https://t.me/proton_mainnet_reliability';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 100;

function decode(s='') {
  return s.replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#39;/g,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').trim();
}

async function fetchPage(before='') {
  const url = `https://t.me/s/${CHANNEL}${before ? `?before=${encodeURIComponent(before)}` : ''}`;
  const res = await fetch(url, {headers:{'user-agent':'Mozilla/5.0'}});
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  return await res.text();
}

function parsePage(html) {
  const events=[];
  const ids=[];
  const postRe = /data-post=["'](?:[^"']+\/)?(\d+)["'][\s\S]*?<div class=["'][^"']*tgme_widget_message_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m=postRe.exec(html))) {
    const id=Number(m[1]); if(Number.isFinite(id)) ids.push(id);
    const text=decode(m[2]);
    const re=/([a-z0-9._-]+)\s+missed a round \(#(\d+)\) at block (\d+)\s*\[([^\]]+)\]/i;
    const x=re.exec(text);
    if(!x) continue;
    const ts=Date.parse(x[4]); const block=Number(x[3]); const round=Number(x[2]);
    if(Number.isFinite(ts)&&Number.isFinite(block)&&Number.isFinite(round)) events.push({producer:x[1].toLowerCase(),round,block,ts,postId:id});
  }
  return {events, ids:[...new Set(ids)]};
}

async function main() {
  let payload={version:1,source:CHANNEL_URL,coverageOk:false,oldestTs:null,newestTs:null,pages:0,events:[]};
  try { payload=JSON.parse(await fs.readFile(OUT,'utf8')); } catch {}
  const cutoff=Date.now()-MAX_AGE_MS;
  const map=new Map((Array.isArray(payload.events)?payload.events:[]).filter(e=>Number(e.ts)>=cutoff).map(e=>[`${e.postId||''}:${e.block}:${e.producer}`,e]));

  let before=''; let pages=0; let oldest=Infinity; let newest=0;
  while (pages < PAGE_LIMIT) {
    const html=await fetchPage(before);
    const parsed=parsePage(html); pages++;
    for (const e of parsed.events) {
      if (e.ts>=cutoff) map.set(`${e.postId||''}:${e.block}:${e.producer}`,e);
      oldest=Math.min(oldest,e.ts); newest=Math.max(newest,e.ts);
    }
    if (!parsed.ids.length) break;
    const minId=Math.min(...parsed.ids);
    if (oldest<=cutoff) break;
    if (!Number.isFinite(minId) || String(minId)===String(before)) break;
    before=String(minId);
  }

  const events=[...map.values()].filter(e=>Number(e.ts)>=cutoff).sort((a,b)=>Number(a.ts)-Number(b.ts));
  const actualOldest=events.length?events[0].ts:null;
  const actualNewest=events.length?events.at(-1).ts:null;
  const coverageOk=actualOldest!=null && actualOldest<=cutoff;
  await fs.writeFile(OUT,JSON.stringify({version:1,source:CHANNEL_URL,coverageOk,oldestTs:actualOldest,newestTs:actualNewest,pages,events},null,2)+'\n');
  console.log(`saved ${events.length} missed-round events from ${pages} Telegram pages; coverageOk=${coverageOk}`);
}

main().catch(err=>{console.error(err);process.exit(1);});
