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

function reviewTone(rating) {
  if (!Number.isFinite(rating)) return '整體星等暫時抓不到';
  if (rating >= 4.7) return '整體評價非常高';
  if (rating >= 4.4) return '整體評價偏高';
  if (rating >= 4.1) return '整體評價穩定';
  if (rating >= 3.8) return '評價中上、仍有一些分歧';
  return '評價較兩極';
}

function practicalLine(text, topics) {
  const t = text || '';
  const rules = [
    [/排隊|等候|候位|queue/i, '提醒：熱門時段常被提到排隊或等候。'],
    [/停車|parking/i, '交通：停車便利度是評論常見討論點。'],
    [/服務|態度|出餐|service/i, '服務：服務態度或出餐速度是評論常見討論點。'],
    [/價格|價位|cp值|CP值|便宜|偏貴|price/i, '價格：價位與 CP 值是評論常見討論點。'],
    [/份量|portion/i, '份量：餐點份量是評論常見討論點。'],
    [/環境|座位|空間|冷氣|environment/i, '環境：座位與用餐環境是評論常見討論點。']
  ];
  for (const [re,line] of rules) if (re.test(t)) return line;
  if (topics[2]) return `另外：「${topics[2].label}」也是高頻評論主題。`;
  return '提醒：建議點開 Google Maps 看最新評論與營業狀態。';
}

function buildHighlights(rating, reviewCount, topics, summaryText) {
  const lines = [];
  if (Number.isFinite(rating)) {
    lines.push(`口碑：Google ${rating.toFixed(1)}★／${Number.isFinite(reviewCount) ? reviewCount.toLocaleString('zh-TW') + ' 則' : '評論數未取得'}，${reviewTone(rating)}。`);
  } else {
    lines.push('口碑：Google 星等資料暫時抓不到，建議直接看最新評論。');
  }
  if (topics.length >= 2) {
    lines.push(`熱門：評論最常提到「${topics[0].label}」與「${topics[1].label}」。`);
  } else if (topics.length === 1) {
    lines.push(`熱門：目前最高頻的評論主題是「${topics[0].label}」。`);
  } else {
    lines.push('熱門：Google 沒有穩定提供可解析的熱門主題。');
  }
  lines.push(practicalLine(summaryText, topics));
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

  return { rating, reviewCount, topics, summaryBlock };
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
      highlights:buildHighlights(parsed.rating, parsed.reviewCount, parsed.topics, parsed.summaryBlock),
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
