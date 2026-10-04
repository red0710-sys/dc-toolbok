const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// Cloud backend: same-origin Cloudflare Worker + D1 encrypted snapshots
const HISTORY = { chunks: 7, iv: "_ibeQ4Z7LKmugB90", aad: "homeflow-history-v1" };
const EXPENSE_CATS = ["食","衣","住","行","育","樂","其他"];
const NATURES = ["生活消費","房屋相關","家庭孝親","育兒教育","保險相關","手機等服務"];
const FIXED_OBLIGATION_CATS = ["房屋相關","家庭孝親","育兒教育","保險相關","手機等服務"];
const DEFAULT_ACCOUNTS = ["Cash","國泰","台新","富邦","UBOT","ES","中信","一銀","其他"];
const DEFAULT_PROJECTS = ["日常生活","旅行","東京 2026","聯悅臻裝潢","其他"];

let historyPayload = { meta:{count:0,annual:{}}, entries:[], projectDetails:[] };
let historyEntries = [];
let data = null;
let storageId = null;
let keyText = null;
let cryptoKey = null;
let remoteReady = false;
let cloudClient = null;
let remoteVersion = null;
let saving = false;
let refreshing = false;
let editId = null;

const state = {
  tab: "home",
  viewDate: new Date(),
  search: "",
  filters: { year:"全部", category:"全部", nature:"全部", project:"全部" },
  listLimit: 80,
  analysisMode: "cockpit",
  aiMessages: []
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

function defaultData(){return{version:6,settings:{accounts:[...DEFAULT_ACCOUNTS],projects:[...DEFAULT_PROJECTS],natures:[...NATURES]},settingsUpdatedAt:"1970-01-01T00:00:00.000Z",entries:[],tombstones:{},modifiedAt:nowIso()}}
function normalizeEntry(e){return{
  id:String(e.id||""),type:e.type==="income"?"income":"expense",amount:Math.max(0,Number(e.amount)||0),date:/^\d{4}-\d{2}-\d{2}$/.test(String(e.date||""))?String(e.date):localDate(),
  category:String(e.category||"其他").slice(0,30),legacyCategory:String(e.legacyCategory||"").slice(0,80),account:String(e.account||"未指定").slice(0,30),nature:String(e.nature||"生活消費").slice(0,30),obligationCategory:"",project:String(e.project||"日常生活").slice(0,50),note:String(e.note||"").slice(0,240),oneOff:!!e.oneOff,
  imported:!!e.imported,source:String(e.source||""),sourceRow:Number(e.sourceRow)||0,createdAt:String(e.createdAt||nowIso()),updatedAt:String(e.updatedAt||e.createdAt||nowIso())
}}
function normalizeData(input){const base=defaultData();if(!input||typeof input!=="object")return base;const s=input.settings||{};const removedNatures=new Set(["房貸本金","利息","資本支出","資金移轉","固定義務"]);base.settings.accounts=[...new Set((Array.isArray(s.accounts)?s.accounts:DEFAULT_ACCOUNTS).map(x=>String(x).trim()).filter(Boolean))].slice(0,30);base.settings.projects=[...new Set((Array.isArray(s.projects)?s.projects:DEFAULT_PROJECTS).map(x=>String(x).trim()).filter(Boolean))].slice(0,40);base.settings.natures=[...new Set((Array.isArray(s.natures)?s.natures:NATURES).map(x=>String(x).trim()).filter(x=>x&&!removedNatures.has(x)))];if(!base.settings.natures.length)base.settings.natures=[...NATURES];base.settings.natures=base.settings.natures.slice(0,30);base.settingsUpdatedAt=String(input.settingsUpdatedAt||base.settingsUpdatedAt);base.entries=Array.isArray(input.entries)?input.entries.map(normalizeEntry).filter(e=>e.id&&e.amount>0):[];base.tombstones=input.tombstones&&typeof input.tombstones==="object"?{...input.tombstones}:{};base.modifiedAt=String(input.modifiedAt||base.modifiedAt);return base}
function maxIso(a,b){return String(a||"")>=String(b||"")?String(a||""):String(b||"")}
function mergeData(a0,b0){const a=normalizeData(a0),b=normalizeData(b0),m=defaultData();if(a.settingsUpdatedAt>=b.settingsUpdatedAt){m.settings=a.settings;m.settingsUpdatedAt=a.settingsUpdatedAt}else{m.settings=b.settings;m.settingsUpdatedAt=b.settingsUpdatedAt}m.tombstones={...a.tombstones};for(const[id,t]of Object.entries(b.tombstones))m.tombstones[id]=maxIso(m.tombstones[id],t);const map=new Map();for(const e of[...a.entries,...b.entries]){const cur=map.get(e.id);if(!cur||e.updatedAt>cur.updatedAt)map.set(e.id,e)}m.entries=[...map.values()].filter(e=>!m.tombstones[e.id]||e.updatedAt>m.tombstones[e.id]);m.modifiedAt=maxIso(a.modifiedAt,b.modifiedAt);return m}

async function readRemote(){
  if(!cloudClient)throw new Error("cloud unavailable");
  const r=await cloudClient.read();remoteVersion=r.version||null;
  return r.data?normalizeData(r.data):defaultData();
}
async function writeRemote(next){
  if(!cloudClient)throw new Error("cloud unavailable");
  const r=await cloudClient.write(next,remoteVersion);
  if(r.conflict){const e=new Error("version conflict");e.code="VERSION_CONFLICT";throw e}
  remoteVersion=r.version;return r;
}
function saveLocal(){localStorage.setItem("homeflow-local-overrides",JSON.stringify(data));window.HomeFlowLocal?.save(data).catch?.(()=>{})}
async function loadLocal(){const idb=await window.HomeFlowLocal?.load?.();if(idb)return idb;try{return JSON.parse(localStorage.getItem("homeflow-local-overrides")||"null")}catch{return null}}
async function bootRemote(){
  if(!window.HomeFlowCloud)throw new Error("cloud client missing");
  cloudClient=await window.HomeFlowCloud.connect({createIfMissing:true});
  const local=normalizeData(await loadLocal());
  const remote=await cloudClient.read();remoteVersion=remote.version||null;
  const remoteData=remote.data?normalizeData(remote.data):null;
  data=remoteData?mergeData(local,remoteData):local;
  const needsUpload=!remoteData||JSON.stringify(data)!==JSON.stringify(remoteData);
  if(needsUpload){
    const written=await cloudClient.write(data,remoteVersion);
    if(written.conflict){
      const latest=await cloudClient.read();remoteVersion=latest.version||null;data=mergeData(data,latest.data||defaultData());
      const retry=await cloudClient.write(data,remoteVersion);if(retry.conflict)throw new Error("initial sync conflict");remoteVersion=retry.version;
    }else remoteVersion=written.version;
  }
  remoteReady=true;saveLocal();
}
async function syncMutation(mutator){
  if(saving)return false;saving=true;setStatus(remoteReady?"加密同步中…":"本機儲存中…");
  try{
    for(let attempt=0;attempt<3;attempt++){
      let next=normalizeData(data);
      if(remoteReady){try{next=mergeData(data,await readRemote())}catch{next=normalizeData(data)}}
      await mutator(next);next.modifiedAt=nowIso();
      if(remoteReady){
        try{await writeRemote(next)}
        catch(e){if(e.code==="VERSION_CONFLICT"&&attempt<2)continue;throw e}
      }
      data=next;saveLocal();render();setStatus(remoteReady?"已同步 · 端到端加密":"本機模式 · 已儲存",remoteReady?"ok":"warn");return true;
    }
    throw new Error("sync retry exhausted");
  }catch(e){console.error(e);setStatus("儲存失敗；資料仍保留在本機","error");return false}
  finally{saving=false}
}
async function refreshRemote(silent=true){
  if(!remoteReady||saving||refreshing)return;refreshing=true;
  try{
    const r=await readRemote(),m=mergeData(data,r),needsUpload=JSON.stringify(m)!==JSON.stringify(r);
    data=m;saveLocal();
    if(needsUpload){
      try{await writeRemote(m)}
      catch(e){if(e.code==="VERSION_CONFLICT"){const latest=await readRemote();data=mergeData(data,latest);saveLocal()}else throw e}
    }
    render();if(!silent)setStatus("已同步最新家庭帳本","ok");
  }catch(e){console.warn("refresh failed",e);remoteReady=false;if(!silent)setStatus("離線模式 · 變更會先保留在本機","warn")}
  finally{refreshing=false}
}
async function ensureRemote(silent=true){
  if(saving||refreshing)return;
  if(remoteReady)return refreshRemote(silent);
  try{await bootRemote();render();if(!silent)setStatus("已重新連線並同步","ok")}
  catch(e){console.warn("cloud reconnect failed",e);if(!silent)setStatus("離線模式 · 資料仍可使用","warn")}
}

async function loadHistory(){const hk=historyKeyText();if(!hk){setStatus("已開啟 · 歷史資料尚未解鎖","warn");return}storeHistoryKey(hk);if(typeof DecompressionStream==="undefined")throw new Error("Browser does not support gzip stream");const key=await importAesKey(hk);const urls=Array.from({length:HISTORY.chunks},(_,i)=>`./data/history-${String(i).padStart(2,"0")}.txt?v=1`);const parts=await Promise.all(urls.map(async u=>{const r=await fetch(u,{cache:"force-cache"});if(!r.ok)throw new Error(`history chunk ${u} missing`);return(await r.text()).trim()}));const encrypted=fromB64url(parts.join(""));const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64url(HISTORY.iv),additionalData:new TextEncoder().encode(HISTORY.aad)},key,encrypted);const ds=new DecompressionStream("gzip"),stream=new Blob([plain]).stream().pipeThrough(ds),buf=await new Response(stream).arrayBuffer();historyPayload=JSON.parse(new TextDecoder().decode(buf));historyEntries=(historyPayload.entries||[]).map(row=>{const[d,a,t,c,lc,acc,nat,proj,note,src,srow,flags]=row;return normalizeEntry({id:`hist-${src.replace(/\W+/g,"-")}-${srow}`,date:d,amount:a,type:t,category:c,legacyCategory:lc,account:acc,nature:nat,project:proj,note,source:src,sourceRow:srow,oneOff:!!(flags&1),imported:true,createdAt:`${d}T00:00:00.000Z`,updatedAt:`${d}T00:00:00.000Z`})});}
function effectiveEntries(){const map=new Map(historyEntries.map(e=>[e.id,e]));for(const e of(data?.entries||[]))map.set(e.id,e);const tomb=data?.tombstones||{};return[...map.values()].filter(e=>!tomb[e.id]||e.updatedAt>tomb[e.id]).sort((a,b)=>b.date.localeCompare(a.date)||b.updatedAt.localeCompare(a.updatedAt))}
function expenseRows(rows){return rows.filter(e=>e.type==="expense")}
function cashOut(rows){return expenseRows(rows).reduce((s,e)=>s+e.amount,0)}
function monthRows(entries,d=state.viewDate){const k=monthKey(d);return entries.filter(e=>e.date.startsWith(k))}
function yearRows(entries,d=state.viewDate){const y=String(d.getFullYear());return entries.filter(e=>e.date.startsWith(y+"-"))}
function addMonths(date,n){return new Date(date.getFullYear(),date.getMonth()+n,1)}
function baseBurn(entries,end=state.viewDate){let total=0,months=0;for(let i=11;i>=0;i--){const d=addMonths(end,-i),rows=monthRows(entries,d).filter(e=>e.type==="expense"&&!e.oneOff&&! ["資本支出","資金移轉","房貸本金"].includes(e.nature));if(rows.length||monthKey(d)<=monthKey(new Date())){total+=rows.reduce((s,e)=>s+e.amount,0);months++}}return months?total/months*12:0}
function bucketSummary(rows){const out={固定:0,生活:0,資本:0,一次性:0,移轉:0};for(const e of expenseRows(rows)){if(e.nature==="資金移轉"){out.移轉+=e.amount;continue}if(e.oneOff){out.一次性+=e.amount;continue}if(["資本支出","房貸本金"].includes(e.nature)){out.資本+=e.amount;continue}if(["房屋相關","家庭孝親","育兒教育","保險相關","手機等服務","利息"].includes(e.nature)){out.固定+=e.amount;continue}out.生活+=e.amount}return out}
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
  if(/房租|管理費|房屋稅|地價稅|住宅|修繕/.test(t))return "房屋相關";
  if(/孝親|扶養|父母/.test(t))return "家庭孝親";
  if(/幼兒園|托嬰|學費|教育|才藝|安親/.test(t))return "育兒教育";
  if(/保險|保費|壽險|醫療險|車險/.test(t))return "保險相關";
  if(/手機|電信|網路|電話費|訂閱|會費/.test(t))return "手機等服務";
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



function categoryRankHtml(rows){
  const total=cashOut(rows),values=Object.fromEntries(byField(rows,"category"));
  const ranked=EXPENSE_CATS.map(k=>[k,values[k]||0]).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const zeros=EXPENSE_CATS.filter(k=>(values[k]||0)===0);
  if(!ranked.length)return '<div class="empty">本月尚無支出</div>';
  return `<div class="category-rank">${ranked.map(([name,v])=>`<div class="category-rank-row"><div class="rank-label"><b>${esc(name)}</b><span>${money(v)} · ${total?Math.round(v/total*100):0}%</span></div><div class="rank-track"><i style="width:${Math.max(2,total?v/total*100:0)}%"></i></div></div>`).join("")}</div>${zeros.length?`<div class="zero-cats">$0：${zeros.map(esc).join("・")}</div>`:""}`;
}
function flowMetrics3(entries,d=state.viewDate){
  const months=monthsBack(d,6),fixedNatures=new Set(["房屋相關","家庭孝親","育兒教育","保險相關","手機等服務"]);
  let fixed=0,flex=0,count=0;
  for(const md of months){
    const rows=monthRows(entries,md).filter(e=>e.type==="expense"&&!e.oneOff);
    if(!rows.length)continue;
    fixed+=rows.filter(e=>fixedNatures.has(e.nature)).reduce((s,e)=>s+e.amount,0);
    flex+=rows.filter(e=>e.nature==="生活消費"||!e.nature).reduce((s,e)=>s+e.amount,0);
    count++;
  }
  const div=Math.max(count,1),fixedMonthly=fixed/div,flexMonthly=flex/div,baseMonthly=baseBurn(entries,d)/12;
  const cur=monthRows(entries,d),curSpend=cashOut(cur),avg=avgPriorMonths(entries,d,6);
  const deviation=avg>0?(curSpend/avg-1)*100:0;
  let score=88;
  if(deviation>25)score-=18;else if(deviation>10)score-=8;else if(deviation<-10)score+=3;
  const total=fixedMonthly+flexMonthly;if(total>0&&fixedMonthly/total>.7)score-=8;
  score=Math.max(45,Math.min(98,Math.round(score)));
  const label=score>=85?"HEALTHY":score>=70?"STABLE":score>=55?"WATCH":"ACTION";
  return{fixedMonthly,flexMonthly,baseMonthly,score,label,deviation};
}
function smartPrompts3(entries,d=state.viewDate){
  const cur=monthRows(entries,d),cats=byField(cur,"category"),m=flowMetrics3(entries,d);
  const out=[];
  if(Math.abs(m.deviation)>=10)out.push("為什麼這個月支出變化這麼大？");
  if(cats[0])out.push(`本月「${cats[0][0]}」為什麼花最多？`);
  out.push("今年支出跟去年比","最近 12 個月支出趨勢","哪些支出最容易降低？","我的 Base Burn 是多少？","家庭現金流有異常嗎？");
  return [...new Set(out)].slice(0,7);
}
function flowStatus(entries,d=state.viewDate){
  const cur=monthRows(entries,d),adj=adjustedSpend(cur),avgAdj=avgPriorAdjusted(entries,d,6),pct=avgAdj>0?(adj/avgAdj-1)*100:null;
  const first=aiJudgement(entries,d)[0];
  if(pct!==null&&pct>25)return{code:"ACTION",tone:"action",text:first?.text||"實質生活成本明顯高於近期平均。"};
  if(pct!==null&&pct>10)return{code:"WATCH",tone:"watch",text:first?.text||"實質生活成本略高於近期平均。"};
  return{code:"NORMAL",tone:"normal",text:first?.text||"目前沒有明顯異常。"};
}


function monthsBack(end,n){
  const out=[];
  for(let i=n-1;i>=0;i--)out.push(addMonths(end,-i));
  return out;
}
function queryNumber(text,def=3){
  const m=String(text).match(/(\d{1,2})\s*個?\s*月/);
  if(m)return Math.min(24,Math.max(1,Number(m[1])));
  const map={"一":1,"二":2,"兩":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,"十一":11,"十二":12};
  const c=String(text).match(/(十二|十一|十|[一二兩三四五六七八九])\s*個?\s*月/);
  return c?map[c[1]]:def;
}
function queryCategory(text){
  const t=String(text).toLowerCase();
  if(/(^|[^生])食|餐飲|餐費|伙食|吃|早餐|午餐|晚餐/.test(t))return "食";
  if(/衣|服飾|衣服|鞋/.test(t))return "衣";
  if(/住|住房|房屋|居住|家居/.test(t))return "住";
  if(/行|交通|車|加油|停車/.test(t))return "行";
  if(/育|教育|學費|托嬰|幼兒園/.test(t))return "育";
  if(/樂|娛樂|旅遊|旅行|玩具/.test(t))return "樂";
  if(/其他/.test(t))return "其他";
  return null;
}
function sumRows(rows){return expenseRows(rows).reduce((s,e)=>s+e.amount,0)}
function rowsForMonths(entries,end,n){
  const keys=new Set(monthsBack(end,n).map(monthKey));
  return entries.filter(e=>keys.has(e.date.slice(0,7)));
}
function monthlyCategorySeries(entries,end,n,category=null){
  return monthsBack(end,n).map(d=>{
    const rows=monthRows(entries,d).filter(e=>!category||e.category===category);
    return {key:monthKey(d),label:`${d.getMonth()+1}月`,value:sumRows(rows)};
  });
}
function chatMiniBars(series){
  const peak=Math.max(...series.map(x=>x.value),1);
  return `<div class="chat-chart">${series.map(x=>`<div class="chat-bar-col"><div class="chat-bar-value">${shortMoney(x.value)}</div><div class="chat-bar-wrap"><i style="height:${Math.max(3,x.value/peak*72)}px"></i></div><span>${esc(x.label)}</span></div>`).join("")}</div>`;
}
function chatAnswer(query,entries){
  const q=String(query||"").trim();
  if(!q)return{title:"你可以直接問帳本",text:"例如：show 給我看 3 個月內的食費用。"};
  const n=queryNumber(q,3),cat=queryCategory(q),now=state.viewDate;
  const yearMatch=q.match(/20\d{2}/);
  const targetYear=yearMatch?yearMatch[0]:(/去年/.test(q)?String(now.getFullYear()-1):(/今年/.test(q)?String(now.getFullYear()):null));

  if(/base\s*burn|生活成本|年化/.test(q.toLowerCase())){
    const annual=baseBurn(entries,now);
    return{title:"Base Burn",text:`目前估計 ${money(annual/12)} / 月，${money(annual)} / 年。這會排除資本支出、房貸本金、資金移轉與 One-off。`};
  }
  if(/比較|對比|vs/i.test(q)){
    const recent=rowsForMonths(entries,now,n),prevEnd=addMonths(now,-n),prev=rowsForMonths(entries,prevEnd,n);
    const a=cat?sumRows(recent.filter(e=>e.category===cat)):sumRows(recent);
    const b=cat?sumRows(prev.filter(e=>e.category===cat)):sumRows(prev);
    const pct=b>0?(a/b-1)*100:null;
    return{title:`最近 ${n} 個月${cat?`「${cat}」`:"支出"}比較`,text:`最近 ${n} 個月 ${money(a)}；前 ${n} 個月 ${money(b)}。${pct===null?"前期沒有可比較資料。":`變動 ${pct>=0?"+":""}${pct.toFixed(1)}%。`}`,chart:chatMiniBars([{label:`前${n}月`,value:b},{label:`近${n}月`,value:a}])};
  }
  if(targetYear){
    const rows=entries.filter(e=>e.date.startsWith(targetYear+"-")).filter(e=>!cat||e.category===cat);
    const total=sumRows(rows);
    const monthly=Array.from({length:12},(_,i)=>{const key=`${targetYear}-${String(i+1).padStart(2,"0")}`;return{label:`${i+1}月`,value:sumRows(rows.filter(e=>e.date.startsWith(key)))}}).filter(x=>x.value>0);
    return{title:`${targetYear} ${cat?`${cat}類`:"總"}支出`,text:`合計 ${money(total)}，共 ${expenseRows(rows).length.toLocaleString()} 筆。${monthly.length?`有紀錄月份平均 ${money(total/monthly.length)}。`:""}`,chart:monthly.length?chatMiniBars(monthly):""};
  }
  if(/最多|最高|top/i.test(q)){
    const rows=rowsForMonths(entries,now,n),top=byField(rows,"category").slice(0,5),total=sumRows(rows);
    return{title:`最近 ${n} 個月支出 Top 5`,text:top.length?`第一名是「${top[0][0]}」${money(top[0][1])}，占 ${total?Math.round(top[0][1]/total*100):0}%。`:"這段期間沒有支出資料。",chart:top.length?`<div class="chat-rank">${top.map(([k,v])=>`<div><b>${esc(k)}</b><span>${money(v)}</span></div>`).join("")}</div>`:""};
  }
  if(cat || /月|費用|花多少|支出|show|看/i.test(q)){
    const series=monthlyCategorySeries(entries,now,n,cat),total=series.reduce((s,x)=>s+x.value,0),peak=series.slice().sort((a,b)=>b.value-a.value)[0];
    return{title:`最近 ${n} 個月${cat?`「${cat}」`:""}支出`,text:`合計 ${money(total)}，月平均 ${money(total/n)}。${peak?`最高月份 ${peak.label} ${money(peak.value)}。`:""}`,chart:chatMiniBars(series)};
  }
  const judges=aiJudgement(entries,now);
  return{title:"家庭現金流判讀",text:judges.map(x=>`${x.title}：${x.text}`).join(" ")};
}
function addChatMessage(role,payload){
  state.aiMessages.push({role,...payload,at:Date.now()});
  if(state.aiMessages.length>20)state.aiMessages=state.aiMessages.slice(-20);
}
function askFinanceAI(text){
  const q=String(text||"").trim();
  if(!q)return;
  try{
    addChatMessage("user",{text:q});
    addChatMessage("assistant",chatAnswer(q,effectiveEntries()));
  }catch(err){
    console.error("Home Flow AI error",err);
    addChatMessage("assistant",{title:"AI 查詢發生錯誤",text:"這次查詢沒有完成，請再試一次。"});
  }
  render();
  requestAnimationFrame(()=>{
    const thread=document.querySelector(".chat-thread");
    if(thread)thread.scrollTo({top:thread.scrollHeight,behavior:"smooth"});
    document.querySelector("#aiChatInput")?.focus();
  });
}

function nav(){ $$(".nav button").forEach(b=>b.classList.toggle("active",b.dataset.tab===state.tab)) }
function setTab(tab){state.tab=tab;state.listLimit=80;render();window.scrollTo({top:0,behavior:"smooth"})}
function periodNav(){return `<div class="period-nav"><button data-period="-1">←</button><div class="period-title">${state.viewDate.getFullYear()} 年 ${state.viewDate.getMonth()+1} 月</div><button data-period="1">→</button></div>`}
function entriesHtml(rows,limit=5){if(!rows.length)return'<div class="empty">目前沒有紀錄</div>';return rows.slice(0,limit).map(e=>`<div class="entry"><div class="entry-main"><div class="entry-title">${esc(e.legacyCategory||e.category)} <span class="tag">${esc(e.category)}</span><span class="tag nature">${esc(e.nature)}</span>${e.project&&e.project!=="日常生活"?`<span class="tag project">${esc(e.project)}</span>`:""}</div><div class="entry-meta">${e.date} · ${esc(e.account)}${e.note?" · "+esc(e.note):""}${e.oneOff?" · One-off":""}</div></div><div class="entry-side"><div class="entry-amount">${e.type==="income"?"+":"−"}${money(e.amount)}</div><div class="entry-actions"><button data-edit="${esc(e.id)}">編輯</button><button data-delete="${esc(e.id)}">刪除</button></div></div></div>`).join("")}
function barsHtml(items,total,max=7){if(!items.length)return'<div class="empty">沒有資料</div>';const peak=Math.max(...items.map(x=>x[1]),1);return`<div class="bar-list">${items.slice(0,max).map(([name,v])=>`<div class="bar-row"><b>${esc(name)}</b><div class="bar-track"><i style="width:${Math.max(3,v/peak*100)}%"></i></div><span>${money(v)}</span></div>`).join("")}</div>`}

function renderHome(entries){
  const m=monthRows(entries),mSpend=cashOut(m),bb=baseBurn(entries),avg=avgPriorMonths(entries,state.viewDate,6);
  const vs=avg>0?(mSpend/avg-1)*100:null,status=flowStatus(entries),fm=flowMetrics3(entries,state.viewDate),doctor=aiJudgement(entries,state.viewDate)[0];
  $("#content").innerHTML=`${periodNav()}
    <section class="card hero hf3-hero">
      <div class="hero-head"><div><small>HOME FLOW 3.0 · FAMILY CASHFLOW OS</small><h2>家庭財務，一眼看懂</h2></div><span class="hf3-score">${fm.score}<small>${fm.label}</small></span></div>
      <div class="stats">
        <div class="stat"><span>本月支出</span><strong>${shortMoney(mSpend)}</strong><small>${vs===null?"Cash Outflow":`vs 6M ${vs>=0?"+":""}${vs.toFixed(1)}%`}</small></div>
        <div class="stat"><span>Base Burn</span><strong>${shortMoney(fm.baseMonthly)}</strong><small>/ 月</small></div>
        <div class="stat"><span>Fixed Burn</span><strong>${shortMoney(fm.fixedMonthly)}</strong><small>家庭必要成本</small></div>
        <div class="stat"><span>Flexible</span><strong>${shortMoney(fm.flexMonthly)}</strong><small>可調整生活費</small></div>
      </div>
    </section>
    <section class="card hf3-doctor ${status.tone}">
      <div class="flow-status-head"><span class="status-dot"></span><b>AI DOCTOR · ${status.code}</b><small>3.0</small></div>
      <h3>${esc(doctor?.title||"家庭現金流穩定")}</h3><p>${esc(doctor?.text||status.text)}</p>
      <div class="flow-actions"><button class="link-btn" data-go-chat>追問 Home Flow AI →</button><button class="link-btn" data-go-analysis>完整診斷</button></div>
    </section>
    <section class="card">
      <div class="section-head"><h2>本月結構</h2><span>食・衣・住・行・育・樂</span></div>
      ${categoryRankHtml(m)}
    </section>
    <section class="card"><div class="section-head"><h2>最近紀錄</h2><button class="link-btn" data-go-list>全部明細</button></div>${entriesHtml(entries,6)}</section>`;
}

function formOptions(values,selected){return values.map(x=>`<option value="${esc(x)}" ${x===selected?"selected":""}>${esc(x)}</option>`).join("")}
function renderAdd(entries){const e=editId?entries.find(x=>x.id===editId):null;const accounts=data.settings.accounts.length?data.settings.accounts:DEFAULT_ACCOUNTS;const projects=[...new Set([...data.settings.projects,...entries.map(x=>x.project).filter(Boolean)])];const removedNatures=new Set(["房貸本金","利息","資本支出","資金移轉","固定義務"]);const natures=[...new Set([...(data.settings.natures||NATURES),...entries.map(x=>x.nature).filter(x=>x&&!removedNatures.has(x))])];const d=e||{amount:"",category:"食",account:accounts[0],nature:"生活消費",project:"日常生活",date:localDate(),note:"",oneOff:false,legacyCategory:""};$("#content").innerHTML=`<section class="card"><div class="section-head"><h2>${e?"編輯紀錄":"記一筆"}</h2><span>快速、夠用就好</span></div><div class="amount-row"><span>$</span><input id="amount" class="amount-input" inputmode="decimal" placeholder="0" value="${e?e.amount:""}"></div><div class="chips">${EXPENSE_CATS.slice(0,6).map(c=>`<button class="chip ${d.category===c?"active":""}" data-cat="${c}">${c}</button>`).join("")}</div><div class="form-grid"><label class="field"><span>分類</span><select id="category">${formOptions(EXPENSE_CATS,d.category)}</select></label><label class="field"><div class="field-head"><span>付款帳戶</span><button class="mini-link" data-edit-accounts>編輯</button></div><select id="account">${formOptions(accounts,d.account)}</select></label><label class="field"><div class="field-head"><span>Nature｜支出性質</span><button class="mini-link" data-edit-natures>編輯</button></div><select id="nature">${formOptions(natures,d.nature)}</select></label><label class="field"><div class="field-head"><span>Project</span><button class="mini-link" data-edit-projects>編輯</button></div><select id="project">${formOptions(projects,d.project)}</select></label><label class="field"><span>日期</span><input id="date" type="date" value="${d.date}"></label><label class="field"><span>項目 / 舊分類</span><input id="legacyCategory" maxlength="80" value="${esc(d.legacyCategory||"")}" placeholder="例：全聯、加油、房貸"></label><label class="field" style="grid-column:1/-1"><span>備註</span><input id="note" maxlength="240" value="${esc(d.note||"")}" placeholder="店家、用途、補充"></label><label class="toggle-row" style="grid-column:1/-1"><span><b>One-off</b><br><small>裝潢、交屋、大型醫療等一次性支出</small></span><input id="oneOff" type="checkbox" ${d.oneOff?"checked":""}></label></div><div class="form-actions"><button id="saveEntry" class="primary">${e?"儲存修改":"＋ 記一筆"}</button>${e?'<button class="outline" data-cancel-edit>取消</button>':""}</div></section><section class="card"><div class="section-head"><h3>Nature 怎麼用？</h3><span>核心</span></div><p class="tiny">生活消費 / 房屋相關 / 家庭孝親 / 育兒教育 / 保險相關 / 手機等服務 / 房貸本金 / 利息 / 資本支出 / 資金移轉。Base Burn 會排除資本支出、房貸本金、資金移轉與 One-off。</p></section>`}

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


function renderChat(entries){
  if(!state.aiMessages.length){
    state.aiMessages=[{role:"assistant",title:"Home Flow AI",text:"直接問你的帳本。我會在裝置端分析 2019–2026 資料，不把明細傳出去。",at:Date.now()}];
  }
  const examples=[...smartPrompts3(entries,state.viewDate),"3 個月內的食費用","最近 6 個月花最多什麼？","今年住花多少？","比較最近 3 個月跟前 3 個月","最近 3 個月交通花多少？","最近 6 個月娛樂花多少？","今年育兒教育花多少？","今年保險相關花多少？","今年手機等服務花多少？","最近哪個月花最多？"];
  $("#content").innerHTML=`<section class="ai-chat-head"><div><span class="ai-orb">✦</span><div><h2>Home Flow AI · 3.0</h2><small>問你的 ${effectiveEntries().length.toLocaleString()} 筆家庭金流</small></div></div><span class="local-badge">LOCAL</span></section>
    <div class="chat-examples">${examples.map(x=>`<button data-ai-example="${esc(x)}">${esc(x)}</button>`).join("")}</div>
    <section class="chat-thread">${state.aiMessages.map(m=>m.role==="user"?`<div class="chat-msg user">${esc(m.text)}</div>`:`<div class="chat-msg assistant"><b>${esc(m.title||"Home Flow AI")}</b><p>${esc(m.text||"")}</p>${m.chart||""}</div>`).join("")}</section>
    <form id="aiChatForm" class="chat-input-wrap"><input id="aiChatInput" autocomplete="off" enterkeyhint="send" placeholder="問：3 個月內的食費用？"><button id="aiSendBtn" type="button" aria-label="送出問題">↑</button></form>
    <p class="chat-privacy">目前為本機資料分析器：免 API、免登入、帳務明細不離開裝置。</p>`;
}

function renderProjects(entries){const groups={};for(const e of expenseRows(entries)){if(e.project==="日常生活")continue;(groups[e.project]??={sum:0,count:0}).sum+=e.amount;groups[e.project].count++}const cards=Object.entries(groups).sort((a,b)=>b[1].sum-a[1].sum).map(([name,g])=>`<div class="project-card"><button class="project-open" data-project-open="${esc(name)}"><div class="project-head"><div><b>${esc(name)}</b><span>主帳 ${g.count} 筆 · 點一下看明細</span></div><strong>${money(g.sum)}</strong></div></button></div>`).join("");const refs=(historyPayload.projectDetails||[]).map(p=>`<details class="project-card ref"><summary><div class="project-head"><div><b>${esc(p.name)}</b><span>${esc(p.kind)} · 專案參考明細，不重複加入主帳</span></div><strong>${money(p.referenceTotal)}</strong></div></summary>${p.items.map(i=>`<div class="ref-row"><span>${esc(i.name)}${i.memo?`<div class="ref-note">${esc(i.memo)}</div>`:""}</span><b>${money(i.amount)}</b></div>`).join("")}</details>`).join("");$("#content").innerHTML=`<section class="card"><div class="section-head"><h2>Project 專案帳</h2><span>同一筆只算一次</span></div><p class="tiny">主帳是唯一交易來源；東京行、裝潢原始獨立表只作為專案參考明細，避免重複計算。</p></section>${cards||'<div class="empty">目前沒有專案交易</div>'}<section class="card"><div class="section-head"><h2>原始專案表</h2><span>Reference</span></div>${refs||'<div class="empty">歷史專案資料尚未解鎖</div>'}</section>`}

function filteredList(entries){let r=entries;const q=state.search.trim().toLowerCase();if(q)r=r.filter(e=>[e.legacyCategory,e.note,e.account,e.project,e.category,e.nature,e.date].join(" ").toLowerCase().includes(q));const f=state.filters;if(f.year!=="全部")r=r.filter(e=>e.date.startsWith(f.year+"-"));if(f.category!=="全部")r=r.filter(e=>e.category===f.category);if(f.nature!=="全部")r=r.filter(e=>e.nature===f.nature);if(f.project!=="全部")r=r.filter(e=>e.project===f.project);return r}
function renderList(entries){const years=["全部",...new Set(entries.map(e=>e.date.slice(0,4)))].sort((a,b)=>a==="全部"?-1:b.localeCompare(a)),projects=["全部",...new Set(entries.map(e=>e.project).filter(Boolean))],rows=filteredList(entries);$("#content").innerHTML=`<section class="search"><span>⌕</span><input id="searchBox" placeholder="搜尋 Costco、日本、房貸、店家…" value="${esc(state.search)}"></section><div class="filter-grid"><div class="filter"><select id="yearFilter">${formOptions(years,state.filters.year)}</select></div><div class="filter"><select id="categoryFilter">${formOptions(["全部",...EXPENSE_CATS],state.filters.category)}</select></div><div class="filter"><select id="natureFilter">${formOptions(["全部",...new Set([...(data.settings.natures||NATURES),...entries.map(e=>e.nature).filter(x=>x&&!["房貸本金","利息","資本支出","資金移轉","固定義務"].includes(x))])],state.filters.nature)}</select></div><div class="filter"><select id="projectFilter">${formOptions(projects,state.filters.project)}</select></div></div><div class="result-note">找到 ${rows.length.toLocaleString()} 筆 · 合計 ${money(cashOut(rows))}</div><section class="card">${entriesHtml(rows,state.listLimit)}${rows.length>state.listLimit?'<button class="load-more" data-load-more>再顯示 80 筆</button>':""}</section><section class="card"><div class="section-head"><h2>資料工具</h2><span>你的資料可帶走</span></div><div class="tools"><button data-export-csv>匯出全部 CSV</button><button data-export-json>備份修改資料</button><label>匯入備份<input id="importBackup" type="file" accept="application/json" hidden></label></div><p class="tiny">歷史原始資料已加密內建；JSON 備份主要保存你之後新增、修改、刪除的差異與自訂帳戶/專案。</p></section>`}

function render(){nav();const entries=effectiveEntries();if(state.tab==="home")renderHome(entries);else if(state.tab==="add")renderAdd(entries);else if(state.tab==="analysis")renderAnalysis(entries);else if(state.tab==="chat")renderChat(entries);else if(state.tab==="projects")renderProjects(entries);else renderList(entries);bindViewEvents(entries)}

function editAccounts(){const cur=data.settings.accounts.join(", "),v=prompt("編輯付款帳戶（用逗號分隔）",cur);if(v===null)return;const arr=[...new Set(v.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean))].slice(0,30);if(!arr.length)return;syncMutation(n=>{n.settings={...n.settings,accounts:arr};n.settingsUpdatedAt=nowIso()})}
function editNatures(){const cur=(data.settings.natures||NATURES).join(", "),v=prompt("編輯 Nature｜支出性質（用逗號分隔）",cur);if(v===null)return;const arr=[...new Set(v.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean))].slice(0,30);if(!arr.length)return;syncMutation(n=>{n.settings={...n.settings,natures:arr};n.settingsUpdatedAt=nowIso()})}
function editProjects(){const cur=data.settings.projects.join(", "),v=prompt("編輯 Project（用逗號分隔）",cur);if(v===null)return;const arr=[...new Set(v.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean))].slice(0,40);if(!arr.length)return;syncMutation(n=>{n.settings={...n.settings,projects:arr};n.settingsUpdatedAt=nowIso()})}
async function saveEntry(){const amount=Number($("#amount")?.value);if(!(amount>0)){$("#amount")?.focus();return}const old=editId?effectiveEntries().find(e=>e.id===editId):null;const draft={id:editId||uid(),type:old?.type||"expense",amount,date:$("#date").value||localDate(),category:$("#category").value,legacyCategory:$("#legacyCategory").value.trim(),account:$("#account").value,nature:$("#nature").value,obligationCategory:"",project:$("#project").value,note:$("#note").value.trim(),oneOff:$("#oneOff").checked,imported:old?.imported||false,source:old?.source||"",sourceRow:old?.sourceRow||0,createdAt:old?.createdAt||nowIso(),updatedAt:nowIso()};const ok=await syncMutation(n=>{const i=n.entries.findIndex(e=>e.id===draft.id);if(i>=0)n.entries[i]=normalizeEntry(draft);else n.entries.push(normalizeEntry(draft))});if(ok){editId=null;state.tab="home";render()}}
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
  $('[data-edit-natures]')?.addEventListener('click',e=>{e.preventDefault();editNatures()});
  $("#saveEntry")?.addEventListener("click",saveEntry);
  $('[data-cancel-edit]')?.addEventListener('click',()=>{editId=null;setTab('home')});
  $('[data-go-analysis]')?.addEventListener('click',()=>setTab('analysis'));
  $('[data-go-chat]')?.addEventListener('click',()=>setTab('chat'));
  $('[data-go-list]')?.addEventListener('click',()=>setTab('list'));
  $$('[data-project-open]').forEach(b=>b.onclick=()=>{state.filters.project=b.dataset.projectOpen;state.tab='list';render()});
  const sb=$("#searchBox");
  if(sb)sb.oninput=()=>{state.search=sb.value;state.listLimit=80;renderList(effectiveEntries());bindViewEvents(effectiveEntries());$("#searchBox")?.focus();try{$("#searchBox").setSelectionRange(state.search.length,state.search.length)}catch{}};
  for(const[id,key]of[["yearFilter","year"],["categoryFilter","category"],["natureFilter","nature"],["projectFilter","project"]])$("#"+id)?.addEventListener("change",e=>{state.filters[key]=e.target.value;state.listLimit=80;render()});
  $('[data-load-more]')?.addEventListener('click',()=>{state.listLimit+=80;render()});
  $('[data-export-csv]')?.addEventListener('click',exportCsv);
  $('[data-export-json]')?.addEventListener('click',exportBackup);
  $("#importBackup")?.addEventListener("change",e=>importBackup(e.target.files?.[0]));
  $$('[data-ai-example]').forEach(b=>b.addEventListener("click",()=>askFinanceAI(b.dataset.aiExample)));
  const sendAi=()=>{const input=$("#aiChatInput");const q=input?.value||"";if(!q.trim())return;askFinanceAI(q)};
  $("#aiSendBtn")?.addEventListener("click",sendAi);
  $("#aiChatInput")?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAi()}});
  $("#aiChatForm")?.addEventListener("submit",e=>{e.preventDefault();sendAi()});
}


async function init(){if(!window.crypto?.subtle){setStatus("此瀏覽器不支援加密功能","error");return}setStatus("正在解鎖 2019–2026 歷史帳本…");try{await loadHistory()}catch(e){console.error(e);setStatus("歷史資料尚未完整發布；新帳仍可使用","warn")}try{await bootRemote();setStatus(historyEntries.length?`已載入 ${historyEntries.length.toLocaleString()} 筆歷史 · 加密共用`:"Home Flow 已同步 · 歷史資料未解鎖","ok")}catch(e){console.error(e);remoteReady=false;data=normalizeData(await loadLocal());setStatus(historyEntries.length?`已載入 ${historyEntries.length.toLocaleString()} 筆歷史 · 本機模式`:"本機模式 · 歷史資料未解鎖","warn")}render();setInterval(()=>{if(document.visibilityState==="visible")ensureRemote(true)},15000)}

$$('.nav button').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));$("#shareBtn").onclick=shareBook;document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")ensureRemote(false)});init();
