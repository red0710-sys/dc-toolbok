(()=>{
"use strict";
const DB_NAME="home-flow-local-v1",STORE="state",KEY="ledger";
function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE)};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function withStore(mode,fn){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode),s=tx.objectStore(STORE);let req;try{req=fn(s)}catch(e){db.close();reject(e);return}let result;req.onsuccess=()=>{result=req.result};req.onerror=()=>reject(req.error);tx.oncomplete=()=>{db.close();resolve(result)};tx.onabort=()=>{db.close();reject(tx.error||new Error("transaction aborted"))};tx.onerror=()=>{db.close();reject(tx.error)}})}
window.HomeFlowLocal={
  async load(){try{return await withStore("readonly",s=>s.get(KEY))||null}catch{return null}},
  async save(value){try{await withStore("readwrite",s=>s.put(structuredClone(value),KEY));return true}catch{return false}},
  async clear(){try{await withStore("readwrite",s=>s.delete(KEY));return true}catch{return false}}
};
})();