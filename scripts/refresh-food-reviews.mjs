import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const INDEX = 'food-map/index.html';
const OUT = 'food-map/review-highlights.json';
const OUT_MIRROR = 'home-flow-prod/public/food-map/review-highlights.json';
const MAX = Number(process.env.MAX_PLACES || 300);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const STALE_DAYS = Number(process.env.STALE_DAYS || 14);

const html = await fs.readFile(INDEX, 'utf8');
const match = html.match(/const SHARED_SEED = (\[[\s\S]*?\]);\n/);
if (!match) throw new Error('SHARED_SEED not found');
const seed = JSON.parse(match[1]);

let old = { updatedAt: null, places: {} };
try { old = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
if (!old.places || typeof old.places !== 'object') old.places = {};

const nonFood = [
  /停車場/, /圖書館/, /親子館/, /運動廣場/, /gas station/i, /加油站/,
  /製鍋/, /漁港/, /seafood wholesaler/i, /休閒農場/, /博物館/, /7-eleven/i,
  /便利商店/, /文化館/, /(^|[^餐])公園$/, /河樂廣場/, /釣魚場/
];
const normalize = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const idFor = p => 'shared:' + p.sourceKey + ':' + normalize(p.title);
const isFood = p => p.kind === 'food' && !nonFood.some(re => re.test(String(p.title || '')));
const staleBefore = Date.now() - STALE_DAYS * 86400000;
const isStale = v => !v?.fetchedAt || Date.parse(v.fetchedAt) < staleBefore;

const targets = seed.filter(isFood).filter(p => isStale(old.places[idFor(p)]))
  .sort((a,b) => ((b.reviews||0) - (a.reviews||0)))
  .slice(0, MAX);

console.log(`Review refresh targets: ${targets.length}/${seed.filter(isFood).length}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'zh-TW',
  timezoneId: 'Asia/Taipei',
  viewport: { width: 430, height: 900 },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => Number(String(s || '').replace(/,/g,''));
const compact = s => String(s || '').replace(/\s+/g,' ').trim();

function countHits(text,re){const m=String(text||'').match(re);return m?m.length:0}

function buildHighlights(topics, reviewText) {
  const lines = [];
  if (topics.length >= 2) {
    lines.push(`熱門主題：最常提到「${topics[0].label}」（${topics[0].count}）與「${topics[1].label}」（${topics[1].count}）。`);
  } else if (topics.length === 1) {
    lines.push(`熱門主題：最常提到「${topics[0].label}」（${topics[0].count}）。`);
  }

  const cats = [
    {re:/排隊|等候|候位|人潮|出餐|速度|久等|等待/gi,line:'用餐節奏：排隊、等候或出餐速度是近期評論常見話題。'},
    {re:/價格|價位|便宜|偏貴|很貴|CP值|cp值|份量|大份|小份|划算/gi,line:'價格份量：價位、CP 值與份量是近期評論常見話題。'},
    {re:/環境|座位|空間|冷氣|乾淨|衛生|停車|交通|車位/gi,line:'環境交通：座位、環境或停車交通是近期評論常見話題。'},
    {re:/服務|態度|店員|老闆|親切|出餐/gi,line:'服務體驗：店員態度與服務流程是近期評論常見話題。'},
    {re:/好吃|好喝|美味|口味|口感|湯頭|香|酥|脆|嫩|鮮|鹹|甜|辣|推薦/gi,line:'口味：味道、口感與招牌餐點是近期評論最常討論的核心。'}
  ].map(x=>({...x,n:countHits(reviewText,x.re)})).filter(x=>x.n>0).sort((a,b)=>b.n-a.n);

  for (const x of cats) {
    if (lines.length >= 2) break;
    lines.push(x.line);
  }

  const pos = countHits(reviewText,/好吃|好喝|美味|推薦|滿意|讚|很棒|超讚|驚豔|香|嫩|酥|鮮|親切/gi);
  const neg = countHits(reviewText,/普通|難吃|失望|太鹹|太甜|太油|油膩|偏貴|很貴|態度差|很慢|久等|不推/gi);
  if (pos >= 2 && pos >= neg * 1.8) lines.push('整體語氣：目前可見 Google 評論以正面描述為主。');
  else if (neg >= 2 && neg >= pos * .8) lines.push('整體語氣：目前可見 Google 評論較兩極，負面提醒也不少。');
  else lines.push('整體語氣：目前可見 Google 評論正負意見都有，建議再看最新幾則。');

  while (lines.length < 3) lines.push('評論資料：Google 公開頁面暫未提供更多可穩定解析的熱點。');
  return lines.slice(0,3);
}

function parseBody(text, place) {
  const lines = text.split('\n').map(s=>s.trim()).filter(Boolean);
  let rating = Number.isFinite(place.rating) ? Number(place.rating) : null;
  let reviewCount = Number.isFinite(place.reviews) ? Number(place.reviews) : null;

  const targetTitle = compact(place.title);
  let titleIdx = lines.findIndex(x => compact(x) === targetTitle);
  if (titleIdx < 0 && targetTitle.length > 5) {
    titleIdx = lines.findIndex(x => compact(x).includes(targetTitle.slice(0, Math.min(18,targetTitle.length))));
  }
  if (titleIdx >= 0) {
    for (let i=titleIdx+1;i<Math.min(lines.length,titleIdx+12);i++) {
      if (/^[1-5](?:\.\d)$/.test(lines[i])) {
        const n = Number(lines[i]);
        const near = lines.slice(i+1,i+5).join(' ');
        const m = near.match(/\(?([\d,]{2,})\)?/);
        if (m) { rating = n; reviewCount = num(m[1]); break; }
      }
    }
  }

  const summaryIdx = lines.findIndex(x => x === '評論摘要');
  const reviewIdx = lines.findIndex((x,i) => i > Math.max(0,summaryIdx) && x === '評論');
  const summaryBlock = summaryIdx >= 0
    ? compact(lines.slice(summaryIdx+1, reviewIdx > summaryIdx ? reviewIdx : summaryIdx+60).join(' '))
    : '';

  let sortIdx = -1;
  for (let i=Math.max(0,reviewIdx); i<Math.min(lines.length,reviewIdx+80); i++) {
    if (lines[i] === '排序') { sortIdx=i; break; }
  }
  const topics = [];
  if (sortIdx >= 0) {
    for (let i=sortIdx+1;i<Math.min(lines.length,sortIdx+60)-1;i++) {
      const label = lines[i];
      const count = lines[i+1];
      if (label === '全部' || /^\+\d+$/.test(label)) continue;
      if (/^[\d,]+$/.test(count) && !/^[\d,]+$/.test(label) && label.length <= 28) {
        const n = num(count);
        if (Number.isFinite(n) && n >= 2) {
          topics.push({label:compact(label),count:n});
          i++;
          if (topics.length >= 3) break;
        }
      }
    }
  }

  const reviewText = sortIdx >= 0
    ? compact(lines.slice(sortIdx+1, Math.min(lines.length,sortIdx+220)).join(' '))
    : compact(lines.slice(Math.max(0,reviewIdx), Math.min(lines.length,Math.max(0,reviewIdx)+220)).join(' '));
  return { rating, reviewCount, topics, summaryBlock, reviewText };
}

async function scrape(p) {
  const page = await context.newPage();
  const query = [p.title, p.city].filter(Boolean).join(' ');
  const url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query) + '&hl=zh-TW';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await page.waitForTimeout(2200);
    const text = await page.locator('body').innerText({ timeout: 8000 });
    if (/接受所有|Before you continue|驗證你不是機器人|unusual traffic/i.test(text)) {
      throw new Error('Google consent/captcha');
    }
    const parsed = parseBody(text, p);
    return {
      title:p.title,
      city:p.city,
      rating:parsed.rating,
      reviewCount:parsed.reviewCount,
      topics:parsed.topics,
      highlights:buildHighlights(parsed.topics, parsed.reviewText),
      fetchedAt:new Date().toISOString(),
      source:'Google Maps public review page'
    };
  } finally {
    await page.close();
  }
}

let cursor = 0;
let ok = 0, failed = 0;
async function worker(n) {
  while (true) {
    const idx = cursor++;
    if (idx >= targets.length) return;
    const p = targets[idx], id = idFor(p);
    try {
      const data = await scrape(p);
      old.places[id] = data;
      ok++;
      console.log(`[${n}] OK ${idx+1}/${targets.length}: ${p.title}`);
    } catch (e) {
      failed++;
      console.warn(`[${n}] FAIL ${p.title}: ${e.message}`);
    }
    await sleep(500 + Math.floor(Math.random()*700));
  }
}

await Promise.all(Array.from({length:Math.min(CONCURRENCY,targets.length||1)},(_,i)=>worker(i+1)));
await browser.close();

old.updatedAt = new Date().toISOString();
old.source = 'Google Maps public review pages; cached snapshot, not live API';
old.count = Object.keys(old.places).length;
await fs.writeFile(OUT, JSON.stringify(old,null,2)+'\n');
console.log(`Done. cached=${old.count}, ok=${ok}, failed=${failed}`);
