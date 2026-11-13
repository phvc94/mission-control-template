import {createServer} from 'node:http';
import {readFile, appendFile, mkdir, writeFile, rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {AppError} from './errors.mjs';
import {exportDocument} from './export.mjs';
import {i18n, requestLanguage, translate, t} from './i18n.mjs';
import {originAliases} from './config.mjs';

const media={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.txt':'text/plain; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const routes=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/brand.js','brand.js'],['/i18n.js','i18n.js'],['/locales/pt.js','locales/pt.js'],['/locales/pt-messages.js','locales/pt-messages.js'],['/styles.css','styles.css'],['/lucide.min.js','lucide.min.js'],['/lucide-LICENSE.txt','lucide-LICENSE.txt'],['/print.js','print.js']]);
const emptyWorkspace=()=>({items:[],projects:[],priorities:{ids:[],version:''},warnings:[],generalProjects:[],today:new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())});
const JOB_RETENTION_MS=24*60*60*1000;
const UPLOAD_LIMIT=64*1024*1024;
const UPLOAD_RETENTION_MS=12*60*60*1000;
// auth: an authenticator from server/auth.mjs. demo: marks the data as fictional for the interface.
export function createApp({workspace,gateway,monitor,auth,origin,publicDir,stateDir,auditWriter,now=Date.now,chatLifetimeMs=30*60*1000,persistJobs=Boolean(stateDir),demo=false}){
  if(!auth || !origin)throw new Error('Authentication and origin are required.');
  // A loopback origin also answers as localhost/127.0.0.1/[::1] on the same port; any other origin is exact.
  const origins=new Set(originAliases(origin)),hosts=new Set([...origins].map(o=>new URL(o).host));
  const jobs=new Map();const uploads=new Map();let statusPending;let statusCache;let activityCache;let lastSweep=0;
  async function audit(action,target,actor,result='confirmed'){
    const event={at:new Date(now()).toISOString(),actor,action,target,result};
    if(auditWriter)return auditWriter(event);
    await mkdir(stateDir,{recursive:true});
    await appendFile(path.join(stateDir,'actions.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});
  }
  async function auditedAction(action,target,actor,perform){
    await audit(action,target,actor,'requested');
    const result=await perform();invalidate();
    try{await audit(action,target,actor,'confirmed');return result;}
    catch{return {...result,auditWarning:'The change was confirmed, but the audit record failed. Do not repeat the action.'};}
  }
  // Chats in progress survive a service restart: the runId lets the new process wait on the same run again.
  const jobsFile=()=>path.join(stateDir,'chat-jobs.json');
  let jobsWrite=Promise.resolve();
  function persistJobsNow(){
    if(!persistJobs)return;
    // The message text is never written to disk: resuming only needs the runId and the session.
    const snapshot=[...jobs.values()].filter(j=>now()-j.createdAt<JOB_RETENTION_MS).map(j=>({...j,input:j.input?{...j.input,message:undefined}:undefined}));
    jobsWrite=jobsWrite.then(async()=>{await mkdir(stateDir,{recursive:true});const temporary=jobsFile()+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(snapshot),{mode:0o600});await rename(temporary,jobsFile());}).catch(()=>{});
    return jobsWrite;
  }
  async function followJob(job,input){
    const until=job.createdAt+chatLifetimeMs;
    try{
      let result=job.result;
      if(!result){
        result=await gateway.chat({agentId:input.agentId,message:input.message,sessionKey:input.sessionKey,idempotencyKey:input.idempotencyKey||job.jobId});
        job.result=result;persistJobsNow();
      }
      while(result.status==='pending'&&now()<until){job.result=result;persistJobsNow();result={...result,...await gateway.waitChat({runId:result.runId,sessionKey:result.sessionKey,waitTimeoutMs:Math.min(180000,Math.max(0,until-now()))})};}
      job.result=result;job.status=result.status==='pending'?'pending':'completed';job.finishedAt=now();invalidate();
      try{await audit('Agent chat',input.agentId,job.actor,result.status||'confirmed');}catch{job.auditWarning='The reply arrived, but the action record failed.';}
    }catch(error){job.status='failed';job.finishedAt=now();job.error=error?.status?error.message:'Could not confirm the agent\'s reply. Check the history before trying again.';}
    persistJobsNow();
  }
  const ready=(async()=>{
    if(!persistJobs)return;
    let saved=[];
    try{saved=JSON.parse(await readFile(jobsFile(),'utf8'));}catch{return;}
    if(!Array.isArray(saved))return;
    for(const job of saved){
      if(!job||typeof job.jobId!=='string'||now()-Number(job.createdAt)>JOB_RETENTION_MS)continue;
      jobs.set(job.jobId,job);
      if(job.status!=='running')continue;
      if(job.result?.runId&&job.result?.sessionKey&&job.input){
        // The service restarted while waiting: follow the same run without resending the message.
        job.result={...job.result,status:'pending'};
        void followJob(job,job.input);
      } else {job.status='failed';job.error='The service restarted before the send was confirmed. Check the conversation before resending.';}
    }
    persistJobsNow();
  })();
  const decodePart=value=>{try{return decodeURIComponent(value);}catch{throw new AppError('Invalid identifier.',400);}};
  async function status(){
    if(statusCache&&Date.now()-statusCache.at<15000)return statusCache.value;
    if(statusPending)return statusPending;
    statusPending=(async()=>{
      const results=await Promise.allSettled([workspace.snapshot(),gateway.snapshot(),monitor.snapshot()]);
      const ws=results[0].status==='fulfilled'?results[0].value:emptyWorkspace();
      const gw=results[1].status==='fulfilled'?results[1].value:{agents:[],sessions:[],routines:[],models:[],channels:[],errors:[{source:'gateway',message:'Could not connect to OpenClaw.'}]};
      const host=results[2].status==='fulfilled'?results[2].value:{vm:null,incidents:[],warnings:[],acks:[],sources:{vm:{connected:false,error:'Server metrics unavailable.'}}};
      // Without MC_WORKSPACE the dashboard still runs: the interface shows an empty state instead of an error.
      const wsSource=workspace.configured===false?{connected:false,configured:false,status:'not_configured',error:null,description:'No workspace connected. Set MC_WORKSPACE to a Markdown/Git folder to see tasks, projects and documents.'}:{connected:results[0].status==='fulfilled',error:results[0].status==='rejected'?'Could not read the task queue and status files on the server.':null};
      const value={...host,gateway:gw,workspace:ws,collectedAt:new Date().toISOString(),sources:{...host.sources,workspace:wsSource,gateway:{connected:results[1].status==='fulfilled'&&!(gw.errors?.length),partial:results[1].status==='fulfilled'&&!!gw.errors?.length,collectedAt:gw.collectedAt}}};
      statusCache={at:Date.now(),value};return value;
    })().finally(()=>{statusPending=null});return statusPending;
  }
  function invalidate(){statusCache=null;activityCache=null;}
  // Activity timeline: commits, routine runs, chats and dashboard actions, metadata only.
  async function activity(){
    if(activityCache&&Date.now()-activityCache.at<60000)return activityCache.value;
    const [commits,snapshot,auditRead]=await Promise.allSettled([workspace.recentCommits?.(60)??[],status(),readAudit()]);
    const events=[];
    for(const c of commits.status==='fulfilled'?commits.value:[])events.push({kind:c.routine?'sync':'commit',at:c.at,title:c.subject,actor:c.author,ref:c.hash});
    const data=snapshot.status==='fulfilled'?snapshot.value:null;
    for(const r of data?.gateway?.routines||[])if(r.lastRunAt)events.push({kind:'routine',at:new Date(r.lastRunAt).toISOString(),title:r.lastStatus?`Routine ${r.name||r.id}: ${r.lastStatus}`:`Routine ${r.name||r.id} ran`,actor:r.agentId,ref:r.id,status:r.lastStatus});
    for(const s of data?.gateway?.sessions||[])if(s.updatedAt)events.push({kind:'session',at:new Date(s.updatedAt).toISOString(),title:`Conversation ${s.label||s.key}`,actor:s.agentId,ref:s.key,status:s.active?'running':null});
    for(const e of auditRead.status==='fulfilled'?auditRead.value:[])if(e.result!=='requested'&&e.phase!=='requested'&&e.phase!=='prepared')events.push({kind:'action',at:e.at,title:`${e.action||'Dashboard action'}${e.target||e.path?' · '+(e.target||e.path):''}`,actor:e.actor,ref:e.commit||null,status:e.result||e.phase||null});
    const value={events:events.filter(e=>e.at&&Number.isFinite(Date.parse(e.at))).sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,120),collectedAt:new Date().toISOString(),sources:{commits:commits.status==='fulfilled',gateway:!!data,audit:auditRead.status==='fulfilled'}};
    activityCache={at:Date.now(),value};return value;
  }
  async function readAudit(){
    const records=[];for(const name of ['actions.jsonl','workspace-audit.jsonl'])try{const lines=(await readFile(path.join(stateDir,name),'utf8')).trim().split('\n').slice(-150);for(const line of lines)try{records.push(JSON.parse(line))}catch{}}catch{}
    return records.sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,150);
  }
  async function body(req){
    if(req.headers['content-type']?.split(';')[0]!=='application/json'||req.headers['x-mission-control']!=='1')throw new AppError('Invalid request format or origin.',403);
    const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>2200000)throw new AppError('The document exceeds the request size limit.',413);chunks.push(part);}
    let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('Invalid JSON.');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('The request body must be a JSON object.',400);
    return value;
  }
  function resolveAttachments(actor,ids){
    if(ids===undefined)return [];
    if(!Array.isArray(ids)||ids.length>10||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw new AppError('Invalid attachments. Send up to 10 files per message.',400);
    return ids.map(id=>{const u=uploads.get(id);if(!u||u.actor!==actor)throw new AppError('One of the attachments is no longer available. Upload the file again.',410);return u;});
  }
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
      await ready;
      // Liveness for container health checks: no data, no identity, answered before every other check.
      if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end('ok\n');}
      if(!hosts.has(req.headers.host))throw new AppError('Host not allowed.',403);
      const navigation=req.method==='GET'&&req.headers['sec-fetch-mode']==='navigate';
      if(req.headers['sec-fetch-site']&& !['same-origin','none'].includes(req.headers['sec-fetch-site'])&&!navigation)throw new AppError('Origin not allowed.',403);
      if(req.headers.origin&&!origins.has(req.headers.origin)&&!navigation)throw new AppError('Origin not allowed.',403);
      const url=new URL(req.url,origin);
      if(origin.startsWith('https://')){res.setHeader('Strict-Transport-Security','max-age=31536000');if(req.headers['x-forwarded-proto']!=='https')throw new AppError('An HTTPS connection is required.',403);}
      const write=['POST','PATCH','PUT','DELETE'].includes(req.method);
      if(write&&!origins.has(req.headers.origin))throw new AppError('Changes from this origin are not allowed.',403);
      if(req.method==='GET'&&url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
      if(await auth.route(req,res,url))return;
      let actor;
      try{actor=(await auth.identify(req))?.actor;}
      catch(error){
        // Opening the dashboard without a session goes to the login page; everything else gets the error.
        if(error?.status===401&&req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')){res.writeHead(303,{Location:'/login'});return res.end();}
        throw error;
      }
      // The actor recorded in audits is the authenticated identity: an email, a proxy user, the token name or "local".
      if(typeof actor!=='string'||!actor.trim()||actor.length>254||/[\u0000-\u001f\u007f]/.test(actor))throw new AppError('A personal identity is required.',403);
      if(req.method==='GET'&&url.pathname==='/api/status')return json(200,{...await status(),access:{...auth.describe(),actor},demo:demo===true});
      if(req.method==='GET'&&url.pathname==='/api/activity')return json(200,await activity());
      if(req.method==='GET'&&url.pathname==='/api/files')return json(200,await workspace.listFiles({path:url.searchParams.get('path')||'',query:url.searchParams.get('query')||'',limit:300}));
      if(req.method==='GET'&&url.pathname==='/api/document')return json(200,await workspace.readDocument(url.searchParams.get('path')||''));
      if(req.method==='POST'&&url.pathname==='/api/document'){const result=await workspace.saveDocument(await body(req),actor);invalidate();return json(200,result);}
      if(req.method==='POST'&&url.pathname==='/api/tasks/mutate'){const result=await workspace.mutate(await body(req),actor);invalidate();return json(200,result);}
      if(req.method==='POST'&&url.pathname==='/api/alerts/ack'){const input=await body(req);return json(200,await auditedAction('Acknowledge alert',String(input.key||''),actor,()=>monitor.acknowledge(input,actor)));}
      if(req.method==='POST'&&url.pathname==='/api/alerts/unack'){const input=await body(req);return json(200,await auditedAction('Reactivate alert',String(input.key||''),actor,()=>monitor.unacknowledge(input,actor)));}
      if(req.method==='GET'&&url.pathname==='/api/export')return exportDocument(res,await workspace.readDocument(url.searchParams.get('path')||''),url.searchParams.get('format')||'md',url.searchParams.has('lang')?i18n.normalize(url.searchParams.get('lang')):requestLanguage(req));
      if(req.method==='POST'&&url.pathname==='/api/upload'){
        // Raw body, not JSON: the file streams straight to disk. Name, agent and destination come in headers.
        if(req.headers['x-mission-control']!=='1')throw new AppError('Invalid upload origin.',403);
        for(const [id,u] of uploads)if(now()-u.createdAt>UPLOAD_RETENTION_MS)uploads.delete(id);
        const declared=Number(req.headers['content-length']);
        if(Number.isFinite(declared)&&declared>UPLOAD_LIMIT)throw new AppError('File larger than 64 MB.',413);
        const name=decodePart(String(req.headers['x-file-name']||''));
        if(now()-lastSweep>3600000){lastSweep=now();workspace.sweepUploads?.().catch(()=>{});}
        const stored=await workspace.storeUpload({agentId:String(req.headers['x-agent-id']||''),destination:String(req.headers['x-destination']||'temporario'),name,mimeType:String(req.headers['content-type']||'application/octet-stream').split(';')[0],stream:req,maxBytes:UPLOAD_LIMIT},actor);
        const record={...stored,actor,createdAt:now()};uploads.set(record.id,record);
        try{await audit('Send file',stored.path,actor);}catch{}
        return json(201,{id:record.id,name:record.name,path:record.path,size:record.size,mimeType:record.mimeType,destination:record.destination,temporary:record.temporary===true,expiresAt:record.expiresAt||null,agentId:record.agentId});
      }
      const runs=url.pathname.match(/^\/api\/routines\/([^/]+)\/runs$/);
      if(req.method==='GET'&&runs)return json(200,await gateway.cronRuns(decodePart(runs[1])));
      const cron=url.pathname.match(/^\/api\/routines\/([^/]+)$/);
      if(req.method==='GET'&&cron)return json(200,await gateway.getCron(decodePart(cron[1])));
      if(req.method==='PATCH'&&cron){const id=decodePart(cron[1]);const input=await body(req);return json(200,await auditedAction('Update routine',id,actor,()=>gateway.updateCron(id,input)));}
      const model=url.pathname.match(/^\/api\/agents\/([^/]+)\/models$/);
      if(req.method==='POST'&&model){const id=decodePart(model[1]);const input=await body(req);return json(200,await auditedAction('Update models',id,actor,()=>gateway.setModels(id,input)));}
      if(req.method==='GET'&&url.pathname==='/api/chat')return json(200,await gateway.chatHistory(url.searchParams.get('sessionKey')||''));
      if(req.method==='POST'&&url.pathname==='/api/chat'){
        for(const [id,j] of jobs)if(now()-j.createdAt>3600000&&j.status!=='running')jobs.delete(id);
        const input=await body(req);
        if(typeof input.agentId!=='string'||!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(input.agentId)||typeof input.message!=='string'||input.message.length>40000)throw new AppError('Provide the agent and a message of up to 40,000 characters.',400);
        if(input.idempotencyKey!==undefined&&(typeof input.idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotencyKey)))throw new AppError('Invalid send identifier.',400);
        const attachments=resolveAttachments(actor,input.attachments);
        if(attachments.some(a=>a.agentId!==input.agentId))throw new AppError('One of the attachments was uploaded for another agent. Attach it again in this conversation.',400);
        if(!input.message.trim()&&!attachments.length)throw new AppError('Write a message or attach a file.',400);
        // The agent receives the file path in the same format Telegram attachments use; the content never goes through JSON.
        // The note the agent reads follows the language of the person who sent it.
        const lang=requestLanguage(req);
        const retention=a=>a.destination==='anexos'?t(lang,'saved in your attachments folder, outside Git'):t(lang,'TEMPORARY: will be deleted automatically in 3 days; if it should stay, move it to the right place following the workspace rules and tell me the path');
        const files=attachments.map(a=>`${a.name}, ${a.mimeType}, ${Math.max(1,Math.round(a.size/1024))} KB, ${retention(a)}`).join('; ');
        const message=(input.message.trim()||t(lang,'Here is the attached file.'))+(attachments.length?'\n\n'+attachments.map(a=>`[media attached: ${a.gatewayPath}]`).join('\n')+'\n\n'+t(lang,'(Files sent by the user from Mission Control: {files}. Read them from the path above.)',{files}):'');
        const fingerprint=JSON.stringify([input.agentId,input.sessionKey||null,message]);
        const duplicate=input.idempotencyKey&&[...jobs.values()].find(j=>j.actor===actor&&j.requestKey===input.idempotencyKey);
        if(duplicate){if(duplicate.requestFingerprint!==fingerprint)throw new AppError('This identifier was already used for another message.',409);return json(202,{jobId:duplicate.jobId,status:duplicate.status});}
        if([...jobs.values()].filter(x=>x.status==='running').length>=3)throw new AppError('Three requests are already in progress. Wait for one of them to finish.',429);
        const id=randomUUID();const chatInput={agentId:input.agentId,message,sessionKey:input.sessionKey,idempotencyKey:input.idempotencyKey||id};
        const job={jobId:id,status:'running',createdAt:now(),actor,requestKey:input.idempotencyKey,requestFingerprint:fingerprint,input:chatInput,attachments:attachments.map(a=>({name:a.name,path:a.path,size:a.size,mimeType:a.mimeType}))};jobs.set(id,job);
        try{await audit('Agent chat',input.agentId,actor,'requested');}catch(error){jobs.delete(id);throw error;}
        for(const a of attachments)uploads.delete(a.id);
        persistJobsNow();
        void followJob(job,chatInput);
        return json(202,{jobId:id,status:'running'});
      }
      const jobMatch=url.pathname.match(/^\/api\/chat\/jobs\/([a-f0-9-]+)$/);
      if(req.method==='GET'&&jobMatch){const job=jobs.get(jobMatch[1]);if(!job||job.actor!==actor)throw new AppError('Request not found.',404);return json(200,{jobId:job.jobId,status:job.status,result:job.result,error:job.error,auditWarning:job.auditWarning,attachments:job.attachments||[]});}
      if(req.method==='GET'&&url.pathname==='/api/chat/jobs'){return json(200,{jobs:[...jobs.values()].filter(j=>j.actor===actor).map(j=>({jobId:j.jobId,status:j.status,agentId:j.input?.agentId,sessionKey:j.result?.sessionKey||j.input?.sessionKey||null,createdAt:new Date(j.createdAt).toISOString(),finishedAt:j.finishedAt?new Date(j.finishedAt).toISOString():null}))});}
      if(req.method==='POST'&&url.pathname==='/api/sessions/renew'){const input=await body(req);if(typeof input.sessionKey!=='string'||input.sessionKey.length>512)throw new AppError('Invalid session.',400);return json(200,await auditedAction('Renew session',input.sessionKey,actor,()=>gateway.renewSession(input.sessionKey,input)));}
      if(req.method==='GET'&&url.pathname==='/api/audit')return json(200,{events:(await readAudit()).slice(0,100)});
      if(req.method==='GET'&&routes.has(url.pathname)){const name=routes.get(url.pathname);const contents=await readFile(path.join(publicDir,name));res.writeHead(200,{'Content-Type':media[path.extname(name)]});return res.end(contents);}
      throw new AppError('Not found.',404);
    }catch(error){
      // Messages are produced in English; the response follows the language the interface asked for.
      const code=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500;
      const message=code===500?'Could not complete the operation. The service logged a failure.':String(error.message);
      return json(code,{error:String(translate(requestLanguage(req),message)).slice(0,1000),details:error.details});
    }
  });
}
