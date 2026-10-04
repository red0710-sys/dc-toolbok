const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const STORE_API = "https://superjsonblob.com/api/jsonBlob";
const HISTORY = { chunks: 7, iv: "_ibeQ4Z7LKmugB90", aad: "homeflow-history-v1" };
const EXPENSE_CATS = ["食","衣","住","行","育","樂","其他"];
const NATURES = ["生活消費","固定義務","房貸本金","利息","資本支出","資金移轉"];
const DEFAULT_ACCOUNTS = ["Cash","國泰","台新","富邦","UBOT","ES","中信","一銀","其他"];
const DEFAULT_PROJECTS = ["日常生活","旅行","東京 2026","聯悅臻裝潢","其他"];

let historyPayload = { meta:{count:0,annual:{}}, entries:[], projectDetails:[] };
let historyEntries = [];
let data = null;
let storageId = null;
let keyText = null;
let cryptoKey = null;
let remoteReady = false;
let saving = false;
let refreshing = false;
let editId = null;

const state = {
  tab: "home",
  viewDate: new Date(),
  search: "",
  filters: { year:"全部", category:"全部", nature:"全部", project:"全部" },
  listLimit: 80,
  analysisMode: "cockpit"
};

function esc(v="") {
  const m={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"};
  return String(v).replace(/[&<>"']/g,x=>m[x]);
}
function money(n){return new Intl.NumberFormat("zh-TW",{style:"currency",currency:"TWD",maximumFractionDigits:0}).format(Number(n)||0)}
function shortMoney(n){n=Number(n)||0;if(Math.abs(n)>=1000000)return `$${(n/1000000).toFixed(n>=10000000?1:2)}M`;if(Math.abs(n)>=10000)return `$${Math.round(n/1000)}K`;return money(n)}
function nowIso(){return new Date().toISOString()}
function localDate(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function uid(){return `m-${Date.now().toString(36)}-${crypto.randomUUID()}`}
function monthKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`}
function setStatus(text,kind=""){const el=$("#status");if(!el)return;el.textContent=text;el.className=`status ${kind}`}
function b64url(bytes){let binary="";for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
function fromB64url(text){const padded=text.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-text.length%4)%4);const bin=atob(padded);return Uint8Array.from(bin,c=>c.charCodeAt(0))}
function hashParams(){return new URLSearchParams(location.hash.slice(1))}
function historyKeyText(){return hashParams().get("hk") || localStorage.getItem("homeflow-history-key") || ""}
function storeHistoryKey(k){if(k)localStorage.setItem("homeflow-history-key",k)}
function readShareFragment(){const p=hashParams(),b=p.get("b"),k=p.get("k");if(!b||!k)return null;if(!/^[A-Za-z0-9_-]{8,120}$/.test(b)||!/^[A-Za-z0-9_-]{40,60}$/.test(k))return null;return{storageId:b,keyText:k}}
function writeShareFragment(id,key){const u=new URL(location.href),p=new URLSearchParams(u.hash.slice(1));p.set("b",id);p.set("k",key);u.hash=p.toString();history.replaceState(null,"",u)}

async function importAesKey(text){const raw=fromB64url(text);if(raw.length!==32)throw new Error("Invalid AES key");return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"])}
async function makeKey(){const raw=crypto.getRandomValues(new Uint8Array(32));return{key:await crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]),text:b64url(raw)}}
async function encryptData(value){const iv=crypto.getRandomValues(new Uint8Array(12)),plain=new TextEncoder().encode(JSON.stringify(value));const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},cryptoKey,plain);return{format:"homeflow-remote-v1",iv:b64url(iv),ciphertext:b64url(new Uint8Array(encrypted))}}
async function decryptData(env){if(!env||!env.iv||!env.ciphertext)throw new Error("Unknown remote format");const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64url(env.iv)},cryptoKey,fromB64url(env.ciphertext));return JSON.parse(new TextDecoder().decode(plain))}

function defaultData(){return{version:5,settings:{accounts:[...DEFAULT_ACCOUNTS],projects:[...DEFAULT_PROJECTS]},settingsUpdatedAt:"1970-01-01T00:00:00.000Z",entries:[],tombstones:{},modifiedAt:nowIso()}}
function normalizeEntry(e){return{
  id:String(e.id||""),type:e.type==="income"?"income":"expense",amount:Math.max(0,Number(e.amount)||0),date:/^\d{4}-\d{2}-\d{2}$/.test(String(e.date||""))?String(e.date):localDate(),
  category:String(e.category||"其他").slice(0,30),legacyCategory:String(e.legacyCategory||"").slice(0,80),account:String(e.account||"未指定").slice(0,30),nature:NATURES.includes(e.nature)?e.nature:"生活消費",project:String(e.project||"日常生活").slice(0,50),note:String(e.note||"").slice(0,240),oneOff:!!e.oneOff,
  imported:!!e.imported,source:String(e.source||""),sourceRow:Number(e.sourceRow)||0,createdAt:String(e.createdAt||nowIso()),updatedAt:String(e.updatedAt||e.createdAt||nowIso())
}}
function normalizeData(input){const base=defaultData();if(!input||typeof input!=="object")return base;const s=input.settings||{};base.settings.accounts=[...new Set((Array.isArray(s.accounts)?s.accounts:DEFAULT_ACCOUNTS).map(x=>String(x).trim()).filter(Boolean))].slice(0,30);base.settings.projects=[...new Set((Array.isArray(s.projects)?s.projects:DEFAULT_PROJECTS).map(x=>String(x).trim()).filter(Boolean))].slice(0,40);base.settingsUpdatedAt=String(input.settingsUpdatedAt||base.settingsUpdatedAt);base.entries=Array.isArray(input.entries)?input.entries.map(normalizeEntry).filter(e=>e.id&&e.amount>0):[];base.tombstones=input.tombstones&&typeof input.tombstones==="object"?{...input.tombstones}:{};base.modifiedAt=String(input.modifiedAt||base.modifiedAt);return base}
function maxIso(a,b){return String(a||"")>=String(b||"")?String(a||""):String(b||"")}
function mergeData(a0,b0){const a=normalizeData(a0),b=normalizeData(b0),m=defaultData();if(a.settingsUpdatedAt>=b.settingsUpdatedAt){m.settings=a.settings;m.settingsUpdatedAt=a.settingsUpdatedAt}else{m.settings=b.settings;m.settingsUpdatedAt=b.settingsUpdatedAt}m.tombstones={...a.tombstones};for(const[id,t]of Object.entries(b.tombstones))m.tombstones[id]=maxIso(m.tombstones[id],t);const map=new Map();for(const e of[...a.entries,...b.entries]){const cur=map.get(e.id);if(!cur||e.updatedAt>cur.updatedAt)map.set(e.id,e)}m.entries=[...map.values()].filter(e=>!m.tombstones[e.id]||e.updatedAt>m.tombstones[e.id]);m.modifiedAt=maxIso(a.modifiedAt,b.modifiedAt);return m}

async function createRemote(env){const r=await fetch(STORE_API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(env)});if(!r.ok)throw new Error("remote create failed");const j=await r.json();if(!j.id)throw new Error("remote id missing");return j.id}
async function readRemote(){const r=await fetch(`${STORE_API}/${encodeURIComponent(storageId)}`,{cache:"no-store",headers:{Accept:"application/json"}});if(!r.ok)throw new Error("remote read failed");return normalizeData(await decryptData(await r.json()))}
async function writeRemote(next){const r=await fetch(`${STORE_API}/${encodeURIComponent(storageId)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(await encryptData(next))});if(!r.ok)throw new Error("remote write failed")}
function saveLocal(){localStorage.setItem("homeflow-local-overrides",JSON.stringify(data))}
async function bootRemote(){const shared=readShareFragment();if(shared){storageId=shared.storageId;keyText=shared.keyText;cryptoKey=await importAesKey(keyText);data=await readRemote();remoteReady=true;saveLocal();return}const gen=await makeKey();cryptoKey=gen.key;keyText=gen.text;data=normalizeData(JSON.parse(localStorage.getItem("homeflow-local-overrides")||"null"));storageId=await createRemote(await encryptData(data));writeShareFragment(storageId,keyText);remoteReady=true;saveLocal()}
async function syncMutation(mutator){if(saving)return false;saving=true;setStatus(remoteReady?"加密同步中…":"本機儲存中…");try{let next=data;if(remoteReady){try{next=mergeData(data,await readRemote())}catch{next=normalizeData(data)}}else next=normalizeData(data);await mutator(next);next.modifiedAt=nowIso();if(remoteReady)await writeRemote(next);data=next;saveLocal();render();setStatus(remoteReady?"已同步 · 加密共用":"本機模式 · 已儲存",remoteReady?"ok":"warn");return true}catch(e){console.error(e);setStatus("儲存失敗，請稍後再試","error");return false}finally{saving=false}}
async function refreshRemote(silent=true){if(!remoteReady||saving||refreshing)return;refreshing=true;try{const r=await readRemote(),m=mergeData(data,r);data=m;saveLocal();render();if(!silent)setStatus("已收到另一台裝置的更新","ok")}catch{}finally{refreshing=false}}

async function loadHistory(){const hk=historyKeyText();if(!hk){setStatus("已開啟 · 歷史資料尚未解鎖","warn");return}storeHistoryKey(hk);if(typeof DecompressionStream==="undefined")throw new Error("Browser does not support gzip stream");const key=await importAesKey(hk);const urls=Array.from({length:HISTORY.chunks},(_,i)=>`./data/history-${String(i).padStart(2,"0")}.txt?v=1`);const parts=await Promise.all(urls.map(async u=>{const r=await fetch(u,{cache:"force-cache"});if(!r.ok)throw new Error(`history chunk ${u} missing`);return(await r.text()).trim()}));const encrypted=fromB64url(parts.join(""));const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64url(HISTORY.iv),additionalData:new TextEncoder().encode(HISTORY.aad)},key,encrypted);const ds=new DecompressionStream("gzip"),stream=new Blob([plain]).stream().pipeThrough(ds),buf=await new Response(stream).arrayBuffer();historyPayload=JSON.parse(new TextDecoder().decode(buf));historyEntries=(historyPayload.entries||[]).map(row=>{const[d,a,t,c,lc,acc,nat,proj,note,src,srow,flags]=row;return normalizeEntry({id:`hist-${src.replace(/\W+/g,"-")}-${srow}`,date:d,amount:a,type:t,category:c,legacyCategory:lc,account:acc,nature:nat,project:proj,note,source:src,sourceRow:srow,oneOff:!!(flags&1),imported:true,createdAt:`${d}T00:00:00.000Z`,updatedAt:`${d}T00:00:00.000Z`})});}
function effectiveEntries(){const map=new Map(historyEntries.map(e=>[e.id,e]));for(const e of(data?.entries||[]))map.set(e.id,e);const tomb=data?.tombstones||{};return[...map.values()].filter(e=>!tomb[e.id]||e.updatedAt>tomb[e.id]).sort((a,b)=>b.date.localeCompare(a.date)||b.updatedAt.localeCompare(a.updatedAt))}
function expenseRows(rows){return rows.filter(e=>e.type==="expense")}
function cashOut(rows){return expenseRows(rows).reduce((s,e)=>s+e.amount,0)}
function monthRows(entries,d=state.viewDate){const k=monthKey(d);return entries.filter(e=>e.date.startsWith(k))}
function yearRows(entries,d=state.viewDate){const y=String(d.getFullYear());return entries.filter(e=>e.date.startsWith(y+"-"))}
function addMonths(date,n){return new Date(date.getFullYear(),date.getMonth()+n,1)}
function baseBurn(entries,end=state.viewDate){let total=0,months=0;for(let i=11;i>=0;i--){const d=addMonths(end,-i),rows=monthRows(entries,d).filter(e=>e.type==="expense"&&!e.oneOff&&! ["資本支出","資金移轉","房貸本金"].includes(e.nature));if(rows.length||monthKey(d)<=monthKey(new Date())){total+=rows.reduce((s,e)=>s+e.amount,0);months++}}return months?total/months*12:0}
function bucketSummary(rows){const out={固定:0,生活:0,資本:0,一次性:0,移轉:0};for(const e of expenseRows(rows)){if(e.nature==="資金移轉"){out.移轉+=e.amount;continue}if(e.oneOff){out.一次性+=e.amount;continue}if(["資本支出","房貸本金"].includes(e.nature)){out.資本+=e.amount;continue}if(["固定義務","利息"].includes(e.nature)){out.固定+=e.amount;continue}out.生活+=e.amount}return out}
function byField(rows,key){const o={};for(const e of expenseRows(rows)){const k=e[key]||"未分類";o[k]=(o[k]||0)+e.amount}return Object.entries(o).sort((a,b)=>b[1]-a[1])}
function avgPriorMonths(entries,d,n=6){let total=0,count=0;for(let i=1;i<=n;i++){const r=monthRows(entries,addMonths(d,-i));if(r.length){total+=cashOut(r);count++}}return count?total/count:0}
function localInsights(entries,d=state.viewDate){const cur=monthRows(entries,d),spend=cashOut(cur),avg=avgPriorMonths(entries,d,6),cats=byField(cur,"category"),b=bucketSummary(cur),large=expenseRows(cur).filter(e=>e.amount>=30000&&(e.category==="其他"||!e.category));const arr=[];if(avg>0){const pct=(spend/avg-1)*100;arr.push(`本月現金流出 ${money(spend)}，較前 6 個有資料月份平均${pct>=0?"高":"低"} ${Math.abs(pct).toFixed(1)}%。`)}else arr.push(`本月目前記錄 ${money(spend)}。`);if(cats[0])arr.push(`最大支出類別是「${cats[0][0]}」${money(cats[0][1])}，占本月 ${spend?Math.round(cats[0][1]/spend*100):0}%。`);if(b.一次性>0)arr.push(`本月一次性支出 ${money(b.一次性)}；Base Burn 已排除這些項目。`);if(b.資本>0)arr.push(`有 ${money(b.資本)} 被辨識為資本支出／房貸本金，不等同日常消費。`);if(large.length)arr.push(`有 ${large.length} 筆 ≥ $30,000 仍在「其他」，建議補分類。`);if(!arr.length)arr.push("目前沒有足夠資料形成異常判讀。");return arr.slice(0,5)}

function adjustedExpenseRows(rows){
  return expenseRows(rows).filter(e=>!e.oneOff && !["資本支出","資金移轉","房貸本金"].includes(e.nature));
}
function adjustedSpend(rows){return adjustedExpenseRows(rows).reduce((s,e)=>s+e.amount,0)}
function annualStats(entries){
  const years=[...new Set(entries.map(e=>e.date.slice(0,4)).filter(y=>/^\d{4}$/.test(y)))].sort();
  return years.map(year=>{
    const rows=entries.filter(e=>e.date.startsWith(year+"-"));
    const b=bucketSummary(rows);
    return {year,cash:cashOut(rows),adjusted:adjustedSpend(rows),fixed:b.固定,life:b.生活,capital:b.資本,oneOff:b.一次性,transfer:b.移轉,count:rows.length};
  });
}
function completedAnnualCagr(stats){
  const current=String(new Date().getFullYear());
  const full=stats.filter(x=>x.year!==current && x.adjusted>0);
  if(full.length<2)return null;
  const first=full[0],last=full[full.length-1],years=Number(last.year)-Number(first.year);
  if(years<=0)return null;
  return {from:first.year,to:last.year,value:Math.pow(last.adjusted/first.adjusted,1/years)-1};
}
function avgPriorAdjusted(entries,d,n=6){
  let total=0,count=0;
  for(let i=1;i<=n;i++){
    const r=monthRows(entries,addMonths(d,-i));
    if(r.length){total+=adjustedSpend(r);count++}
  }
  return count?total/count:0;
}
function aiJudgement(entries,d=state.viewDate){
  const cur=monthRows(entries,d),spend=cashOut(cur),adj=adjustedSpend(cur);
  const avg=avgPriorMonths(entries,d,6),avgAdj=avgPriorAdjusted(entries,d,6);
  const b=bucketSummary(cur),cats=byField(cur,"category");
  const out=[];
  const cashPct=avg>0?(spend/avg-1)*100:null;
  const adjPct=avgAdj>0?(adj/avgAdj-1)*100:null;

  if(cashPct!==null && adjPct!==null){
    if(cashPct>15 && adjPct<10){
      out.push({tone:"good",title:"帳面支出上升，但生活成本未明顯惡化",text:`現金流出較近 6 月平均高 ${cashPct.toFixed(1)}%，但排除資本／移轉／One-off 後只變動 ${adjPct.toFixed(1)}%。`});
    }else if(adjPct>15){
      out.push({tone:"warn",title:"實質生活成本正在上升",text:`Adjusted Burn 較近 6 月平均高 ${adjPct.toFixed(1)}%，這比單純看帳面支出更值得注意。`});
    }else if(adjPct<-15){
      out.push({tone:"good",title:"本月實質生活成本下降",text:`Adjusted Burn 較近 6 月平均低 ${Math.abs(adjPct).toFixed(1)}%，不是靠資金移轉造成的假象。`});
    }else{
      out.push({tone:"neutral",title:"家庭生活成本大致穩定",text:`Adjusted Burn 與近 6 月平均差異 ${Math.abs(adjPct).toFixed(1)}%，目前沒有明顯結構性惡化。`});
    }
  }
  if(b.一次性+b.資本>0){
    out.push({tone:"neutral",title:"大額支出要和生活費分開看",text:`本月一次性＋資本支出 ${money(b.一次性+b.資本)}，Home Flow 已將它與 Base Burn 分離。`});
  }
  if(cats[0]&&spend>0){
    out.push({tone:"neutral",title:`本月最大類別：${cats[0][0]}`,text:`${money(cats[0][1])}，占總現金流出 ${Math.round(cats[0][1]/spend*100)}%。`});
  }
  const flexible=adjustedExpenseRows(cur).filter(e=>e.nature==="生活消費").reduce((s,e)=>s+e.amount,0);
  if(adj>0)out.push({tone:"neutral",title:"真正可調整的空間",text:`本月生活消費約 ${money(flexible)}，占 Adjusted Burn ${Math.round(flexible/adj*100)}%。這部分才是最直接能省的錢。`});
  return out.slice(0,4);
}
function guessCategory(e){
  const t=`${e.legacyCategory} ${e.note} ${e.project}`.toLowerCase();
  if(/早餐|午餐|晚餐|餐|便當|飲料|咖啡|超商|全聯|costco|好市多|食品|水果|零食|麥當勞|星巴克/.test(t))return "食";
  if(/衣|鞋|服飾|uniqlo|zara|包包/.test(t))return "衣";
  if(/房租|房貸|管理費|水費|電費|瓦斯|家具|家電|ikea|冷氣|冰箱|電視|裝潢|修繕/.test(t))return "住";
  if(/加油|停車|高鐵|台鐵|uber|計程車|捷運|機票|交通|車票|機車|汽車/.test(t))return "行";
  if(/學費|幼兒園|托嬰|書|課程|補習|教育|文具/.test(t))return "育";
  if(/電影|遊戲|玩具|旅遊|旅行|住宿|飯店|娛樂|樂園/.test(t))return "樂";
  return null;
}
function guessNature(e){
  const t=`${e.legacyCategory} ${e.note} ${e.project}`.toLowerCase();
  if(/房貸本金|本金/.test(t))return "房貸本金";
  if(/利息/.test(t))return "利息";
  if(/裝潢|交屋|冷氣|冰箱|電視|家具|家電|沙發|床墊|ikea/.test(t))return "資本支出";
  if(/轉帳|匯款|入金|出金|投資|股票|etf|定存|質押|借款/.test(t))return "資金移轉";
  if(/保險|保費|房租|管理費|孝親|孲費|幼兒園|托嬰|網路|電信|電話費/.test(t))return "固定義務";
  return null;
}
function doctorIssues(entries){
  const issues=[];
  for(const e of expenseRows(entries)){
    const suggestion={};const reasons=[];
    const cat=guessCategory(e),nat=guessNature(e);
    if((e.category==="其他"||!e.category) && cat && cat!==e.category){suggestion.category=cat;reasons.push(`分類建議 → ${cat}`)}
    if(nat && nat!==e.nature){suggestion.nature=nat;reasons.push(`Nature 建議 → ${nat}`)}
    const largeHint=e.amount>=30000 && !e.oneOff && (nat==="資本支出" || e.project!=="日常生活" || /裝潢|交屋|醫療|手術|旅行|旅遊|家電|家具/.test(`${e.legacyCategory} ${e.note} ${e.project}`));
    if(largeHint){suggestion.oneOff=true;reasons.push("大額支出建議標記 One-off")}
    if(reasons.length)issues.push({entry:e,suggestion,reasons,score:Object.keys(suggestion).length});
  }
  return issues.sort((a,b)=>b.score-a.score||b.entry.amount-a.entry.amount);
}
async function applyDoctorFix(id){
  const issue=doctorIssues(effectiveEntries()).find(x=>x.entry.id===id);
  if(!issue)return;
  const e=issue.entry,updated=normalizeEntry({...e,...issue.suggestion,updatedAt:nowIso()});
  await syncMutation(n=>{
    const i=n.entries.findIndex(x=>x.id===e.id);
    if(i>=0)n.entries[i]=updated;else n.entries.push(updated);
  });
}


function nav(){ $$(".nav button").forEach(b=>b.classList.toggle("active",b.dataset.tab===state.tab)) }
function setTab(tab){state.tab=tab;state.listLimit=80;render();window.scrollTo({top:0,behavior:"smooth"})}
function periodNav(){return `<div class="period-nav"><button data-period="-1">←</button><div class="period-title">${state.viewDate.getFullYear()} 年 ${state.viewDate.getMonth()+1} 月</div><button data-period="1">→</button></div>`}
function entriesHtml(rows,limit=5){if(!rows.length)return'<div class="empty">目前沒有紀錄</div>';return rows.slice(0,limit).map(e=>`<div class="entry"><div class="entry-main"><div class="entry-title">${esc(e.legacyCategory||e.category)} <span class="tag">${esc(e.category)}</span><span class="tag nature">${esc(e.nature)}</span>${e.project&&e.project!=="日常生活"?`<span class="tag project">${esc(e.project)}</span>`:""}</div><div class="entry-meta">${e.date} · ${esc(e.account)}${e.note?" · "+esc(e.note):""}${e.oneOff?" · One-off":""}</div></div><div class="entry-side"><div class="entry-amount">${e.type==="income"?"+":"−"}${money(e.amount)}</div><div class="entry-actions"><button data-edit="${esc(e.id)}">編輯</button><button data-delete="${esc(e.id)}">刪除</button></div></div></div>`).join("")}
function barsHtml(items,total,max=7){if(!items.length)return'<div class="empty">沒有資料</div>';const peak=Math.max(...items.map(x=>x[1]),1);return`<div class="bar-list">${items.slice(0,max).map(([name,v])=>`<div class="bar-row"><b>${esc(name)}</b><div class="bar-track"><i style="width:${Math.max(3,v/peak*100)}%"></i></div><span>${money(v)}</span></div>`).join("")}</div>`}

function renderHome(entries){const m=monthRows(entries),y=yearRows(entries),mSpend=cashOut(m),ySpend=cashOut(y),bb=baseBurn(entries),ins=localInsights(entries)[0],cats=Object.fromEntries(byField(m,"category"));$("#content").innerHTML=`${periodNav()}<section class="card hero"><div class="hero-head"><div><small>FAMILY CASHFLOW</small><h2>錢流去哪裡，一眼看懂</h2></div><span>${historyEntries.length?`${historyEntries.length.toLocaleString()} 筆歷史`:`新帳本`}</span></div><div class="stats"><div class="stat"><span>本月</span><strong>${shortMoney(mSpend)}</strong><small>Cash Outflow</small></div><div class="stat"><span>本年</span><strong>${shortMoney(ySpend)}</strong><small>${state.viewDate.getFullYear()}</small></div><div class="stat"><span>Base Burn</span><strong>${shortMoney(bb)}</strong><small>年化估算</small></div></div></section><section class="card"><div class="section-head"><h2>本月結構</h2><span>食・衣・住・行・育・樂</span></div><div class="bucket-grid">${["食","衣","住","行","育","樂","其他"].map(k=>`<div class="bucket"><span>${k}</span><b>${shortMoney(cats[k]||0)}</b></div>`).join("")}</div></section><section class="card ai-card"><span class="badge">✨ AI 分析</span><p>${esc(ins)}</p><small>本機運算 · 不呼叫付費 AI API · 不上傳歷史明細</small><button class="link-btn" data-go-analysis style="margin-top:9px">看完整分析 →</button></section><section class="card"><div class="section-head"><h2>最近紀錄</h2><button class="link-btn" data-go-list>全部明細</button></div>${entriesHtml(entries,6)}</section>`}

function formOptions(values,selected){return values.map(x=>`<option value="${esc(x)}" ${x===selected?"selected":""}>${esc(x)}</option>`).join("")}
function renderAdd(entries){const e=editId?entries.find(x=>x.id===editId):null;const accounts=data.settings.accounts.length?data.settings.accounts:DEFAULT_ACCOUNTS;const projects=[...new Set([...data.settings.projects,...entries.map(x=>x.project).filter(Boolean)])];const d=e||{amount:"",category:"食",account:accounts[0],nature:"生活消費",project:"日常生活",date:localDate(),note:"",oneOff:false,legacyCategory:""};$("#content").innerHTML=`<section class="card"><div class="section-head"><h2>${e?"編輯紀錄":"記一筆"}</h2><span>快速、夠用就好</span></div><div class="amount-row"><span>$</span><input id="amount" class="amount-input" inputmode="decimal" placeholder="0" value="${e?e.amount:""}"></div><div class="chips">${EXPENSE_CATS.slice(0,6).map(c=>`<button class="chip ${d.category===c?"active":""}" data-cat="${c}">${c}</button>`).join("")}</div><div class="form-grid"><label class="field"><span>分類</span><select id="category">${formOptions(EXPENSE_CATS,d.category)}</select></label><label class="field"><div class="field-head"><span>付款帳戶</span><button class="mini-link" data-edit-accounts>編輯</button></div><select id="account">${formOptions(accounts,d.account)}</select></label><label class="field"><span>Nature｜支出性質</span><select id="nature">${formOptions(NATURES,d.nature)}</select></label><label class="field"><div class="field-head"><span>Project</span><button class="mini-link" data-edit-projects>編輯</button></div><select id="project">${formOptions(projects,d.project)}</select></label><label class="field"><span>日期</span><input id="date" type="date" value="${d.date}"></label><label class="field"><span>項目 / 舊分類</span><input id="legacyCategory" maxlength="80" value="${esc(d.legacyCategory||"")}" placeholder="例：全聯、加油、房貸"></label><label class="field" style="grid-column:1/-1"><span>備註</span><input id="note" maxlength="240" value="${esc(d.note||"")}" placeholder="店家、用途、補充"></label><label class="toggle-row" style="grid-column:1/-1"><span><b>One-off</b><br><small>裝潢、交屋、大型醫療等一次性支出</small></span><input id="oneOff" type="checkbox" ${d.oneOff?"checked":""}></label></div><div class="form-actions"><button id="saveEntry" class="primary">${e?"儲存修改":"＋ 記一筆"}</button>${e?'<button class="outline" data-cancel-edit>取消</button>':""}</div></section><section class="card"><div class="section-head"><h3>Nature 怎麼用？</h3><span>核心</span></div><p class="tiny">生活消費 / 固定義務 / 房貸本金 / 利息 / 資本支出 / 資金移轉。Home Flow 會用它把「現金流出」拆成真正消費與資產移轉，Base Burn 會排除資本支出、房貸本金、資金移轉與 One-off。</p></section>`}

function monthlySeries(entries,end=state.viewDate,n=12){const arr=[];for(let i=n-1;i>=0;i--){const d=addMonths(end,-i);arr.push([monthKey(d),cashOut(monthRows(entries,d))])}return arr}
function renderAnalysis(entries){
  const mode=state.analysisMode;
  const tabs=`<div class="analysis-tabs">
    <button data-analysis-mode="cockpit" class="${mode==="cockpit"?"active":""}">年度</button>
    <button data-analysis-mode="ai" class="${mode==="ai"?"active":""}">AI 判讀</button>
    <button data-analysis-mode="doctor" class="${mode==="doctor"?"active":""}">Data Doctor</button>
  </div>`;

  if(mode==="cockpit"){
    const stats=annualStats(entries),cagr=completedAnnualCagr(stats),peak=Math.max(...stats.map(x=>x.adjusted),1);
    const rows=stats.map(x=>`<div class="annual-row">
      <div><b>${x.year}${x.year===String(new Date().getFullYear())?" YTD":""}</b><small>${x.count.toLocaleString()} 筆</small></div>
      <div class="annual-bar"><i style="width:${Math.max(2,x.adjusted/peak*100)}%"></i></div>
      <div><strong>${shortMoney(x.adjusted)}</strong><small>帳面 ${shortMoney(x.cash)}</small></div>
    </div>`).join("");
    const latest=stats[stats.length-1]||{cash:0,adjusted:0,capital:0,oneOff:0};
    $("#content").innerHTML=`${tabs}<section class="card hero"><div class="section-head"><h2>年度財務 Cockpit</h2><span>2019 → ${new Date().getFullYear()}</span></div>
      <div class="stats"><div class="stat"><span>今年帳面支出</span><strong>${shortMoney(latest.cash)}</strong></div><div class="stat"><span>Adjusted Burn</span><strong>${shortMoney(latest.adjusted)}</strong></div><div class="stat"><span>長期 CAGR</span><strong>${cagr?`${(cagr.value*100).toFixed(1)}%`:"—"}</strong><small>${cagr?`${cagr.from}–${cagr.to}`:"完整年度不足"}</small></div></div>
    </section><section class="card"><div class="section-head"><h2>年度生活成本</h2><span>排除資本 / 移轉 / One-off</span></div><div class="annual-list">${rows}</div></section>
    <section class="card"><div class="section-head"><h2>今年結構</h2><span>YTD</span></div><div class="metric-grid"><div class="metric"><span>Adjusted Burn</span><b>${money(latest.adjusted)}</b></div><div class="metric"><span>資本支出</span><b>${money(latest.capital)}</b></div><div class="metric"><span>One-off</span><b>${money(latest.oneOff)}</b></div><div class="metric"><span>Cash Outflow</span><b>${money(latest.cash)}</b></div></div></section>`;
    return;
  }

  if(mode==="doctor"){
    const issues=doctorIssues(entries),other=expenseRows(entries).filter(e=>e.category==="其他").length,large=expenseRows(entries).filter(e=>e.amount>=30000&&!e.oneOff).length;
    $("#content").innerHTML=`${tabs}<section class="card"><div class="section-head"><h2>Data Doctor</h2><span>${issues.length.toLocaleString()} 個可修正項目</span></div>
      <div class="doctor-summary"><div><b>${other}</b><span>其他分類</span></div><div><b>${large}</b><span>大額未 One-off</span></div><div><b>${issues.length}</b><span>有明確建議</span></div></div>
      <p class="tiny">只在規則有明確線索時提出建議；Home Flow 不會自動亂改 8 年舊帳。</p></section>
      <section class="card"><div class="section-head"><h2>待檢查</h2><span>先顯示 60 筆</span></div>
      ${issues.length?issues.slice(0,60).map(x=>`<div class="doctor-item"><div><b>${esc(x.entry.legacyCategory||x.entry.category)}</b><small>${x.entry.date} · ${money(x.entry.amount)} · ${esc(x.entry.account)}</small><p>${x.reasons.map(esc).join(" · ")}</p></div><button data-doctor-fix="${esc(x.entry.id)}">採用建議</button></div>`).join(""):'<div class="empty">目前沒有高信心修正建議。</div>'}</section>`;
    return;
  }

  const m=monthRows(entries),judges=aiJudgement(entries),series=monthlySeries(entries),max=Math.max(...series.map(x=>x[1]),1),cats=byField(m,"category"),nature=byField(m,"nature");
  $("#content").innerHTML=`${tabs}${periodNav()}<section class="card ai-card"><span class="badge">✨ AI 家庭財務判讀</span>
    <div class="judgement-list">${judges.map(j=>`<div class="judgement ${j.tone}"><b>${esc(j.title)}</b><p>${esc(j.text)}</p></div>`).join("")}</div>
    <p class="tiny">規則＋統計式本機分析；重點是判斷「支出變動是不是生活成本惡化」，不把 8 年明細傳給外部 AI。</p></section>
    <section class="card"><div class="section-head"><h2>12 個月趨勢</h2><span>現金流出</span></div><div class="month-bars">${series.map(([k,v])=>`<div class="month-col" title="${k} ${money(v)}"><i style="height:${Math.max(2,v/max*105)}px"></i><span>${k.slice(5)}</span></div>`).join("")}</div></section>
    <section class="card"><div class="section-head"><h2>本月類別</h2><span>Top Categories</span></div>${barsHtml(cats,cashOut(m),7)}</section>
    <section class="card"><div class="section-head"><h2>Nature</h2><span>支出性質</span></div>${barsHtml(nature,cashOut(m),8)}</section>`;
}


function renderProjects(entries){const groups={};for(const e of expenseRows(entries)){if(e.project==="日常生活")continue;(groups[e.project]??={sum:0,count:0}).sum+=e.amount;groups[e.project].count++}const cards=Object.entries(groups).sort((a,b)=>b[1].sum-a[1].sum).map(([name,g])=>`<div class="project-card"><button class="project-open" data-project-open="${esc(name)}"><div class="project-head"><div><b>${esc(name)}</b><span>主帳 ${g.count} 筆 · 點一下看明細</span></div><strong>${money(g.sum)}</strong></div></button></div>`).join("");const refs=(historyPayload.projectDetails||[]).map(p=>`<details class="project-card ref"><summary><div class="project-head"><div><b>${esc(p.name)}</b><span>${esc(p.kind)} · 專案參考明細，不重複加入主帳</span></div><strong>${money(p.referenceTotal)}</strong></div></summary>${p.items.map(i=>`<div class="ref-row"><span>${esc(i.name)}${i.memo?`<div class="ref-note">${esc(i.memo)}</div>`:""}</span><b>${money(i.amount)}</b></div>`).join("")}</details>`).join("");$("#content").innerHTML=`<section class="card"><div class="section-head"><h2>Project 專案帳</h2><span>同一筆只算一次</span></div><p class="tiny">主帳是唯一交易來源；東京行、裝潢原始獨立表只作為專案參考明細，避免重複計算。</p></section>${cards||'<div class="empty">目前沒有專案交易</div>'}<section class="card"><div class="section-head"><h2>原始專案表</h2><span>Reference</span></div>${refs||'<div class="empty">歷史專案資料尚未解鎖</div>'}</section>`}

function filteredList(entries){let r=entries;const q=state.search.trim().toLowerCase();if(q)r=r.filter(e=>[e.legacyCategory,e.note,e.account,e.project,e.category,e.nature,e.date].join(" ").toLowerCase().includes(q));const f=state.filters;if(f.year!=="全部")r=r.filter(e=>e.date.startsWith(f.year+"-"));if(f.category!=="全部")r=r.filter(e=>e.category===f.category);if(f.nature!=="全部")r=r.filter(e=>e.nature===f.nature);if(f.project!=="全部")r=r.filter(e=>e.project===f.project);return r}
function renderList(entries){const years=["全部",...new Set(entries.map(e=>e.date.slice(0,4)))].sort((a,b)=>a==="全部"?-1:b.localeCompare(a)),projects=["全部",...new Set(entries.map(e=>e.project).filter(Boolean))],rows=filteredList(entries);$("#content").innerHTML=`<section class="search"><span>⌕</span><input id="searchBox" placeholder="搜尋 Costco、日本、房貸、店家…" value="${esc(state.search)}"></section><div class="filter-grid"><div class="filter"><select id="yearFilter">${formOptions(years,state.filters.year)}</select></div><div class="filter"><select id="categoryFilter">${formOptions(["全部",...EXPENSE_CATS],state.filters.category)}</select></div><div class="filter"><select id="natureFilter">${formOptions(["全部",...NATURES],state.filters.nature)}</select></div><div class="filter"><select id="projectFilter">${formOptions(projects,state.filters.project)}</select></div></div><div class="result-note">找到 ${rows.length.toLocaleString()} 筆 · 合計 ${money(cashOut(rows))}</div><section class="card">${entriesHtml(rows,state.listLimit)}${rows.length>state.listLimit?'<button class="load-more" data-load-more>再顯示 80 筆</button>':""}</section><section class="card"><div class="section-head"><h2>資料工具</h2><span>你的資料可帶走</span></div><div class="tools"><button data-export-csv>匯出全部 CSV</button><button data-export-json>備份修改資料</button><label>匯入備份<input id="importBackup" type="file" accept="application/json" hidden></label></div><p class="tiny">歷史原始資料已加密內建；JSON 備份主要保存你之後新增、修改、刪除的差異與自訂帳戶/專案。</p></section>`}

function render(){nav();const entries=effectiveEntries();if(state.tab==="home")renderHome(entries);else if(state.tab==="add")renderAdd(entries);else if(state.tab==="analysis")renderAnalysis(entries);else if(state.tab==="projects")renderProjects(entries);else renderList(entries);bindViewEvents(entries)}

function editAccounts(){const cur=data.settings.accounts.join(", "),v=prompt("編輯付款帳戶（用逗號分隔）",cur);if(v===null)return;const arr=[...new Set(v.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean))].slice(0,30);if(!arr.length)return;syncMutation(n=>{n.settings={...n.settings,accounts:arr};n.settingsUpdatedAt=nowIso()})}
function editProjects(){const cur=data.settings.projects.join(", "),v=prompt("編輯 Project（用逗號分隔）",cur);if(v===null)return;const arr=[...new Set(v.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean))].slice(0,40);if(!arr.length)return;syncMutation(n=>{n.settings={...n.settings,projects:arr};n.settingsUpdatedAt=nowIso()})}
async function saveEntry(){const amount=Number($("#amount")?.value);if(!(amount>0)){$("#amount")?.focus();return}const old=editId?effectiveEntries().find(e=>e.id===editId):null;const draft={id:editId||uid(),type:old?.type||"expense",amount,date:$("#date").value||localDate(),category:$("#category").value,legacyCategory:$("#legacyCategory").value.trim(),account:$("#account").value,nature:$("#nature").value,project:$("#project").value,note:$("#note").value.trim(),oneOff:$("#oneOff").checked,imported:old?.imported||false,source:old?.source||"",sourceRow:old?.sourceRow||0,createdAt:old?.createdAt||nowIso(),updatedAt:nowIso()};const ok=await syncMutation(n=>{const i=n.entries.findIndex(e=>e.id===draft.id);if(i>=0)n.entries[i]=normalizeEntry(draft);else n.entries.push(normalizeEntry(draft))});if(ok){editId=null;state.tab="home";render()}}
function startEdit(id){editId=id;state.tab="add";render()}
async function removeEntry(id){if(!confirm("刪除這筆紀錄？"))return;await syncMutation(n=>{n.entries=n.entries.filter(e=>e.id!==id);n.tombstones[id]=nowIso()})}
function csvValue(v){return `"${String(v??"").replaceAll('"','""')}"`}
function exportCsv(){const rows=[["日期","類型","分類","原始項目","付款帳戶","Nature","Project","One-off","金額","備註","來源"]];effectiveEntries().slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(e=>rows.push([e.date,e.type,e.category,e.legacyCategory,e.account,e.nature,e.project,e.oneOff?"Y":"",e.amount,e.note,e.source]));const csv="\ufeff"+rows.map(r=>r.map(csvValue).join(",")).join("\n"),a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download=`home-flow-all-${localDate()}.csv`;a.click();URL.revokeObjectURL(a.href)}
function exportBackup(){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify({format:"homeflow-backup-v1",data},null,2)],{type:"application/json"}));a.download=`home-flow-backup-${localDate()}.json`;a.click();URL.revokeObjectURL(a.href)}
function importBackup(file){if(!file)return;const r=new FileReader();r.onload=async()=>{try{const j=JSON.parse(r.result);if(j.format!=="homeflow-backup-v1")throw new Error();if(!confirm("匯入會合併這份 Home Flow 修改資料，確定？"))return;await syncMutation(n=>Object.assign(n,mergeData(n,j.data)));}catch{alert("備份格式不正確")}};r.readAsText(file)}
async function shareBook(){try{const url=location.href;if(navigator.share)await navigator.share({title:"Home Flow",text:"我們的家庭現金流帳本。完整網址包含解密鑰匙，請勿公開轉傳。",url});else{await navigator.clipboard.writeText(url);setStatus("完整共用網址已複製","ok")}}catch{}}

function bindViewEvents(entries){
  $$('[data-period]').forEach(b=>b.onclick=()=>{state.viewDate=addMonths(state.viewDate,Number(b.dataset.period));render()});
  $$('[data-edit]').forEach(b=>b.onclick=()=>startEdit(b.dataset.edit));
  $$('[data-delete]').forEach(b=>b.onclick=()=>removeEntry(b.dataset.delete));
  $$('[data-cat]').forEach(b=>b.onclick=()=>{$("#category").value=b.dataset.cat;$$('[data-cat]').forEach(x=>x.classList.toggle("active",x===b))});
  $$('[data-analysis-mode]').forEach(b=>b.onclick=()=>{state.analysisMode=b.dataset.analysisMode;render()});
  $$('[data-doctor-fix]').forEach(b=>b.onclick=()=>applyDoctorFix(b.dataset.doctorFix));
  $('[data-edit-accounts]')?.addEventListener('click',e=>{e.preventDefault();editAccounts()});
  $('[data-edit-projects]')?.addEventListener('click',e=>{e.preventDefault();editProjects()});
  $("#saveEntry")?.addEventListener("click",saveEntry);
  $('[data-cancel-edit]')?.addEventListener('click',()=>{editId=null;setTab('home')});
  $('[data-go-analysis]')?.addEventListener('click',()=>setTab('analysis'));
  $('[data-go-list]')?.addEventListener('click',()=>setTab('list'));
  $$('[data-project-open]').forEach(b=>b.onclick=()=>{state.filters.project=b.dataset.projectOpen;state.tab='list';render()});
  const sb=$("#searchBox");
  if(sb)sb.oninput=()=>{state.search=sb.value;state.listLimit=80;renderList(effectiveEntries());bindViewEvents(effectiveEntries());$("#searchBox")?.focus();try{$("#searchBox").setSelectionRange(state.search.length,state.search.length)}catch{}};
  for(const[id,key]of[["yearFilter","year"],["categoryFilter","category"],["natureFilter","nature"],["projectFilter","project"]])$("#"+id)?.addEventListener("change",e=>{state.filters[key]=e.target.value;state.listLimit=80;render()});
  $('[data-load-more]')?.addEventListener('click',()=>{state.listLimit+=80;render()});
  $('[data-export-csv]')?.addEventListener('click',exportCsv);
  $('[data-export-json]')?.addEventListener('click',exportBackup);
  $("#importBackup")?.addEventListener("change",e=>importBackup(e.target.files?.[0]))
}


async function init(){if(!window.crypto?.subtle){setStatus("此瀏覽器不支援加密功能","error");return}setStatus("正在解鎖 2019–2026 歷史帳本…");try{await loadHistory()}catch(e){console.error(e);setStatus("歷史資料尚未完整發布；新帳仍可使用","warn")}try{await bootRemote();setStatus(historyEntries.length?`已載入 ${historyEntries.length.toLocaleString()} 筆歷史 · 加密共用`:"Home Flow 已同步 · 歷史資料未解鎖","ok")}catch(e){console.error(e);remoteReady=false;data=normalizeData(JSON.parse(localStorage.getItem("homeflow-local-overrides")||"null"));setStatus(historyEntries.length?`已載入 ${historyEntries.length.toLocaleString()} 筆歷史 · 本機模式`:"本機模式 · 歷史資料未解鎖","warn")}render();setInterval(()=>{if(document.visibilityState==="visible")refreshRemote(true)},15000)}

$$('.nav button').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));$("#shareBtn").onclick=shareBook;document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")refreshRemote(false)});init();
