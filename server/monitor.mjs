import { readFile, open, rename, mkdir, unlink, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const stale = (at, ttl) => {
  const age = Date.now() - Date.parse(at);
  return !Number.isFinite(age) || age < -60_000 || age > ttl;
};
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const ACK_KEY = /^[a-z]+:[^\s\u0000-\u001f]{1,300}$/;
// Source and actor recorded on alerts and incidents created from health check results.
const SOURCE = 'health-checks';
const run = promisify(execFile);
const round = (value, digits = 1) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const RESOLUTION_MS = 10;
// The histogram records the whole timer period; the delay is what exceeds the sampling resolution.
const ms = ns => Number.isFinite(ns) && ns > 0 ? round(Math.max(0, ns / 1e6 - RESOLUTION_MS), 2) : null;

function cpuTimes() {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) { const t = cpu.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
  return { idle, total };
}
const cpuPercent = (from, to) => to.total > from.total ? round(100 * (1 - (to.idle - from.idle) / (to.total - from.total))) : null;

/** How far the workspace clone is from its upstream, read locally (no fetch): the upstream ref is kept current by whatever pushes the workspace. */
export async function gitState(dir, { timeout = 10_000 } = {}) {
  const git = async (...args) => (await run('git', ['--no-optional-locks', '-C', dir, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  let branch;
  try { branch = await git('rev-parse', '--abbrev-ref', 'HEAD'); }
  catch { return { error: 'Could not query the workspace Git repository.' }; }
  let upstream = null;
  if (branch !== 'HEAD') upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}').catch(() => null);
  if (!upstream) return { branch, configured: false, error: 'The current branch does not track a remote.' };
  try {
    const [ahead, behind, remoteAt, localAt, status] = await Promise.all([
      git('rev-list', '--count', '@{upstream}..HEAD'), git('rev-list', '--count', 'HEAD..@{upstream}'),
      git('log', '-1', '--format=%cI', '@{upstream}'), git('log', '-1', '--format=%cI', 'HEAD'),
      git('status', '--porcelain=v1', '--untracked-files=normal'),
    ]);
    return { branch, remote: upstream, aheadOfRemote: Number(ahead), behindRemote: Number(behind), remoteAt, lastLocalCommitAt: localAt, dirtyFiles: status.split('\n').filter(line => line.trim()).length };
  } catch { return { branch, error: 'Could not query the workspace Git repository.' }; }
}

/**
 * Server metrics sampled inside the dashboard process: CPU, memory, load, uptime, disk of diskPath, and the
 * dashboard's own memory and event-loop delay. One point per interval is kept in memory for the charts
 * (24 hours at the default interval); the history starts again when the process restarts.
 */
export function createServerMetrics({ diskPath, intervalMs = 60_000, historySize = 1440, now = Date.now } = {}) {
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  delay.enable();
  let last = cpuTimes(), lastCpu = null, lastDelay = null;
  const history = [];
  function delayNow() {
    const value = { meanMs: ms(delay.mean), p99Ms: ms(delay.percentile(99)), maxMs: ms(delay.max) };
    return value.maxMs == null ? null : value;
  }
  function sample() {
    const current = cpuTimes();
    lastCpu = cpuPercent(last, current); last = current;
    lastDelay = delayNow() || lastDelay; delay.reset();
    const memory = os.totalmem() - os.freemem();
    history.push({ at: new Date(now()).toISOString(), cpuPercent: lastCpu, memoryUsed: memory, load: round(os.loadavg()[0], 2), processRss: process.memoryUsage.rss() });
    if (history.length > historySize) history.splice(0, history.length - historySize);
  }
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  async function snapshot() {
    const errors = [];
    let disk = null;
    if (diskPath) {
      // A state folder not created yet is measured on the nearest existing parent: same disk.
      for (let dir = path.resolve(diskPath); ; dir = path.dirname(dir)) {
        try { const fs = await statfs(dir); disk = { total: fs.blocks * fs.bsize, available: fs.bavail * fs.bsize, used: (fs.blocks - fs.bfree) * fs.bsize }; break; }
        catch (e) { if (e.code !== 'ENOENT' || dir === path.dirname(dir)) { errors.push('Could not read the disk usage.'); break; } }
      }
    }
    const total = os.totalmem(), available = os.freemem(), memory = process.memoryUsage();
    return {
      collectedAt: new Date(now()).toISOString(), hostname: os.hostname(), platform: `${os.type()} ${os.arch()}`,
      cpus: os.availableParallelism?.() ?? os.cpus().length,
      // Until the first interval closes, CPU is measured since the dashboard started.
      cpuPercent: lastCpu ?? cpuPercent(last, cpuTimes()),
      memory: { total, available, used: total - available }, disk,
      load: os.loadavg().map(v => round(v, 2)), uptime: round(os.uptime(), 0),
      process: { rss: memory.rss, heapUsed: memory.heapUsed, uptime: round(process.uptime(), 0), eventLoopDelay: lastDelay || delayNow() },
      // The OpenClaw gateway runs elsewhere (another container or machine): its memory and restarts are not measurable here.
      gateway: null, errors, history: history.slice(), stale: false,
    };
  }
  return { snapshot, sample, stop() { clearInterval(timer); delay.disable(); } };
}

/**
 * metrics: something with snapshot() returning the server measurements (createServerMetrics by default; the demo
 * passes synthetic numbers). workspaceDir: the workspace clone, for the Git/GitHub card; null when there is none.
 * checks.json (optional health checks, format in docs/INSTALL.md) is read from stateDir.
 */
export function createMonitor({stateDir, workspaceDir = null, metrics = createServerMetrics({ diskPath: workspaceDir || stateDir }), gitTtlMs = 60_000, git = gitState}) {
  let gitCache = null;
  async function github() {
    if (!workspaceDir) return null;
    if (!gitCache || Date.now() - gitCache.at > gitTtlMs) gitCache = { at: Date.now(), value: git(workspaceDir).catch(() => ({ error: 'Could not query the workspace Git repository.' })) };
    return gitCache.value;
  }
  let pending;
  let ackQueue = Promise.resolve();
  async function json(file, fallback) {
    try { return {value:JSON.parse(await readFile(file,'utf8')),error:null}; }
    catch(e) { return {value:fallback,error:e.code==='ENOENT'?null:'Could not read the collected data or the saved history.'}; }
  }
  async function save(file,value) {
    await mkdir(stateDir,{recursive:true,mode:0o700});
    const temporary=file+'.'+randomUUID()+'.tmp';
    try {
      const handle=await open(temporary,'wx',0o600);
      try {await handle.writeFile(JSON.stringify(value));await handle.sync();} finally {await handle.close();}
      await rename(temporary,file);
    } finally {await unlink(temporary).catch(()=>{});}
  }
  const acksFile = () => path.join(stateDir,'acks.json');
  async function readAcks() {
    const read = await json(acksFile(), []);
    const valid = Array.isArray(read.value) ? read.value.filter(a => record(a) && typeof a.key === 'string' && typeof a.fingerprint === 'string') : [];
    return { acks: valid, error: read.error || (Array.isArray(read.value) ? null : 'The acknowledged alerts file is invalid; keep the file for recovery.') };
  }
  /** Acknowledge an alert: it leaves the top of the page for as long as its fingerprint (count, message) stays the same. */
  async function acknowledge({ key, fingerprint, reason } = {}, actor) {
    if (typeof key !== 'string' || !ACK_KEY.test(key)) throw new AppError('Invalid alert identifier.', 400);
    if (typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > 300) throw new AppError('The alert needs a fingerprint to be acknowledged.', 400);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new AppError('Explain in one sentence why this alert can leave the top of the page.', 400);
    if (typeof actor !== 'string' || !actor) throw new AppError('Authenticated identity missing.', 403);
    const task = ackQueue.then(async () => {
      const { acks, error } = await readAcks();
      if (error) throw new AppError(error, 409);
      const entry = { key, fingerprint, reason: text(reason.trim(), 500), actor, at: new Date().toISOString() };
      const next = [...acks.filter(a => a.key !== key), entry];
      await save(acksFile(), next);
      return { ok: true, ack: entry };
    });
    ackQueue = task.catch(() => {});
    return task;
  }
  async function unacknowledge({ key } = {}, actor) {
    if (typeof key !== 'string' || !ACK_KEY.test(key)) throw new AppError('Invalid alert identifier.', 400);
    if (typeof actor !== 'string' || !actor) throw new AppError('Authenticated identity missing.', 403);
    const task = ackQueue.then(async () => {
      const { acks, error } = await readAcks();
      if (error) throw new AppError(error, 409);
      const next = acks.filter(a => a.key !== key);
      if (next.length === acks.length) throw new AppError('This alert was not acknowledged.', 404);
      await save(acksFile(), next);
      return { ok: true, key };
    });
    ackQueue = task.catch(() => {});
    return task;
  }
  async function snapshot() {
    let vm=null,vmError=null;
    try { vm=await metrics.snapshot(); } catch { vmError='Could not read the server metrics.'; }
    if(vm) vm.github=await github();
    // Health checks (optional): any job may write checks.json to the state directory, in the format described in docs/INSTALL.md.
    const reportRead=await json(path.join(stateDir,'checks.json'),null);
    const report=record(reportRead.value)?reportRead.value:null;
    const reportStale=!report||stale(report.checked_at,7_200_000);
    const checks=record(report?.checks)?report.checks:{};
    const file=path.join(stateDir,'incidents.json');
    const incidentsRead=await json(file,[]);
    const validIncidents=Array.isArray(incidentsRead.value)&&incidentsRead.value.every(x=>record(x)&&Array.isArray(x.events));
    const incidents=validIncidents?incidentsRead.value:[];
    const incidentsError=incidentsRead.error||(!validIncidents?'The incident history is invalid; keep the file for recovery.':null);
    let changed=false;
    if(!reportStale&&!incidentsError) {
      for(const [id,check] of Object.entries(checks)) {
        if(!record(check)) continue;
        const related=incidents.filter(x=>x.checkId===id);
        const latest=Math.max(0,...related.flatMap(x=>[x.lastObservedAt,x.resolvedAt,x.openedAt].map(at=>Date.parse(at)||0)));
        // A copied older observation cannot close/reopen an incident.
        if(Date.parse(report.checked_at)<=latest) continue;
        const current=related.find(x=>x.status==='open');
        const bad=['fail','error','critical'].includes(check.status);
        if(bad&&!current) {
          incidents.unshift({id:randomUUID(),checkId:id,title:typeof check.message==='string'?check.message:id,severity:'high',status:'open',openedAt:report.checked_at,lastObservedAt:report.checked_at,source:SOURCE,events:[{at:report.checked_at,actor:SOURCE,action:'Failure observed',evidence:typeof check.message==='string'?check.message:id}]});
          changed=true;
        } else if(current) {
          current.lastObservedAt=report.checked_at;changed=true;
          if(check.status==='ok') {
            current.status='resolved';current.resolvedAt=report.checked_at;
            current.events.push({at:report.checked_at,actor:SOURCE,action:'Recovery observed',evidence:'A later check returned ok; no fix is assumed.'});
          }
          // Unknown/skipped/warning are not evidence of recovery.
        }
      }
      if(changed) await save(file,incidents);
    }
    // Checks that do not become incidents (warn/unknown/skipped) are shown as alerts instead of staying invisible.
    const warnings=reportStale?[]:Object.entries(checks).filter(([,c])=>record(c)&&typeof c.status==='string'&&!['ok','fail','error','critical'].includes(c.status)).map(([id,c])=>({
      key:'check:'+id,fingerprint:`${c.status}|${text(c.message,300)}`,checkId:id,status:c.status,
      message:text(c.message,300)||id,notify:c.notify===true,observedAt:report.checked_at,source:SOURCE,
    }));
    const acksRead=await readAcks();
    // Git/GitHub: read from the workspace's local clone. "Not configured" without a workspace or an upstream branch.
    const gh=record(vm?.github)?vm.github:null;
    const ghConfigured=!!workspaceDir&&gh?.configured!==false;
    return {vm,incidents,warnings,acks:acksRead.acks,sources:{
      vm:{connected:!!vm,collectedAt:vm?.collectedAt,error:vmError||vm?.errors?.[0]||null},
      checks:{connected:!!report&&!reportStale,configured:!!report||!!reportRead.error,collectedAt:report?.checked_at,stale:reportStale,error:reportRead.error||(!report?'No health check results yet.':reportStale?'The latest health check results are more than two hours old.':null)},
      incidents:{connected:!incidentsError,error:incidentsError},
      acks:{connected:!acksRead.error,error:acksRead.error},
      github:{connected:!!gh&&gh.error==null,configured:ghConfigured,...(ghConfigured?{}:{status:'not_configured'}),collectedAt:vm?.collectedAt,error:!workspaceDir?'No workspace connected.':!gh?'Could not query the workspace Git repository.':gh.error||null},
    },checks};
  }
  return {snapshot(){if(!pending)pending=snapshot().finally(()=>{pending=null});return pending;},acknowledge,unacknowledge};
}
