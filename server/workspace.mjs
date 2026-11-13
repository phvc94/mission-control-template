import path from 'node:path';
import { constants } from 'node:fs';
import { readdir, readFile, lstat, realpath, mkdir, open, rename, unlink, rmdir, copyFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Repository } from './workspace-core/repository.ts';
import { resolveLayout, contentRoots, fieldAliases } from './workspace-core/layout.ts';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
// Top-level folders the library may read, with English and Portuguese names (see workspace-core/layout.ts).
const roots = contentRoots;
const extensions = new Set(['.md', '.txt', '.csv', '.json']);
const hidden = /^(?:node_modules|vendor|dist|build|backups?|credentials?|credenciais|secrets?|segredos|tokens?|auth|sessions?|sessoes|logs?)$/i;
const secretName = /(?:^|[-_.])(?:env|credentials?|credenciais|secrets?|segredos|tokens?|passwords?|senhas|private[-_]?key|auth[-_]?profiles|oauth)(?:[-_.]|$)/i;
const maxBytes = 2 * 1024 * 1024;
const repositoryURL = new URL('./workspace-core/repository.ts', import.meta.url).href;
const error = (message, status = 400, details) => Object.assign(new Error(message), { status, details });
const inside = (parent, target) => target === parent || target.startsWith(parent + path.sep);
const absent = e => e?.code === 'ENOENT';

function segments(relative, allowEmpty = false) {
  if (relative === '' && allowEmpty) return [];
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[\\\x00-\x1f]/.test(relative)) throw error('Path not allowed', 403);
  const pieces = relative.split('/');
  if (pieces.some(p => !p || p === '..' || p.startsWith('.') || hidden.test(p) || secretName.test(p))) throw error('Private file or path not allowed', 403);
  if (!roots.includes(pieces[0])) throw error('Document outside the workspace folders', 403);
  return pieces;
}

function credentialsIn(content, extension) {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content)) return true;
  if (/(?:^|\n)\s*(?:export\s+)?(?:[A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD|ACCESS_TOKEN|AUTH_TOKEN))\s*=\s*\S+/i.test(content)) return true;
  if (extension === '.json') {
    let data;
    try { data = JSON.parse(content); } catch { throw error('Invalid JSON; this file cannot be opened as a document', 422); }
    const privateField = /^(?:password|passwd|senha|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|api[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|credentials?|credenciais|authorization|cookie)$/i;
    const check = (value, depth = 0) => depth > 80 || (value && typeof value === 'object' && Object.entries(value).some(([key, child]) => privateField.test(key) || check(child, depth + 1)));
    if (check(data)) return true;
  }
  return false;
}

/** No content is embedded in the static app. All methods operate on demand at the authenticated server. */
export function createWorkspace({ root, stateDir, auditSink, layout = process.env.MC_WORKSPACE_LAYOUT || 'auto' }) {
  if (!root || !stateDir) throw error('root and stateDir are required');
  resolveLayout(path.resolve(root), layout); // Rejects an invalid MC_WORKSPACE_LAYOUT at startup.
  fieldAliases(); // Rejects an invalid MC_TASK_FIELD_ALIASES at startup.
  const configuredRoot = path.resolve(root), configuredState = path.resolve(stateDir);
  if (inside(configuredRoot, configuredState)) throw error('stateDir must be outside the versioned workspace');
  let queue = Promise.resolve();
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const ready = (async () => {
    const repo = await realpath(configuredRoot);
    await mkdir(configuredState, { recursive: true, mode: 0o700 });
    if ((await lstat(configuredState)).isSymbolicLink()) throw error('stateDir cannot be a symbolic link');
    const state = await realpath(configuredState);
    if (inside(repo, state)) throw error('stateDir must be outside the versioned workspace');
    return { repo, state };
  })();

  async function git(args, env = {}) {
    const { repo } = await ready;
    const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
      cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 8 * maxBytes,
    });
    return result.stdout.trimEnd();
  }

  async function resolve(relative, directory = false) {
    const pieces = segments(relative, directory);
    const { repo } = await ready;
    let current = repo;
    for (const piece of pieces) {
      current = path.join(current, piece);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw error('Symbolic links are not allowed', 403);
    }
    const stat = await lstat(current);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw error(directory ? 'Folder not found' : 'Document not found', 404);
    if (!inside(repo, await realpath(current))) throw error('Path outside the workspace', 403);
    if (!directory && !extensions.has(path.extname(relative).toLowerCase())) throw error('Document type not allowed', 403);
    return { full: current, stat };
  }

  async function document(relative) {
    const { full, stat } = await resolve(relative);
    if (stat.size > maxBytes) throw error('Document larger than 2 MB; use a file tool', 413);
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try { bytes = await file.readFile(); } finally { await file.close(); }
    if (bytes.length > maxBytes) throw error('Document larger than 2 MB', 413);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw error('Document is not UTF-8', 422); }
    if (content.includes('\0')) throw error('A binary file cannot be opened in the editor', 422);
    if (credentialsIn(content, path.extname(relative).toLowerCase())) throw error('The document contains credential fields and cannot be opened in the dashboard', 403);
    const { repo } = await ready;
    const owningRepo = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(full) }).then(r => realpath(r.stdout.trim())).catch(() => undefined);
    const tracked = owningRepo === repo && !!await git(['ls-files', '--error-unmatch', '--', relative]).catch(() => '');
    const editable = !!tracked;
    const editReason = editable ? undefined : owningRepo !== repo ? 'This document belongs to another repository; editing it from the dashboard is not connected yet.' : 'This document is not tracked in Git yet. Commit it before editing it in the dashboard.';
    return { path: relative, name: path.basename(relative), content, version: hash(bytes), modifiedAt: stat.mtime.toISOString(), editable, editReason };
  }

  async function audit(entry) {
    // Optional sink is a trusted server/test dependency, never supplied by HTTP callers.
    if (auditSink) return auditSink({ at: new Date().toISOString(), ...entry });
    const { state } = await ready;
    const file = await open(path.join(state, 'workspace-audit.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); await file.sync(); } finally { await file.close(); }
  }

  function identity(actor) {
    const label = typeof actor === 'string' ? actor : actor?.email || actor?.name || actor?.id;
    if (typeof label !== 'string' || !label.trim() || label.length > 200 || /[\x00-\x1f]/.test(label)) throw error('Missing authenticated identity', 403);
    // The HTTP layer supplies this value from verified authentication, never from the request body.
    return label;
  }

  async function gitIdentity() {
    const email = await git(['config', 'user.email']);
    if (!email || /[\x00-\x1f]/.test(email)) throw error("The workspace repository needs the owner's Git email (user.email) configured", 409);
    const configured = (await git(['config', 'user.name']).catch(() => '')).replace(/[\x00-\x1f]/g, '').trim().slice(0, 120);
    // MC_GIT_AUTHOR_NAME sets the author shown on commits made by the dashboard; default: the repository's user.name.
    const name = (process.env.MC_GIT_AUTHOR_NAME || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 120) || `${configured || 'Mission Control user'} (via Mission Control)`;
    return { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
  }

  async function backup(relative, content, id) {
    const { state } = await ready;
    const directory = path.join(state, 'document-backups');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw error('Invalid backup folder', 409);
    const name = `${id}.txt`, handle = await open(path.join(directory, name), 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    return name;
  }

  async function listFiles({ path: relative = '', query = '', limit = 200 } = {}) {
    segments(relative, true);
    if (typeof query !== 'string' || query.length > 200) throw error('Invalid search');
    limit = Math.max(1, Math.min(1000, Number.isInteger(limit) ? limit : 200));
    const files = [], directories = [], warnings = [];
    let scanned = 0, hasMore = false;
    const search = query.trim().toLocaleLowerCase();
    const sensitiveRequested = /^(?:agents|agentes)\/[^/]+(?:\/|$)/.test(relative);
    async function visit(dir, depth = 0) {
      if (depth > 12 || scanned > 5000 || files.length >= limit) { hasMore = true; return; }
      const { full } = await resolve(dir, true);
      for (const entry of (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        scanned++;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        try { segments(rel); } catch { continue; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth === 0) directories.push({ path: rel, name: entry.name });
          // Searches of the general library never enter agent folders (memories); search inside one by opening it.
          if (search && (sensitiveRequested || !/^(?:agents|agentes)(?:\/|$)/.test(rel))) await visit(rel, depth + 1);
        } else if (entry.isFile() && extensions.has(path.extname(rel).toLowerCase()) && (!search || rel.toLocaleLowerCase().includes(search))) {
          const { stat } = await resolve(rel);
          files.push({ path: rel, name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString(), type: path.extname(rel).slice(1).toLowerCase() });
        }
        if (scanned > 5000 || files.length >= limit) { hasMore = true; break; }
      }
    }
    try { await visit(relative); } catch (e) { if (absent(e)) throw error('Folder not found', 404); throw e; }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
    return { path: relative, query, files, directories, count: files.length, hasMore, warnings };
  }

  async function saveDocument(input, actor) {
    const who = identity(actor);
    if (!input || input.confirmed !== true) throw error('Confirm saving the document', 400);
    segments(input.path);
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > maxBytes || input.content.includes('\0')) throw error('Invalid content, or larger than 2 MB', 413);
    if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw error('Invalid document version');
    if (credentialsIn(input.content, path.extname(input.path || '').toLowerCase())) throw error('Do not save credentials in the workspace', 403);
    return serial(async () => {
      const id = randomUUID();
      const { repo } = await ready;
      const directory = await realpath(await git(['rev-parse', '--absolute-git-dir']));
      const lockPath = path.join(directory, 'index.lock'), indexPath = path.join(directory, 'index');
      const isolated = path.join(directory, `mission-control-index-${id}`);
      // Same marker/lock as the task UI: neither writer can continue after an uncertain write.
      const marker = path.join(directory, 'mission-control-pending.json');
      let lock, markerOwned = false, written = false, committed = false, temporary;
      try { lock = await open(lockPath, 'wx', 0o600); } catch { throw error('Git is busy. Wait and try again.', 409); }
      try {
        if (await readFile(marker, 'utf8').catch(e => { if (absent(e)) return null; throw e; })) throw error('A previous write needs recovery before continuing', 409);
        const before = await document(input.path);
        if (!before.editable) throw error(before.editReason, 409);
        if (before.version !== input.version) throw error('The document changed. Reload and review before saving; keep your draft.', 409);
        if (before.content === input.content) return before;
        if (await git(['status', '--porcelain=v1', '--untracked-files=all', '--', input.path])) throw error('This file has local changes that are not committed yet. Review them in Git before saving.', 409);
        const headContent = (await exec('git', ['show', `HEAD:${input.path}`], { cwd: repo, maxBuffer: 4 * maxBytes })).stdout;
        if (headContent !== before.content || !(await git(['ls-files', '-v', '--', input.path])).startsWith('H ')) throw error('The document differs from Git or has a special flag in the index', 409);
        const head = await git(['rev-parse', 'HEAD']), ref = await git(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
        if (!ref) throw error('The repository must be on a branch', 409);
        const actorEnv = await gitIdentity();
        const backupName = await backup(input.path, before.content, id);
        const afterVersion = hash(input.content);
        await audit({ id, action: 'document.save', phase: 'prepared', actor: who, path: input.path, before: before.version, after: afterVersion, backup: backupName });
        const record = await open(marker, 'wx', 0o600);
        try { await record.writeFile(JSON.stringify({ head, action: 'mission-control-document', id, paths: [{ path: input.path, before: before.version, after: afterVersion }], backup: backupName })); await record.sync(); } finally { await record.close(); }
        markerOwned = true;
        const target = await resolve(input.path);
        temporary = path.join(path.dirname(target.full), `.mission-control-${id}.tmp`);
        const file = await open(temporary, 'wx', target.stat.mode & 0o777);
        try { await file.writeFile(input.content); await file.sync(); } finally { await file.close(); }
        if ((await document(input.path)).version !== before.version) throw error('The document changed while saving. Nothing was overwritten.', 409);
        await rename(temporary, target.full); temporary = undefined; written = true;
        const parent = await open(path.dirname(target.full), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
        const env = { ...actorEnv, GIT_INDEX_FILE: isolated };
        await git(['read-tree', head], env);
        await git(['add', '--', input.path], env);
        const tree = await git(['write-tree'], env);
        await copyFile(indexPath, lockPath);
        const entry = await git(['ls-files', '--stage', '--', input.path], env);
        const match = /^(\d+) ([a-f0-9]+) 0\t(.+)$/.exec(entry);
        if (!match) throw error('Unexpected Git index', 500);
        await git(['update-index', '--add', '--cacheinfo', match[1], match[2], match[3]], { GIT_INDEX_FILE: lockPath });
        if ((await document(input.path)).version !== afterVersion) throw error('The document changed before the commit; recovery required', 409);
        const commit = await git(['commit-tree', tree, '-p', head, '-m', `mission-control: edit ${input.path}\n\nMission-Control-Action: document.save\nMission-Control-Event: ${id}\n`], actorEnv);
        await git(['update-ref', '-m', 'mission-control: document', ref, commit, head]); committed = true;
        await rename(lockPath, indexPath);
        let auditWarning;
        try { await audit({ id, action: 'document.save', phase: 'committed', actor: who, path: input.path, commit, before: before.version, after: afterVersion, backup: backupName }); }
        catch { auditWarning = 'File saved and commit confirmed; the additional audit record could not be completed. Do not repeat the save.'; }
        await unlink(marker); markerOwned = false;
        return { ...await document(input.path), commit, auditId: id, saved: true, ...(auditWarning ? { auditWarning } : {}) };
      } catch (e) {
        await audit({ id, action: 'document.save', phase: written ? 'recovery-required' : 'rejected', actor: who, path: input.path, written, committed, status: e.status || 500 }).catch(() => {});
        if (written) throw error('The save needs checking. Do not repeat the action; there is a backup and a recovery record.', 500, { written, committed, auditId: id });
        throw e;
      } finally {
        await lock.close();
        for (const name of [lockPath, lockPath + '.lock', isolated, temporary]) if (name) await unlink(name).catch(() => {});
        if (markerOwned && !written) await unlink(marker).catch(() => {});
      }
    });
  }

  async function mutate(input, actor) {
    const who = identity(actor);
    if (!input || typeof input !== 'object' || !['complete', 'reopen', 'assign', 'document', 'priorities', 'split', 'delete', 'create'].includes(input.action) || typeof input.version !== 'string') throw error('Invalid task action');
    return serial(async () => {
      const { repo } = await ready, id = randomUUID();
      await audit({ id, action: 'task.' + String(input?.action || 'invalid'), phase: 'requested', actor: who });
      // Separate process prevents identity leaking into a simultaneous writer's environment.
      const code = `import { Repository } from ${JSON.stringify(repositoryURL)}; let raw=''; for await (const chunk of process.stdin) raw+=chunk; try { const result=await new Repository(process.argv[1]).mutate(JSON.parse(raw)); process.stdout.write(JSON.stringify({result})); } catch(e) { process.stdout.write(JSON.stringify({error:{message:e.message,status:e.status||500,details:e.details}})); process.exitCode=1; }`;
      let committedResult;
      try {
        const actorEnv = await gitIdentity();
        const result = await new Promise((resolveResult, reject) => {
          const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, repo], { env: { ...process.env, ...actorEnv, MC_WORKSPACE_LAYOUT: layout }, stdio: ['pipe', 'pipe', 'pipe'] });
          let output = '';
          child.on('error', reject);
          child.stdin.on('error', reject);
          child.stdout.on('data', chunk => { output += chunk; if (output.length > 1_000_000) child.kill(); });
          child.stderr.resume(); // Runtime diagnostics never include task/document content in the HTTP response.
          child.on('close', () => {
            try {
              const response = JSON.parse(output);
              if (response.error) reject(error(response.error.message, response.error.status, response.error.details));
              else if (response.result?.commit) resolveResult(response.result);
              else reject(error('Invalid response from the task writer', 500));
            } catch { reject(error('Task writer interrupted; check the record before repeating', 500, { recoveryRequired: true })); }
          });
          child.stdin.end(JSON.stringify(input));
        });
        committedResult = result;
        await audit({ id, action: 'task.' + input.action, phase: 'committed', actor: who, commit: result.commit, ids: result.ids });
        return { ...result, auditId: id };
      } catch (e) {
        await audit({ id, action: 'task.' + String(input?.action || 'invalid'), phase: committedResult ? 'audit-recovery-required' : 'rejected', actor: who, status: e.status || 500, commit: committedResult?.commit }).catch(() => {});
        if (committedResult) return { ...committedResult, committed: true, auditId: id, auditWarning: 'Task saved and commit confirmed; the additional audit record could not be completed. Do not repeat the action.' };
        throw e;
      }
    });
  }

  /** Latest workspace commits, metadata only: who recorded it, when, and the subject. Never the diff. */
  async function recentCommits(limit = 40) {
    limit = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 40));
    const raw = await git(['log', `-n${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s%x1e']).catch(() => '');
    return raw.split('\x1e').map(line => line.trim()).filter(Boolean).map(line => {
      const [hash, author, at, subject] = line.split('\x1f');
      // Commits from automatic sync jobs are marked as routine so the timeline can hide them.
      const routine = /^(auto[- ]?sync|automatic sync|sync automatico)\b/i.test(subject || '');
      return { hash: String(hash || '').slice(0, 12), author: String(author || '').slice(0, 120), at, subject: String(subject || '').replace(/[\x00-\x1f]/g, ' ').slice(0, 200), routine };
    });
  }

  const uploadName = /^[\p{L}\p{N}][\p{L}\p{N} _.()+,'-]{0,118}$/u;
  // `temporario` (temporary) is the default: a hidden folder outside Git and backups, swept after 3 days.
  // Keeping a file in the agent's folder (`anexos`, attachments) is an explicit choice of the person sending it.
  // The ids temporario/anexos are API values; the folders follow the workspace layout.
  const currentLayout = async () => resolveLayout((await ready).repo, layout);
  const uploadDestinations = {
    temporario: agentId => `.tmp/anexos/${agentId}/${new Date().toISOString().slice(0, 10)}`,
    anexos: (agentId, l) => `${l.agents}/${agentId}/${l.attachments}/${new Date().toISOString().slice(0, 10)}`,
  };
  const TEMP_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
  /** Deletes temporary attachments older than 3 days and the empty folders left behind. Never touches anything else. */
  async function sweepUploads(maxAgeMs = TEMP_RETENTION_MS, nowMs = Date.now()) {
    const { repo } = await ready;
    const base = path.join(repo, '.tmp', 'anexos');
    let removed = 0;
    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (absent(e)) return 0; throw e; }
      let kept = 0;
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) { kept++; continue; }
        if (entry.isDirectory()) { kept += await walk(full); continue; }
        const stat = await lstat(full);
        if (nowMs - stat.mtimeMs > maxAgeMs) { await unlink(full); removed++; } else kept++;
      }
      if (!kept && dir !== base) await rmdir(dir).catch(() => {});
      return kept;
    }
    await walk(base);
    return { removed };
  }
  /**
   * Stores a file sent from the dashboard for an agent to read. `anexos` (attachments) stays out of Git (.gitignore).
   * The path returned in `gatewayPath` is the one the agent sees inside the OpenClaw container.
   */
  async function storeUpload({ agentId, destination = 'temporario', name, mimeType, stream, maxBytes: limit = 64 * 1024 * 1024 }, actor) {
    const who = identity(actor);
    if (typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(agentId)) throw error('Invalid agent', 400);
    if (!Object.hasOwn(uploadDestinations, destination)) throw error('Invalid file destination', 400);
    const base = path.basename(String(name || '')).normalize('NFC').replace(/[\x00-\x1f]/g, '').trim();
    if (!uploadName.test(base) || base.startsWith('.') || secretName.test(base) || /\.(env|pem|key|p12|pfx|token|sops)$/i.test(base)) throw error('File name not allowed. Use letters, numbers, spaces, dots, hyphens and underscores, with no credential extension.', 400);
    const { repo } = await ready;
    const directory = uploadDestinations[destination](agentId, await currentLayout());
    const full = path.join(repo, directory);
    if (!inside(repo, full)) throw error('Destination outside the workspace', 403);
    await mkdir(full, { recursive: true, mode: 0o750 });
    if ((await lstat(full)).isSymbolicLink()) throw error('The destination cannot be a symbolic link', 409);
    const extension = path.extname(base), stem = base.slice(0, base.length - extension.length);
    let candidate = base, counter = 2;
    while (await lstat(path.join(full, candidate)).then(() => true, e => { if (absent(e)) return false; throw e; })) candidate = `${stem}-${counter++}${extension}`;
    const target = path.join(full, candidate), temporary = path.join(full, `.upload-${randomUUID()}.tmp`);
    let bytes = 0;
    const handle = await open(temporary, 'wx', 0o640);
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > limit) throw error(`File larger than ${Math.round(limit / 1048576)} MB`, 413);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (e) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw e; }
    await handle.close();
    if (!bytes) { await unlink(temporary).catch(() => {}); throw error('Empty file', 400); }
    await rename(temporary, target);
    const relative = `${directory}/${candidate}`;
    const record = { id: randomUUID(), path: relative, gatewayPath: path.posix.join(process.env.MC_GATEWAY_WORKSPACE || '/workspace', relative), name: candidate, size: bytes, mimeType: typeof mimeType === 'string' ? mimeType.slice(0, 120) : 'application/octet-stream', agentId, destination, temporary: destination === 'temporario', expiresAt: destination === 'temporario' ? new Date(Date.now() + TEMP_RETENTION_MS).toISOString() : null, actor: who, at: new Date().toISOString() };
    await audit({ id: record.id, action: 'upload.store', actor: who, path: relative, bytes, destination, agentId });
    return record;
  }

  return {
    // gatewayWorkspace: where agents see this workspace, so the interface can give them absolute paths.
    snapshot: async () => { const { repo } = await ready; return { ...await new Repository(repo, undefined, resolveLayout(repo, layout)).snapshot(), gatewayWorkspace: process.env.MC_GATEWAY_WORKSPACE || '/workspace' }; },
    mutate, listFiles, recentCommits, storeUpload, sweepUploads,
    readDocument: async relative => { try { return await document(relative); } catch (e) { if (absent(e)) throw error('Document not found', 404); throw e; } },
    saveDocument,
  };
}

const NO_WORKSPACE = 'No workspace connected. Set MC_WORKSPACE to a Markdown/Git folder to see tasks, projects and documents.';
/**
 * Stand-in used when MC_WORKSPACE is not set: the dashboard still shows agents, sessions, routines and the
 * server; reads come back empty and every write is refused with the same explanation.
 */
export function createMissingWorkspace() {
  const refuse = async () => { throw error(NO_WORKSPACE, 409); };
  return {
    configured: false,
    snapshot: async () => ({ items: [], projects: [], priorities: { ids: [], version: '' }, warnings: [], generalProjects: [], configured: false, today: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }),
    listFiles: async ({ path: relative = '', query = '' } = {}) => ({ path: relative, query, files: [], directories: [], count: 0, hasMore: false, warnings: [], configured: false }),
    readDocument: refuse, saveDocument: refuse, mutate: refuse, storeUpload: refuse,
    recentCommits: async () => [], sweepUploads: async () => ({ removed: 0 }),
  };
}
