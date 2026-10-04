(()=>{
"use strict";
const OLD_ORIGIN="https://red0710-sys.github.io";
const params=new URLSearchParams(location.hash.slice(1));
const wantsMigration=params.get("migrate")==="1";

window.HomeFlowMigrationReady=new Promise(resolve=>{
  if(!wantsMigration){resolve({migrated:false});return}
  let settled=false;
  const finish=(value)=>{if(settled)return;settled=true;clearInterval(ping);clearTimeout(timeout);resolve(value)};
  const sendReady=()=>{try{window.opener?.postMessage({type:"homeflow-migration-ready"},OLD_ORIGIN)}catch{}};
  const ping=setInterval(sendReady,500);
  const timeout=setTimeout(()=>finish({migrated:false,timeout:true}),15000);

  window.addEventListener("message",async event=>{
    if(event.origin!==OLD_ORIGIN)return;
    const msg=event.data;
    if(!msg||msg.type!=="homeflow-migration-payload")return;
    const p=msg.payload;
    if(!p||p.format!=="homeflow-migration-v1")return;
    try{
      if(typeof p.historyKey==="string"&&/^[A-Za-z0-9_-]{40,80}$/.test(p.historyKey)){
        localStorage.setItem("homeflow-history-key",p.historyKey);
      }
      if(p.data&&typeof p.data==="object"){
        localStorage.setItem("homeflow-local-overrides",JSON.stringify(p.data));
        await window.HomeFlowLocal?.save?.(p.data);
      }
      const u=new URL(location.href);const hp=new URLSearchParams(u.hash.slice(1));
      hp.delete("migrate");u.hash=hp.toString();history.replaceState(null,"",u);
      try{event.source?.postMessage({type:"homeflow-migration-complete"},OLD_ORIGIN)}catch{}
      finish({migrated:true});
    }catch(err){
      console.error("migration failed",err);
      try{event.source?.postMessage({type:"homeflow-migration-failed"},OLD_ORIGIN)}catch{}
      finish({migrated:false,error:true});
    }
  });
  sendReady();
});
})();