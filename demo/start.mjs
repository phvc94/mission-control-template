// `npm run demo`: the real interface over fictional data. No login (loopback only), no model is called,
// nothing outside a temporary folder is read or written, and every write request is refused.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server/http.mjs';
import { createAuth } from '../server/auth.mjs';
import { originAliases } from '../server/config.mjs';
import { createWorkspace } from '../server/workspace.mjs';
import { createMonitor } from '../server/monitor.mjs';

const run=promisify(execFile);
const port=Number(process.env.MC_DEMO_PORT||4319);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid demo port.');
const origin=`http://127.0.0.1:${port}`;
const base=await mkdtemp(path.join(tmpdir(),'mission-control-demo-'));
const root=path.join(base,'workspace'),stateDir=path.join(base,'state'),remote=path.join(base,'remote.git');
const MIN=60_000,HOUR=60*MIN,DAY=24*HOUR,start=Date.now();
const day=offset=>new Date(start+offset*DAY).toISOString().slice(0,10);
const ago=ms=>start-ms;

// ---- Workspace: three projects, ten tasks, a priority list and a few documents (English layout).
const project=(title,status,what,next,extra='')=>`# ${title}\n\n**Status:** ${status}\n\n## What it is\n${what}\n${extra}\n## Next steps\n${next.map(n=>`- [ ] ${n}`).join('\n')}\n`;
const documents={
 'projects/website-relaunch/STATE.md':project('Website relaunch','active','A new public site for a fictional studio: fewer pages, faster, written by people and reviewed by agents.',['Approve the homepage copy','Move the blog archive to the new layout','Measure page speed after launch']),
 'projects/website-relaunch/brief.md':'# Brief\n\nGoal: a site a visitor understands in ten seconds.\n\n- Audience: small teams evaluating the studio\n- Tone: plain, specific, no buzzwords\n- Launch: when the homepage copy is approved\n',
 'projects/customer-research/STATE.md':project('Customer research','active','Twelve fictional interviews about how small teams plan their week, summarized for the product roadmap.',['Synthesize interviews 7 to 12','Review the themes with the team']),
 'projects/customer-research/interview-notes.md':'# Interview notes\n\n| # | Role | Main pain |\n|---|---|---|\n| 1 | Founder | Too many tools |\n| 2 | Designer | Unclear priorities |\n| 3 | Engineer | Meetings break focus |\n',
 'projects/home-office/STATE.md':project('Home office','paused','Small improvements to a fictional home office: lighting, a second monitor and a quieter desk.',['Pick a desk lamp','Order a monitor arm']),
 'agents/atlas/STATE.md':'# Atlas\n\n**Status:** active\n\n## What it is\nA fictional chief-of-staff agent: plans the day and keeps the task queue tidy.\n',
 'system/STATE.md':'# System\n\n**Status:** active\n\n## What it is\nThe fictional workspace behind this demo.\n',
 'research/2026-planning-tools.md':'# Planning tools compared\n\nA fictional comparison of five planning tools, kept as an example document.\n',
};
const task=(id,title,proj,status,owner,due,{type='task',user='1',exec='0',depends=[],body='What to do, and how to know it is done.'}={})=>[`tasks/${id}.md`,`---\nid: ${id}\ntitle: ${title}\nproject: ${proj}\ntype: ${type}\nstatus: ${status}\nowner: ${owner}\nuser_slots: '${user}'\nexec_slots: '${exec}'\ndue: '${due}'\ndepends_on: [${depends.join(', ')}]\ncreated: ${day(-12)}\nupdated: ${day(-1)}\n---\n\n${body}\n`];
Object.assign(documents,Object.fromEntries([
 task('approve-homepage-copy','Approve the homepage copy','website-relaunch','open','user',day(2),{user:'1',body:'Read the draft in projects/website-relaunch/brief.md and approve or comment.'}),
 task('migrate-blog-archive','Move the blog archive to the new layout','website-relaunch','open','quill',day(6),{user:'0',exec:'3'}),
 task('fix-contact-form','Fix the contact form on mobile','website-relaunch','open','atlas',day(-1),{user:'0',exec:'1',type:'improvement'}),
 task('page-speed-check','Measure page speed after launch','website-relaunch','waiting','sentinel','—',{user:'0',exec:'1',depends:['approve-homepage-copy']}),
 task('synthesize-interviews','Synthesize interviews 7 to 12','customer-research','open','nova',day(3),{user:'0',exec:'4',type:'research'}),
 task('review-themes','Review the research themes with the team','customer-research','open','user',day(8),{user:'2',depends:['synthesize-interviews']}),
 task('monthly-budget','Close the monthly budget','system','open','ledger',day(0),{user:'1',exec:'1'}),
 task('choose-desk-lamp','Pick a desk lamp','home-office','parked','user','—',{user:'1',type:'idea'}),
 task('weekly-plan','Prepare the weekly plan','system','done','atlas',day(-3),{user:'0',exec:'1'}),
 task('backup-review','Check last week\'s backups','system','open','sentinel',day(1),{user:'0',exec:'1',type:'task'}),
]));
documents['tasks/_priorities.md']=`---\nids:\n  - approve-homepage-copy\n  - fix-contact-form\n  - synthesize-interviews\n  - monthly-budget\nupdated: ${day(-1)}\n---\n`;
for(const [relative,text]of Object.entries(documents)){const file=path.join(root,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
// A real local Git history, and a local "remote" one commit behind, so the Git/GitHub card has numbers.
const git=async(args,when=start)=>run('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Demo','-c','user.email=demo@example.test',...args],{cwd:root,env:{...process.env,GIT_AUTHOR_DATE:new Date(when).toISOString(),GIT_COMMITTER_DATE:new Date(when).toISOString()}});
await git(['init','-q','-b','main']);
await git(['add','projects','system','research']);await git(['commit','-q','-m','Project notes and research'],ago(3*DAY));
await git(['add','agents']);await git(['commit','-q','-m','Atlas: state file'],ago(2*DAY));
await run('git',['init','-q','--bare','-b','main',remote]);await git(['remote','add','origin',remote]);await git(['push','-q','-u','origin','main']);
await git(['add','tasks']);await git(['commit','-q','-m','Tasks for this week'],ago(5*HOUR));

// ---- OpenClaw: five agents, their models, sessions, routines and channels (fixed fictional values).
const models=[['anthropic/sonata-large','Sonata Large','anthropic',1_000_000],['anthropic/sonata-fast','Sonata Fast','anthropic',200_000],['openai/vector-pro','Vector Pro','openai',400_000],['openai/vector-mini','Vector Mini','openai',128_000],['ollama/compact-local','Compact Local','ollama',32_000]].map(([id,name,provider,contextWindow])=>({id,name,provider,contextWindow,available:true,local:provider==='ollama',configured:true}));
const session=(agentId,label,channel,updated,tokens,model,active=false)=>({key:`agent:${agentId}:${channel}:${label.toLowerCase().replace(/\W+/g,'-')}`,id:`s-${agentId}-${channel}`,agentId,label,kind:'direct',channel,updatedAt:ago(updated),lastInteractionAt:ago(updated),totalTokens:tokens,totalTokensFresh:true,contextTokens:models.find(m=>m.id===model).contextWindow,model,modelProvider:model.split('/')[0],status:active?'running':'done',active,archived:false});
const sessions=[session('atlas','Daily plan','telegram',4*MIN,182_000,'anthropic/sonata-large',true),session('nova','Interview synthesis','dashboard',35*MIN,96_000,'openai/vector-pro'),session('quill','Blog archive','dashboard',3*HOUR,41_000,'anthropic/sonata-fast'),session('ledger','Monthly budget','telegram',6*HOUR,12_500,'openai/vector-mini'),session('sentinel','Nightly checks','cron',9*HOUR,6_200,'ollama/compact-local'),session('atlas','Weekly review','dashboard',2*DAY,240_000,'anthropic/sonata-large')];
const agent=(id,name,model,fallbacks)=>{const own=sessions.filter(s=>s.agentId===id).sort((a,b)=>b.updatedAt-a.updatedAt);return {id,name,emoji:null,model,fallbacks,fallbackSource:'gateway',fallbacksKnown:true,workspace:`/workspace/agents/${id}`,status:own.some(s=>s.active)?'active':'idle',lastActiveAt:own[0]?.updatedAt??null,sessionCount:own.length,activeSessionCount:own.filter(s=>s.active).length,contextWindow:models.find(m=>m.id===model).contextWindow,latestSession:own[0]||null};};
const agents=[agent('atlas','Atlas','anthropic/sonata-large',['openai/vector-pro']),agent('nova','Nova','openai/vector-pro',['anthropic/sonata-fast']),agent('quill','Quill','anthropic/sonata-fast',['openai/vector-mini']),agent('ledger','Ledger','openai/vector-mini',[]),agent('sentinel','Sentinel','ollama/compact-local',[])];
const routine=(id,name,agentId,expr,last,next,lastStatus='ok')=>({id,name,agentId,enabled:true,schedule:{kind:'cron',expr,tz:'UTC',staggerMs:null},lastRunAt:ago(last),nextRunAt:start+next,lastStatus,lastDurationMs:42_000,consecutiveErrors:lastStatus==='ok'?0:1,deliveryStatus:'delivered',hasError:lastStatus!=='ok',configRevision:'demo'});
const routines=[routine('morning-brief','Morning brief','atlas','0 7 * * 1-5',7*HOUR,17*HOUR),routine('inbox-triage','Inbox triage','atlas','0 */3 * * *',50*MIN,130*MIN),routine('research-digest','Research digest','nova','0 16 * * 5',3*DAY,4*DAY),routine('nightly-checks','Nightly checks','sentinel','30 2 * * *',9*HOUR,15*HOUR)];
const channels=[{id:'telegram:atlas',channel:'telegram',accountId:'atlas',name:'Atlas bot',configured:true,enabled:true,running:true,connected:true,reconnectAttempts:0,lastConnectedAt:ago(3*DAY),lastInboundAt:ago(4*MIN),lastOutboundAt:ago(4*MIN),activeRuns:1,hasError:false,lifecycle:'running',lastError:null},{id:'telegram:ledger',channel:'telegram',accountId:'ledger',name:'Ledger bot',configured:true,enabled:true,running:true,connected:true,reconnectAttempts:0,lastConnectedAt:ago(3*DAY),lastInboundAt:ago(6*HOUR),lastOutboundAt:ago(6*HOUR),activeRuns:0,hasError:false,lifecycle:'running',lastError:null}];
const health=()=>({ok:true,checkedAt:Date.now(),durationMs:38,heartbeatSeconds:null,eventLoop:{degraded:false,delayP99Ms:14,delayMaxMs:41,utilization:0.07,cpuCoreRatio:0.06,intervalMs:60_000},failedDeliveries:0,failedIngress:0,deliveryQueues:{failed:[],ingressFailed:[]},pluginsLoaded:7,pluginErrors:0});
const gateway={
 snapshot:async()=>({agents,models,sessions,routines,channels,health:health(),errors:[],collectedAt:new Date().toISOString(),source:'demo',connection:null}),
 chatHistory:async key=>({sessionKey:key,messages:[]}),
 cronRuns:async id=>({id,entries:[{at:routines.find(r=>r.id===id)?.lastRunAt,status:'ok',durationMs:42_000,deliveryStatus:'delivered'}]}),
 getCron:async id=>routines.find(r=>r.id===id),
};

// ---- Server metrics: a synthetic three-hour history; health checks with one warning.
let seed=7;const random=()=>{seed=(seed*16807)%2147483647;return (seed-1)/2147483646;};
const walk=(value,low,high,step)=>Math.min(high,Math.max(low,value+(random()-0.5)*step));
const GB=1024**3,history=[];
for(let i=0,cpu=14,mem=6.1,rss=92;i<180;i++){cpu=walk(cpu,6,28,6);mem=walk(mem,5.7,6.8,0.08);rss=walk(rss,86,108,1.5);const spike=random()<0.06?20+random()*25:0;const point={at:new Date(start-(179-i)*MIN).toISOString(),cpuPercent:Math.round(Math.min(97,cpu+spike)),memoryUsed:Math.round(mem*GB),processRss:Math.round(rss*1024**2)};point.load=Math.round(((history.at(-1)?.load??0.6)*0.85+point.cpuPercent/100*4*0.15)*100)/100;history.push(point);}
const metrics={snapshot:async()=>{const last=history.at(-1);return {collectedAt:new Date().toISOString(),hostname:'demo-server',platform:'Linux x64',cpus:4,cpuPercent:last.cpuPercent,memory:{total:16*GB,available:16*GB-last.memoryUsed,used:last.memoryUsed},disk:{total:200*GB,available:138*GB,used:62*GB},load:[last.load,0.71,0.58],uptime:12*DAY/1000+5*3600,process:{rss:last.processRss,heapUsed:41*1024**2,uptime:5*3600,eventLoopDelay:{meanMs:0.6,p99Ms:1.8,maxMs:6.2}},gateway:null,errors:[],history,stale:false};}};
await mkdir(stateDir,{recursive:true});
await writeFile(path.join(stateDir,'checks.json'),JSON.stringify({checked_at:new Date().toISOString(),checks:{disk:{status:'ok',message:'Disk below 80%'},backup:{status:'warn',message:'Last backup is 30 hours old'},'memory:nova':{status:'ok',message:'Memory index current'}}}));

const server=createApp({origin,auth:createAuth({mode:'none'}),workspace:createWorkspace({root,stateDir,layout:'en'}),gateway,monitor:createMonitor({stateDir,workspaceDir:root,metrics}),stateDir,persistJobs:false,demo:true,publicDir:fileURLToPath(new URL('../public/',import.meta.url))});
// This entry point uses only the temporary folder created above and reads no MC_* variable except
// MC_DEMO_PORT. It answers only on loopback, and every HTTP write is refused.
const hosts=new Set(originAliases(origin).map(o=>new URL(o).host));
const handler=server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request',(req,res)=>{
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!hosts.has(req.headers.host)){res.writeHead(403);res.end('Invalid demo host.');return;}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Read-only demo. Set up your own installation to use the real controls.'}));return;}
 return handler(req,res);
});
server.listen(port,'127.0.0.1',()=>console.log(`DEMO · fictional data · read-only\n${origin}`));
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(base,{recursive:true,force:true});process.exit(0);};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
