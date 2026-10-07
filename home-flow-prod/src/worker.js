const JSON_HEADERS={"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":"https://red0710-sys.github.io","vary":"Origin"};\nconst CORS_HEADERS={"access-control-allow-origin":"https://red0710-sys.github.io","access-control-allow-methods":"GET,POST,PUT,OPTIONS","access-control-allow-headers":"authorization,x-homeflow-family,content-type","access-control-max-age":"86400","vary":"Origin"};

function json(data,status=200,extra={}){return new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...extra}})}
function b64url(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
function randomToken(bytes=24){return b64url(crypto.getRandomValues(new Uint8Array(bytes)))}
async function sha256(text){return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))))}
function bearer(req){const h=req.headers.get("authorization")||"";return h.startsWith("Bearer ")?h.slice(7).trim():""}
function familyHeader(req){return (req.headers.get("x-homeflow-family")||"").trim()}
const PUBLIC_LINK_FAMILY_ID="hf_f7F5VxDnJWGNToTB";
const PUBLIC_LINK_TOKEN_HASH="7oTpwZepGfKpWo_v9gmQbMnt09BUmNLBvDf45350xlk";
function validFamilyId(v){return /^hf_[A-Za-z0-9_-]{12,64}$/.test(v)}
function validVersion(v){return /^v_[A-Za-z0-9_-]{12,80}$/.test(v)}
function familyDay(){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const o=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${o.year}-${o.month}-${o.day}`;
}

async function auth(req,env){
  const familyId=familyHeader(req),token=bearer(req);
  if(!validFamilyId(familyId)||token.length<30)return null;
  let row=await env.DB.prepare("SELECT token_hash,current_version FROM families WHERE family_id=?").bind(familyId).first();
  const hash=await sha256(token);
  if(!row&&familyId===PUBLIC_LINK_FAMILY_ID&&hash===PUBLIC_LINK_TOKEN_HASH){
    await env.DB.prepare("INSERT OR IGNORE INTO families(family_id,token_hash,created_at,last_seen_at) VALUES(?,?,datetime('now'),datetime('now'))")
      .bind(PUBLIC_LINK_FAMILY_ID,PUBLIC_LINK_TOKEN_HASH).run();
    row=await env.DB.prepare("SELECT token_hash,current_version FROM families WHERE family_id=?").bind(familyId).first();
  }
  if(!row||hash!==row.token_hash)return null;
  return{familyId,currentVersion:row.current_version||null};
}

async function createFamily(env){
  const familyId="hf_"+randomToken(12),accessToken=randomToken(32),tokenHash=await sha256(accessToken);
  await env.DB.prepare("INSERT INTO families(family_id,token_hash,created_at,last_seen_at) VALUES(?,?,datetime('now'),datetime('now'))")
    .bind(familyId,tokenHash).run();
  return json({familyId,accessToken,version:null},201);
}

async function readSnapshot(req,env,user){
  const current=await env.DB.prepare("SELECT current_version FROM families WHERE family_id=?").bind(user.familyId).first();
  const version=current?.current_version||null;
  if(!version)return json({version:null,chunks:[],createdAt:null});
  const meta=await env.DB.prepare("SELECT version_id,created_at,device_id,chunk_count,byte_size FROM snapshots WHERE family_id=? AND version_id=?")
    .bind(user.familyId,version).first();
  if(!meta)return json({error:"snapshot metadata missing"},500);
  const rows=await env.DB.prepare("SELECT chunk_index,payload FROM snapshot_chunks WHERE family_id=? AND version_id=? ORDER BY chunk_index")
    .bind(user.familyId,version).all();
  const chunks=(rows.results||[]).map(r=>r.payload);
  if(chunks.length!==Number(meta.chunk_count))return json({error:"snapshot incomplete"},500);
  return json({version,createdAt:meta.created_at,deviceId:meta.device_id,chunks});
}

async function listBackups(env,user){
  const rows=await env.DB.prepare("SELECT version_id,backup_day,created_at,byte_size FROM snapshots WHERE family_id=? AND backup_day IS NOT NULL ORDER BY backup_day DESC LIMIT 60")
    .bind(user.familyId).all();
  return json({backups:rows.results||[]});
}

async function readBackup(url,env,user){
  const version=url.searchParams.get("version")||"";
  if(!validVersion(version))return json({error:"bad version"},400);
  const meta=await env.DB.prepare("SELECT version_id,backup_day,created_at,chunk_count FROM snapshots WHERE family_id=? AND version_id=? AND backup_day IS NOT NULL")
    .bind(user.familyId,version).first();
  if(!meta)return json({error:"backup not found"},404);
  const rows=await env.DB.prepare("SELECT chunk_index,payload FROM snapshot_chunks WHERE family_id=? AND version_id=? ORDER BY chunk_index")
    .bind(user.familyId,version).all();
  return json({version,backupDay:meta.backup_day,createdAt:meta.created_at,chunks:(rows.results||[]).map(r=>r.payload)});
}

async function writeSnapshot(req,env,user){
  let body;try{body=await req.json()}catch{return json({error:"invalid json"},400)}
  const baseVersion=body.baseVersion===null?null:String(body.baseVersion||"");
  const versionId=String(body.versionId||"");
  const deviceId=String(body.deviceId||"").slice(0,100);
  const chunks=Array.isArray(body.chunks)?body.chunks:[];
  if(!validVersion(versionId)||chunks.length<1||chunks.length>32)return json({error:"invalid snapshot"},400);
  if(chunks.some(x=>typeof x!=="string"||x.length>900000))return json({error:"invalid chunk"},413);
  const byteSize=chunks.reduce((n,x)=>n+x.length,0);
  if(byteSize>12000000)return json({error:"snapshot too large"},413);

  const family=await env.DB.prepare("SELECT current_version FROM families WHERE family_id=?").bind(user.familyId).first();
  const current=family?.current_version||null;
  if(current!==baseVersion)return json({error:"version conflict",currentVersion:current},409);

  const existing=await env.DB.prepare("SELECT version_id FROM snapshots WHERE family_id=? AND version_id=?").bind(user.familyId,versionId).first();
  if(existing)return json({version:versionId,idempotent:true});

  // D1 batch is transactional. Claim the version before inserting/replacing data.
  // Every later statement is gated by the successful compare-and-swap.
  const owns="EXISTS(SELECT 1 FROM families WHERE family_id=? AND current_version=?)";
  const statements=[env.DB.prepare("UPDATE families SET current_version=?,last_seen_at=datetime('now') WHERE family_id=? AND (current_version IS ? OR current_version=?)")
    .bind(versionId,user.familyId,baseVersion,baseVersion||""),
    env.DB.prepare("INSERT INTO snapshots(family_id,version_id,created_at,device_id,chunk_count,byte_size) SELECT ?,?,datetime('now'),?,?,? WHERE "+owns)
      .bind(user.familyId,versionId,deviceId,chunks.length,byteSize,user.familyId,versionId)];
  for(let i=0;i<chunks.length;i++)statements.push(env.DB.prepare("INSERT INTO snapshot_chunks(family_id,version_id,chunk_index,payload) SELECT ?,?,?,? WHERE "+owns)
    .bind(user.familyId,versionId,i,chunks[i],user.familyId,versionId));
  if(current){
    statements.push(env.DB.prepare("UPDATE snapshots SET backup_day=? WHERE family_id=? AND version_id=? AND backup_day IS NULL AND "+owns+" AND NOT EXISTS(SELECT 1 FROM snapshots WHERE family_id=? AND backup_day=?)")
      .bind(familyDay(),user.familyId,current,user.familyId,versionId,user.familyId,familyDay()));
    statements.push(env.DB.prepare("DELETE FROM snapshots WHERE family_id=? AND version_id=? AND backup_day IS NULL AND "+owns)
      .bind(user.familyId,current,user.familyId,versionId));
  }
  const [moved]=await env.DB.batch(statements);
  if(!moved.meta?.changes){
    return json({error:"version conflict",currentVersion:(await env.DB.prepare("SELECT current_version FROM families WHERE family_id=?").bind(user.familyId).first())?.current_version||null},409);
  }
  return json({version:versionId,backupCreated:!!current});
}

async function restoreBackup(req,env,user){
  let body;try{body=await req.json()}catch{return json({error:"invalid json"},400)}
  const source=String(body.version||"");
  if(!validVersion(source))return json({error:"bad version"},400);
  const meta=await env.DB.prepare("SELECT chunk_count FROM snapshots WHERE family_id=? AND version_id=? AND backup_day IS NOT NULL").bind(user.familyId,source).first();
  if(!meta)return json({error:"backup not found"},404);
  const rows=await env.DB.prepare("SELECT payload FROM snapshot_chunks WHERE family_id=? AND version_id=? ORDER BY chunk_index").bind(user.familyId,source).all();
  const newVersion="v_"+randomToken(18),current=(await env.DB.prepare("SELECT current_version FROM families WHERE family_id=?").bind(user.familyId).first())?.current_version||null;
  await env.DB.prepare("INSERT INTO snapshots(family_id,version_id,created_at,device_id,chunk_count,byte_size) SELECT family_id,?,datetime('now'),'restore',chunk_count,byte_size FROM snapshots WHERE family_id=? AND version_id=?")
    .bind(newVersion,user.familyId,source).run();
  for(let i=0;i<(rows.results||[]).length;i++)await env.DB.prepare("INSERT INTO snapshot_chunks(family_id,version_id,chunk_index,payload) VALUES(?,?,?,?)").bind(user.familyId,newVersion,i,rows.results[i].payload).run();
  if(current)await env.DB.prepare("UPDATE snapshots SET backup_day=COALESCE(backup_day,?) WHERE family_id=? AND version_id=?").bind(familyDay(),user.familyId,current).run();
  await env.DB.prepare("UPDATE families SET current_version=?,last_seen_at=datetime('now') WHERE family_id=?").bind(newVersion,user.familyId).run();
  return json({version:newVersion,restoredFrom:source});
}

async function googleMirror(req,user){
  const body=await req.json().catch(()=>null);
  if(!body||typeof body!=="object")return json({error:"invalid payload"},400);
  if(String(body.date||"")<"2026-10-05")return json({ok:true,skipped:"before start date"});
  if(!body.entry_id||!/^m-[A-Za-z0-9_-]+$/.test(String(body.entry_id)))return json({error:"invalid entry_id"},400);

  const payload={
    action:["CREATE","UPDATE","DELETE","UPSERT"].includes(String(body.action))?String(body.action):"UPSERT",
    status:String(body.status)==="DELETED"?"DELETED":"ACTIVE",
    date:String(body.date||"").slice(0,10),
    time:String(body.time||"").slice(0,16),
    category:String(body.category||"").slice(0,30),
    item:String(body.item||"").slice(0,80),
    account:String(body.account||"").slice(0,30),
    nature:String(body.nature||"").slice(0,30),
    project:String(body.project||"").slice(0,50),
    amount:Math.max(0,Number(body.amount)||0),
    note:String(body.note||"").slice(0,240),
    entry_id:String(body.entry_id),
    updated_at:String(body.updated_at||new Date().toISOString())
  };

  const upstream=await fetch("https://script.google.com/macros/s/AKfycbxC2dU7QiyGL2yMwC4jjoWtGquI-w2ATN4MzeyPMFy7uVuELY3j44MnbzSBwy1LcOVERg/exec",{
    method:"POST",
    headers:{"content-type":"text/plain;charset=UTF-8"},
    body:JSON.stringify(payload),
    redirect:"follow"
  });
  const textBody=await upstream.text();
  let result=null;try{result=JSON.parse(textBody)}catch{}
  if(!upstream.ok||!result?.ok)return json({error:"google mirror failed",status:upstream.status,upstream:result||null},502);
  return json({ok:true,action:payload.action,entry_id:payload.entry_id});
}


async function foodReviewProbe(url){
  const title=(url.searchParams.get("title")||"").trim().slice(0,120);
  const city=(url.searchParams.get("city")||"").trim().slice(0,40);
  if(!title)return json({error:"missing title"},400);
  const target="https://www.google.com/maps/search/?api=1&query="+encodeURIComponent([title,city].filter(Boolean).join(" "))+"&hl=zh-TW";
  const upstream=await fetch(target,{
    headers:{
      "user-agent":"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      "accept-language":"zh-TW,zh;q=0.9,en;q=0.7"
    },
    cf:{cacheTtl:3600,cacheEverything:true}
  });
  const html=await upstream.text();
  const decoded=html
    .replace(/\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
    .replace(/\\x22/g,'"').replace(/\\x27/g,"'")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  const plain=decoded
    .replace(/<script[\\s\\S]*?<\\/script>/gi," ")
    .replace(/<style[\\s\\S]*?<\\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\\s+/g," ")
    .trim();
  const hasSummary=decoded.includes("評論摘要");
  const hasReviews=decoded.includes("篇評論")||decoded.includes("評論");
  const pos=Math.max(decoded.indexOf("評論摘要"),decoded.indexOf("篇評論"));
  const sample=(pos>=0?decoded.slice(Math.max(0,pos-500),pos+5000):plain.slice(0,3000));
  return json({ok:upstream.ok,status:upstream.status,length:html.length,hasSummary,hasReviews,sample:sample.slice(0,5000)});
}

async function cleanup(env){
  await env.DB.prepare(`DELETE FROM snapshots
    WHERE backup_day IS NOT NULL
      AND backup_day < date('now','-30 days')
      AND (
        backup_day < date('now','-24 months')
        OR backup_day <> (
          SELECT MIN(s2.backup_day)
          FROM snapshots s2
          WHERE s2.family_id=snapshots.family_id
            AND s2.backup_day IS NOT NULL
            AND substr(s2.backup_day,1,7)=substr(snapshots.backup_day,1,7)
        )
      )`).run();
  await env.DB.prepare("DELETE FROM snapshots WHERE backup_day IS NULL AND created_at < datetime('now','-1 day') AND version_id NOT IN (SELECT current_version FROM families WHERE current_version IS NOT NULL)").run();
}

export default{
  async fetch(req,env){
    const url=new URL(req.url);
    if(!url.pathname.startsWith("/api/"))return env.ASSETS.fetch(req);
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS_HEADERS});
    try{
      if(url.pathname==="/api/health")return json({ok:true,service:"home-flow",time:new Date().toISOString()});
      if(url.pathname==="/api/food-review-probe"&&req.method==="GET")return foodReviewProbe(url);
      if(url.pathname==="/api/family"&&req.method==="POST")return createFamily(env);
      const user=await auth(req,env);
      if(!user)return json({error:"unauthorized"},401);
      if(url.pathname==="/api/snapshot"&&req.method==="GET")return readSnapshot(req,env,user);
      if(url.pathname==="/api/snapshot"&&req.method==="PUT")return writeSnapshot(req,env,user);
      if(url.pathname==="/api/backups"&&req.method==="GET")return listBackups(env,user);
      if(url.pathname==="/api/backup"&&req.method==="GET")return readBackup(url,env,user);
      if(url.pathname==="/api/restore"&&req.method==="POST")return restoreBackup(req,env,user);
      if(url.pathname==="/api/google-mirror"&&req.method==="POST")return googleMirror(req,user);
      return json({error:"not found"},404);
    }catch(err){
      console.error(err);
      return json({error:"server error"},500);
    }
  },
  async scheduled(_controller,env){await cleanup(env)}
};
