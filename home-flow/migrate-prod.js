(()=>{
"use strict";
const PROD_ORIGIN="https://home-flow.red0710.workers.dev";
const btn=document.getElementById("migrateProdBtn");
const note=document.getElementById("migrateProdNote");
if(!btn)return;

function historyKey(){
  const p=new URLSearchParams(location.hash.slice(1));
  return p.get("hk")||localStorage.getItem("homeflow-history-key")||"";
}
function localData(){
  try{return JSON.parse(localStorage.getItem("homeflow-local-overrides")||"null")}catch{return null}
}
const startMigration=()=>{
  const key=historyKey(),data=localData();
  if(!key){
    if(note)note.textContent="這台裝置尚未解鎖歷史資料；請先確認舊版已正常顯示歷史帳，再移轉。";
    return;
  }
  const child=window.open(PROD_ORIGIN+"/#migrate=1","homeflow-production");
  if(!child){
    if(note)note.textContent="瀏覽器阻擋了新分頁，請允許彈出視窗後再試一次。";
    return;
  }
  btn.disabled=true;btn.textContent="正在移轉…";
  if(note)note.textContent="正在把歷史解鎖金鑰與本機修改安全交給新版。";

  let done=false;
  const payload={format:"homeflow-migration-v1",historyKey:key,data,exportedAt:new Date().toISOString()};
  const send=()=>{try{child.postMessage({type:"homeflow-migration-payload",payload},PROD_ORIGIN)}catch{}};
  const interval=setInterval(send,700);
  const cleanup=()=>{clearInterval(interval);window.removeEventListener("message",onMessage)};
  const onMessage=(event)=>{
    if(event.origin!==PROD_ORIGIN)return;
    if(event.data?.type==="homeflow-migration-ready"){send();return}
    if(event.data?.type==="homeflow-migration-complete"){
      done=true;cleanup();btn.textContent="已移轉 · 開啟新版";btn.disabled=false;
      btn.removeEventListener("click",startMigration);
      btn.addEventListener("click",()=>window.open(PROD_ORIGIN,"_blank"));
      if(note)note.textContent="移轉完成。新版會自動載入歷史資料並同步到家庭雲端。";
    }
    if(event.data?.type==="homeflow-migration-failed"){
      cleanup();btn.disabled=false;btn.textContent="重新移轉";
      if(note)note.textContent="移轉沒有完成，舊版資料未受影響，可以重新再試。";
    }
  };
  window.addEventListener("message",onMessage);
  setTimeout(()=>{if(done)return;cleanup();btn.disabled=false;btn.textContent="重新移轉";if(note)note.textContent="新版沒有回應；舊版資料未受影響，可以重新再試。"},20000);
};
btn.addEventListener("click",startMigration);
})();