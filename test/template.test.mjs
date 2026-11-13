import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function freePort(){const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;}
async function started(t,args,env,marker){
 const child=spawn(process.execPath,['--experimental-strip-types',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>errors+=part);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
 for(let i=0;i<200&&!output.includes(marker);i++){if(child.exitCode!==null)assert.fail('Did not start: '+errors);await new Promise(resolve=>setTimeout(resolve,50));}
 assert(output.includes(marker),'should start: '+errors);
 return {child,output:()=>output,errors:()=>errors};
}

test('demo ignores the real environment, refuses writes and foreign hosts, and serves rich fictional data',async t=>{
 const port=await freePort();
 await started(t,['demo/start.mjs'],{...process.env,MC_DEMO_PORT:String(port),MC_WORKSPACE:'/does-not-exist',MC_AUTH:'token',MC_GATEWAY_URL:'ws://127.0.0.1:1',MC_WORKSPACE_LAYOUT:'pt'},`http://127.0.0.1:${port}`);
 const origin=`http://127.0.0.1:${port}`;
 const get=route=>fetch(origin+route);
 assert.equal((await get('/')).status,200);assert.equal((await get('/brand.js')).status,200);
 const snapshot=await (await get('/api/status')).json();
 assert.equal(snapshot.demo,true);assert.deepEqual(snapshot.access,{mode:'none',signOut:null,actor:'local'});
 assert.equal(snapshot.workspace.layout.lang,'en');
 assert.equal(snapshot.workspace.items.length,10);
 assert.equal(snapshot.workspace.items.find(i=>i.id==='approve-homepage-copy').fields.status,'aberto');
 assert.deepEqual([...new Set(snapshot.workspace.items.map(i=>i.fields.status))].sort(),['aberto','aguardando','estacionado','feito']);
 assert.deepEqual(snapshot.workspace.projects.filter(p=>p.kind==='projeto').map(p=>p.name),['customer-research','home-office','website-relaunch']);
 assert.equal(snapshot.workspace.priorities.ids[0],'approve-homepage-copy');
 assert.deepEqual(snapshot.gateway.agents.map(a=>a.id),['atlas','nova','quill','ledger','sentinel']);
 assert.equal(snapshot.gateway.routines.length,4);assert.ok(snapshot.gateway.sessions.length>=5);
 assert.deepEqual(snapshot.warnings.map(w=>w.key),['check:backup']);
 assert.ok(snapshot.vm.history.length>=60);assert.equal(typeof snapshot.vm.cpuPercent,'number');assert.equal(snapshot.vm.gateway,null);
 assert.equal(snapshot.vm.github.aheadOfRemote,1);assert.equal(snapshot.sources.github.connected,true);
 assert.equal((await get('/i18n.js')).status,200);assert.equal((await get('/locales/pt.js')).status,200);assert.equal((await get('/locales/pt-messages.js')).status,200);
 assert.equal((await fetch(origin+'/api/tasks/mutate',{method:'POST',headers:{origin,'content-type':'application/json','x-mission-control':'1'},body:'{}'})).status,405);
 const foreign=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/',headers:{host:'external.example.test'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
 assert.equal(foreign,403);
 assert.equal((await get('/api/document?path=projects/website-relaunch/brief.md')).status,200);
 assert.equal((await get('/api/document?path=../../etc/passwd')).status,403);
});

test('the production entry point explains a refused configuration in one line and exits',()=>{
 const base={PATH:process.env.PATH,HOME:process.env.HOME};
 for(const [env,pattern] of [
  [{MC_HOST:'0.0.0.0'},/MC_AUTH is required/],
  [{MC_AUTH:'token'},/openssl rand -hex 32/],
  [{MC_AUTH:'cloudflare-access',MC_ORIGIN:'https://dashboard.example.test',MC_ACCESS_TEAM:'example-team',MC_ACCESS_AUD:'a'.repeat(64),MC_ACCESS_EMAILS:', ,'},/at least one valid email/],
  [{MC_GATEWAY_URL:'ws://gateway.example.test:18789'},/wss:\/\//],
 ]){
  const result=spawnSync(process.execPath,['--experimental-strip-types','server/main.mjs'],{cwd:root,env:{...base,...env},encoding:'utf8',timeout:15000});
  assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/^Mission Control cannot start: /);assert.match(result.stderr,pattern);
  assert.doesNotMatch(result.stderr,/\n\s+at /,'no stack trace');
 }
});

test('npm start defaults: loopback, no login, no workspace, health endpoint',async t=>{
 const port=await freePort(),stateDir=await mkdtemp(path.join(tmpdir(),'mc-start-'));
 t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const run=await started(t,['server/main.mjs'],{PATH:process.env.PATH,HOME:process.env.HOME,MC_PORT:String(port),MC_STATE_DIR:stateDir},'Mission Control ready');
 assert.match(run.output(),new RegExp(`ready at http://127\\.0\\.0\\.1:${port} \\(listening on 127\\.0\\.0\\.1:${port}; sign-in: none\\)`));
 assert.match(run.errors(),/No workspace connected/);
 assert.equal(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text(),'ok\n');
 const status=await (await fetch(`http://localhost:${port}/api/status`)).json();
 assert.equal(status.access.mode,'none');assert.equal(status.sources.workspace.configured,false);
 assert.equal(typeof status.vm.memory.total,'number');
});
