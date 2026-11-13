import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createMonitor,createServerMetrics,gitState} from '../server/monitor.mjs';
const run=promisify(execFile);

const at=offset=>new Date(Date.now()+offset).toISOString();
async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'mc-monitor-fixture-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const stateDir=path.join(directory,'state');
  await mkdir(stateDir);
  const write=(name,value)=>writeFile(path.join(stateDir,name),JSON.stringify(value));
  const metrics={snapshot:async()=>({collectedAt:new Date().toISOString(),cpuPercent:12,history:[],gateway:null,errors:[]})};
  return {directory,stateDir,write,monitor:createMonitor({stateDir,metrics})};
}

test('a missing file or invalid JSON never counts as a connected source',async t=>{
  const f=await fixture(t);
  let value=await f.monitor.snapshot();
  assert.equal(value.sources.checks.connected,false);assert.equal(value.sources.checks.configured,false);assert.equal(value.sources.checks.stale,true);
  assert.deepEqual(value.checks,{});assert.deepEqual(value.warnings,[]);
  await writeFile(path.join(f.stateDir,'checks.json'),'{corrupted');
  value=await f.monitor.snapshot();
  assert.equal(value.sources.checks.connected,false);assert.equal(value.sources.checks.configured,true);assert(value.sources.checks.error);
});

test('health check results older than two hours or with an invalid date are stale and raise nothing',async t=>{
  const f=await fixture(t);
  for(const date of [at(-7_200_100),'invalid',undefined,at(120_000)]) {
    await f.write('checks.json',{checked_at:date,checks:{disk:{status:'fail',message:'full'},reboot:{status:'warn'}}});
    const value=await f.monitor.snapshot();
    assert.equal(value.sources.checks.stale,true);assert.equal(value.sources.checks.connected,false);assert.equal(value.sources.checks.configured,true);
    assert.equal(value.incidents.length,0);assert.equal(value.warnings.length,0);
  }
});

test('fail then unknown does not resolve; a later ok resolves and keeps the history',async t=>{
  const f=await fixture(t),start=Date.now()-60_000;
  const report=(status,offset)=>f.write('checks.json',{checked_at:new Date(start+offset).toISOString(),checks:{gateway:{status,message:'Synthetic signal'}}});
  await report('fail',0);
  let value=await f.monitor.snapshot();
  assert.equal(value.incidents.length,1);const id=value.incidents[0].id;
  assert.equal(value.incidents[0].source,'health-checks');assert.equal(value.incidents[0].events[0].actor,'health-checks');
  await f.monitor.snapshot();
  await report('unknown',10_000);
  value=await f.monitor.snapshot();assert.equal(value.incidents[0].status,'open');assert.equal(value.incidents[0].events.length,1);
  await report('ok',20_000);
  value=await f.monitor.snapshot();assert.equal(value.incidents[0].id,id);assert.equal(value.incidents[0].status,'resolved');assert.equal(value.incidents[0].events.length,2);assert.match(value.incidents[0].events[1].evidence,/no fix is assumed/);
  await report('fail',30_000);
  value=await f.monitor.snapshot();assert.equal(value.incidents.length,2);assert.notEqual(value.incidents[0].id,id);assert.equal(value.incidents[1].status,'resolved');
  assert.equal(JSON.parse(await readFile(path.join(f.stateDir,'incidents.json'),'utf8')).length,2);
});

test('an older observation or a stale source neither resolves nor reopens an incident',async t=>{
  const f=await fixture(t);
  await f.write('checks.json',{checked_at:at(-60_000),checks:{gateway:{status:'fail'}}});
  await f.monitor.snapshot();
  await f.write('checks.json',{checked_at:at(-90_000),checks:{gateway:{status:'ok'}}});
  let value=await f.monitor.snapshot();assert.equal(value.incidents[0].status,'open');
  await f.write('checks.json',{checked_at:at(-8_000_000),checks:{gateway:{status:'ok'}}});
  value=await f.monitor.snapshot();assert.equal(value.incidents[0].status,'open');assert.equal(value.sources.checks.connected,false);assert.equal(value.sources.checks.stale,true);
});

test('an invalid history is kept on disk and asks for recovery',async t=>{
  const f=await fixture(t),file=path.join(f.stateDir,'incidents.json');
  await writeFile(file,'{incomplete history');
  await f.write('checks.json',{checked_at:at(-1000),checks:{gateway:{status:'fail'}}});
  const value=await f.monitor.snapshot();
  assert.equal(value.sources.incidents.connected,false);assert(value.sources.incidents.error);
  assert.equal(await readFile(file,'utf8'),'{incomplete history');
});

test('warn/unknown health checks become alerts with a stable key; fail stays an incident',async t=>{
  const f=await fixture(t);
  await f.write('checks.json',{checked_at:at(-1000),checks:{reboot:{status:'warn',message:'reboot pending',notify:true},'memory:atlas':{status:'warn',message:'waiting for indexing'},gateway:{status:'ok'},disk:{status:'fail',message:'full'}}});
  const value=await f.monitor.snapshot();
  assert.deepEqual(value.warnings.map(w=>[w.key,w.notify]),[['check:reboot',true],['check:memory:atlas',false]]);
  assert.equal(value.warnings[0].fingerprint,'warn|reboot pending');assert.equal(value.warnings[0].source,'health-checks');
  assert.equal(value.sources.checks.connected,true);
  assert.equal(value.incidents.length,1);assert.equal(value.incidents[0].checkId,'disk');
  await f.write('checks.json',{checked_at:at(-8_000_000),checks:{reboot:{status:'warn',message:'reboot pending'}}});
  assert.equal((await f.monitor.snapshot()).warnings.length,0,'late results produce no new alerts');
});

test('acknowledging an alert needs a reason and a fingerprint, survives on disk and can be undone',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.monitor.acknowledge({key:'check:reboot',fingerprint:'warn|x'},'user@example.test'),{status:400});
  await assert.rejects(f.monitor.acknowledge({key:'bad key',fingerprint:'warn|x',reason:'reason'},'user@example.test'),{status:400});
  await assert.rejects(f.monitor.acknowledge({key:'check:reboot',fingerprint:'warn|x',reason:'reason'}),{status:403});
  const ack=await f.monitor.acknowledge({key:'check:reboot',fingerprint:'warn|x',reason:'Restart scheduled for Saturday'},'user@example.test');
  assert.equal(ack.ack.actor,'user@example.test');
  let value=await f.monitor.snapshot();
  assert.deepEqual(value.acks.map(a=>[a.key,a.fingerprint,a.reason]),[['check:reboot','warn|x','Restart scheduled for Saturday']]);
  assert.equal(JSON.parse(await readFile(path.join(f.stateDir,'acks.json'),'utf8')).length,1);
  await f.monitor.acknowledge({key:'check:reboot',fingerprint:'warn|y',reason:'Changed'},'user@example.test');
  value=await f.monitor.snapshot();assert.equal(value.acks.length,1);assert.equal(value.acks[0].fingerprint,'warn|y');
  await f.monitor.unacknowledge({key:'check:reboot'},'user@example.test');
  await assert.rejects(f.monitor.unacknowledge({key:'check:reboot'},'user@example.test'),{status:404});
  assert.equal((await f.monitor.snapshot()).acks.length,0);
});

test('built-in server metrics: CPU, memory, load, uptime, disk, the dashboard process and a growing history',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mc-metrics-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const metrics=createServerMetrics({diskPath:path.join(directory,'not-created-yet'),intervalMs:3_600_000,historySize:2});
  t.after(()=>metrics.stop());
  let v=await metrics.snapshot();
  assert.ok(Number.isFinite(Date.parse(v.collectedAt)));assert.equal(typeof v.hostname,'string');assert.ok(v.cpus>=1);
  assert.ok(v.cpuPercent===null||(v.cpuPercent>=0&&v.cpuPercent<=100));
  assert.ok(v.memory.total>0&&v.memory.used>=0&&v.memory.available>=0);
  assert.ok(v.disk.total>0&&v.disk.available>=0&&v.disk.used>=0,'a folder not created yet is measured on its parent');
  assert.equal(v.load.length,3);assert.ok(v.uptime>0);
  assert.ok(v.process.rss>0&&v.process.heapUsed>0);
  assert.equal(v.gateway,null,'the gateway runs elsewhere: its memory and restarts are not available');
  assert.deepEqual(v.errors,[]);assert.equal(v.stale,false);assert.deepEqual(v.history,[]);
  for(let i=0;i<3;i++)metrics.sample();
  v=await metrics.snapshot();
  assert.equal(v.history.length,2,'history is capped');
  assert.deepEqual(Object.keys(v.history[0]).sort(),['at','cpuPercent','load','memoryUsed','processRss']);
});

test('a metrics failure is a disconnected source, not a crash',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mc-metrics-fail-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const value=await createMonitor({stateDir:directory,metrics:{snapshot:async()=>{throw new Error('fixture');}}}).snapshot();
  assert.equal(value.vm,null);assert.equal(value.sources.vm.connected,false);assert.equal(value.sources.vm.error,'Could not read the server metrics.');
});

test('Git/GitHub: not configured without a workspace or an upstream; commits ahead counted from the local clone',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mc-git-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const metrics={snapshot:async()=>({collectedAt:new Date().toISOString(),history:[],errors:[]})};
  let value=await createMonitor({stateDir:path.join(directory,'state'),metrics}).snapshot();
  assert.equal(value.sources.github.configured,false);assert.equal(value.sources.github.error,'No workspace connected.');assert.equal(value.vm.github,null);
  const repo=path.join(directory,'workspace'),remote=path.join(directory,'remote.git');
  await mkdir(repo);
  const git=(...args)=>run('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgSign=false','-c','core.hooksPath=/dev/null',...args],{cwd:repo});
  await git('init','-q','-b','main');await writeFile(path.join(repo,'a.md'),'a');await git('add','.');await git('commit','-q','-m','one');
  value=await createMonitor({stateDir:path.join(directory,'state'),workspaceDir:repo,metrics}).snapshot();
  assert.equal(value.sources.github.configured,false);assert.equal(value.sources.github.status,'not_configured');assert.equal(value.vm.github.branch,'main');
  await run('git',['init','-q','--bare','-b','main',remote]);await git('remote','add','origin',remote);await git('push','-q','-u','origin','main');
  await writeFile(path.join(repo,'b.md'),'b');await git('add','.');await git('commit','-q','-m','two');await writeFile(path.join(repo,'c.md'),'c');
  const state=await gitState(repo);
  assert.equal(state.aheadOfRemote,1);assert.equal(state.behindRemote,0);assert.equal(state.dirtyFiles,1);assert.equal(state.remote,'origin/main');
  value=await createMonitor({stateDir:path.join(directory,'state'),workspaceDir:repo,metrics}).snapshot();
  assert.equal(value.sources.github.connected,true);assert.equal(value.sources.github.configured,true);assert.equal(value.vm.github.aheadOfRemote,1);
  assert.deepEqual(await gitState(path.join(directory,'not-a-repo')),{error:'Could not query the workspace Git repository.'});
});
