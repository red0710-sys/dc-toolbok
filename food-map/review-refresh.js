(()=>{
"use strict";
const API="https://taiwan-food-review-proxy.vercel.app/api/reviews";
let running=false;

function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function dateLabel(v,withTime=false){
  if(!v)return"尚未更新";
  const d=new Date(v);if(Number.isNaN(d.getTime()))return"未知";
  return new Intl.DateTimeFormat("zh-TW",withTime
    ?{timeZone:"Asia/Taipei",year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}
    :{timeZone:"Asia/Taipei",year:"numeric",month:"numeric",day:"numeric"}
  ).format(d);
}
function bridge(){return window.TaiwanFoodAppBridge||null}

function ensureStyle(){
  if(document.getElementById("review-refresh-style"))return;
  const s=document.createElement("style");
  s.id="review-refresh-style";
  s.textContent=`
  .rr-backdrop{position:fixed;inset:0;z-index:9000;background:rgba(13,37,43,.48);backdrop-filter:blur(6px);display:grid;place-items:end center}
  .rr-sheet{width:min(620px,100%);max-height:88dvh;overflow:auto;background:#fffdf8;border:1px solid #d8e2df;border-bottom:0;border-radius:24px 24px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -12px 50px rgba(22,50,59,.18);color:#16323b}
  .rr-sheet h3{margin:0 0 6px;font-size:1.15rem}.rr-desc{margin:0 0 14px;color:#68777b;font-size:.82rem;line-height:1.5}
  .rr-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}.rr-box{padding:11px 12px;border:1px solid #d8e2df;border-radius:12px;background:#fbfaf5}.rr-box span{display:block;color:#68777b;font-size:.7rem}.rr-box strong{display:block;margin-top:3px;font-size:.9rem}
  .rr-progress{display:none;margin-top:12px;padding:12px;border:1px solid #d8e2df;border-radius:13px;background:#fbfaf5}.rr-progress.show{display:block}.rr-head{display:flex;justify-content:space-between;gap:12px;font-size:.8rem;margin-bottom:8px}.rr-track{height:8px;border-radius:999px;background:#dceff0;overflow:hidden}.rr-bar{height:100%;width:0;background:#087f8c;border-radius:999px;transition:width .18s ease}.rr-detail{margin-top:7px;color:#68777b;font-size:.72rem}
  .rr-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.rr-btn{min-height:42px;padding:0 14px;border-radius:11px;border:1px solid #d8e2df;background:#fffdf8;color:#16323b;font-weight:750}.rr-btn.primary{background:#087f8c;color:#fff;border-color:#087f8c}.rr-btn:disabled{opacity:.5}
  `;
  document.head.appendChild(s);
}

function open(){
  const b=bridge();
  if(!b){alert("更新模組尚未就緒，請重新整理後再試。");return}
  ensureStyle();
  document.getElementById("reviewRefreshOverlay")?.remove();
  const targets=b.getReviewTargets();
  const cache=b.getReviewCache()||{updatedAt:null,places:{}};
  const cached=Object.keys(cache.places||{}).length;
  const wrap=document.createElement("div");
  wrap.id="reviewRefreshOverlay";wrap.className="rr-backdrop";
  wrap.innerHTML=`
    <div class="rr-sheet">
      <h3>Google 評論手動更新</h3>
      <p class="rr-desc">直接在 App 內重新抓取評論摘要。更新全部時請保持此頁開啟。</p>
      <div class="rr-meta">
        <div class="rr-box"><span>上次更新</span><strong>${esc(dateLabel(cache.updatedAt,true))}</strong></div>
        <div class="rr-box"><span>評論快取</span><strong>${cached} / ${targets.length} 間</strong></div>
      </div>
      <div class="rr-progress" id="rrProgress">
        <div class="rr-head"><span id="rrText">準備更新…</span><strong id="rrPct">0%</strong></div>
        <div class="rr-track"><div class="rr-bar" id="rrBar"></div></div>
        <div class="rr-detail" id="rrDetail">0 / ${targets.length}</div>
      </div>
      <div class="rr-actions">
        <button class="rr-btn" id="rrClose">關閉</button>
        <button class="rr-btn primary" id="rrStart">更新全部 ${targets.length} 間</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close=wrap.querySelector("#rrClose"),start=wrap.querySelector("#rrStart");
  close.onclick=()=>{if(!running)wrap.remove()};
  wrap.addEventListener("click",e=>{if(e.target===wrap&&!running)wrap.remove()});
  start.onclick=()=>run(targets,cache,wrap);
}

async function run(targets,existing,wrap){
  if(running)return;
  running=true;
  const start=wrap.querySelector("#rrStart"),close=wrap.querySelector("#rrClose"),prog=wrap.querySelector("#rrProgress"),bar=wrap.querySelector("#rrBar"),pct=wrap.querySelector("#rrPct"),detail=wrap.querySelector("#rrDetail"),txt=wrap.querySelector("#rrText");
  start.disabled=true;close.disabled=true;start.textContent="更新中…";prog.classList.add("show");
  const cache={updatedAt:existing.updatedAt||null,places:{...(existing.places||{})}};
  const batches=[];for(let i=0;i<targets.length;i+=5)batches.push(targets.slice(i,i+5));
  let cursor=0,done=0,success=0,failed=0;
  const paint=()=>{const p=targets.length?Math.round(done/targets.length*100):100;bar.style.width=p+"%";pct.textContent=p+"%";detail.textContent=`${done} / ${targets.length} · 成功 ${success} · 失敗 ${failed}`;txt.textContent=done<targets.length?"正在更新 Google 評論…":"更新完成"};

  async function worker(){
    while(true){
      const i=cursor++;if(i>=batches.length)return;
      const batch=batches[i];
      try{
        const r=await fetch(API,{method:"POST",mode:"cors",cache:"no-store",headers:{"content-type":"application/json"},body:JSON.stringify({places:batch})});
        if(!r.ok)throw new Error("HTTP "+r.status);
        const j=await r.json();
        for(const item of (j.results||[])){if(item?.id){cache.places[item.id]=item;success++}}
        failed+=(j.errors||[]).length+Math.max(0,batch.length-(j.results||[]).length-(j.errors||[]).length);
      }catch(e){console.warn("review refresh batch failed",e);failed+=batch.length}
      done+=batch.length;paint();
    }
  }

  try{
    paint();
    await Promise.all([worker(),worker(),worker()]);
    if(success>0){
      cache.updatedAt=new Date().toISOString();
      bridge()?.commitReviewCache(cache);
      txt.textContent="更新完成";
      detail.textContent=`${targets.length} 間 · 成功 ${success} · 失敗 ${failed} · ${dateLabel(cache.updatedAt,true)}`;
      start.textContent="重新更新全部";
    }else{
      txt.textContent="更新失敗";
      detail.textContent="沒有成功取得新的評論資料，原快取保持不變。";
      start.textContent="再試一次";
    }
  }finally{
    running=false;start.disabled=false;close.disabled=false;
  }
}

window.TaiwanFoodReviewRefresh={open};
})();