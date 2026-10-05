(()=>{
"use strict";
const CREDS_KEY="homeflow-cloud-creds-v1";
const DEVICE_KEY="homeflow-device-id-v1";
const PUBLIC_FAMILY_CREDS={familyId:"hf_f7F5VxDnJWGNToTB",accessToken:"xV2WJcHLeH62nRFddZgEVxoBT07y7JDAa2u8C1R7idY",keyText:"2rCUqK-Q-L7rrrl8iOg2urOSzzrE0Pl_nANpGrO6yM0"};
const te=new TextEncoder(),td=new TextDecoder();

function b64url(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
function fromB64url(text){const p=text.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-text.length%4)%4);const s=atob(p);return Uint8Array.from(s,c=>c.charCodeAt(0))}
function randomToken(n=32){return b64url(crypto.getRandomValues(new Uint8Array(n)))}
function deviceId(){let id=localStorage.getItem(DEVICE_KEY);if(!id){id="dev_"+randomToken(12);localStorage.setItem(DEVICE_KEY,id)}return id}
function validCreds(c){return !!c&&/^hf_[A-Za-z0-9_-]{12,64}$/.test(c.familyId||"")&&(c.accessToken||"").length>=30&&(c.keyText||"").length>=40}
function fragmentCreds(){const p=new URLSearchParams(location.hash.slice(1));const c={familyId:p.get("hf_f")||"",accessToken:p.get("hf_t")||"",keyText:p.get("hf_k")||""};return validCreds(c)?c:null}
function storedCreds(){try{const c=JSON.parse(localStorage.getItem(CREDS_KEY)||"null");return validCreds(c)?c:null}catch{return null}}
function persistCreds(c){
  localStorage.setItem(CREDS_KEY,JSON.stringify(c));
  const u=new URL(location.href),p=new URLSearchParams(u.hash.slice(1));
  p.delete("hf_f");p.delete("hf_t");p.delete("hf_k");
  u.hash=p.toString();history.replaceState(null,"",u);
}
function inviteUrlFor(c){
  const u=new URL(location.href),p=new URLSearchParams();
  p.set("hf_f",c.familyId);p.set("hf_t",c.accessToken);p.set("hf_k",c.keyText);
  u.hash=p.toString();return u.toString();
}
async function importKey(text){const raw=fromB64url(text);if(raw.length!==32)throw new Error("bad encryption key");return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"])}
async function gzip(bytes){if(typeof CompressionStream==="undefined")return{codec:"raw",bytes};const stream=new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));return{codec:"gzip",bytes:new Uint8Array(await new Response(stream).arrayBuffer())}}
async function gunzip(bytes,codec){if(codec!=="gzip")return bytes;if(typeof DecompressionStream==="undefined")throw new Error("gzip unsupported");const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));return new Uint8Array(await new Response(stream).arrayBuffer())}
async function encodeSnapshot(value,c){
  const packed=await gzip(te.encode(JSON.stringify(value))),iv=crypto.getRandomValues(new Uint8Array(12)),key=await importKey(c.keyText);
  const aad=te.encode("homeflow-v3|"+c.familyId);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},key,packed.bytes));
  const envelope=JSON.stringify({format:"homeflow-snapshot-v1",codec:packed.codec,iv:b64url(iv),ciphertext:b64url(encrypted)});
  const size=700000,out=[];for(let i=0;i<envelope.length;i+=size)out.push(envelope.slice(i,i+size));return out;
}
async function decodeSnapshot(chunks,c){
  if(!chunks?.length)return null;
  const env=JSON.parse(chunks.join(""));if(env.format!=="homeflow-snapshot-v1")throw new Error("unknown snapshot");
  const key=await importKey(c.keyText),aad=te.encode("homeflow-v3|"+c.familyId);
  const plain=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64url(env.iv),additionalData:aad},key,fromB64url(env.ciphertext)));
  return JSON.parse(td.decode(await gunzip(plain,env.codec)));
}
async function request(path,c,options={}){
  const headers=new Headers(options.headers||{});headers.set("accept","application/json");
  if(c){headers.set("authorization","Bearer "+c.accessToken);headers.set("x-homeflow-family",c.familyId)}
  if(options.body&&!headers.has("content-type"))headers.set("content-type","application/json");
  return fetch(path,{...options,headers,cache:"no-store"});
}
async function createFamily(){
  const r=await request("/api/family",null,{method:"POST"});if(!r.ok)throw new Error("family create failed");
  const j=await r.json(),keyText=randomToken(32),c={familyId:j.familyId,accessToken:j.accessToken,keyText};persistCreds(c);return c;
}
class HomeFlowCloudClient{
  constructor(c){this.creds=c}
  get familyId(){return this.creds.familyId}
  inviteUrl(){return inviteUrlFor(this.creds)}
  async health(){const r=await request("/api/health",null);return r.ok}
  async read(){
    const r=await request("/api/snapshot",this.creds);if(!r.ok)throw new Error("snapshot read failed");
    const j=await r.json();return{version:j.version||null,data:j.version?await decodeSnapshot(j.chunks,this.creds):null,createdAt:j.createdAt||null};
  }
  async write(value,baseVersion){
    const chunks=await encodeSnapshot(value,this.creds),versionId="v_"+randomToken(18);
    const r=await request("/api/snapshot",this.creds,{method:"PUT",body:JSON.stringify({baseVersion:baseVersion||null,versionId,deviceId:deviceId(),chunks})});
    const j=await r.json().catch(()=>({}));
    if(r.status===409)return{conflict:true,currentVersion:j.currentVersion||null};
    if(!r.ok)throw new Error(j.error||"snapshot write failed");
    return{conflict:false,version:j.version};
  }
  async backups(){const r=await request("/api/backups",this.creds);if(!r.ok)throw new Error("backup list failed");return (await r.json()).backups||[]}
  async readBackup(version){const r=await request("/api/backup?version="+encodeURIComponent(version),this.creds);if(!r.ok)throw new Error("backup read failed");const j=await r.json();return{version:j.version,backupDay:j.backupDay,data:await decodeSnapshot(j.chunks,this.creds)}}
  async restore(version){const r=await request("/api/restore",this.creds,{method:"POST",body:JSON.stringify({version})});if(!r.ok)throw new Error("restore failed");return r.json()}
  async mirror(payload){const r=await request("/api/google-mirror",this.creds,{method:"POST",body:JSON.stringify(payload)});const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error(j.error||"google mirror failed");return j}
}
async function connect(){
  // Home Flow is one fixed shared family. Never let stale per-device credentials split the ledger.
  const incoming=fragmentCreds();
  const c=(incoming&&incoming.familyId===PUBLIC_FAMILY_CREDS.familyId)?incoming:PUBLIC_FAMILY_CREDS;
  persistCreds(c);
  return new HomeFlowCloudClient(c);
}
window.HomeFlowCloud={
  connect,
  clear(){localStorage.removeItem(CREDS_KEY)},
  hasCredentials(){return true},
  familyId(){return PUBLIC_FAMILY_CREDS.familyId}
};
})();