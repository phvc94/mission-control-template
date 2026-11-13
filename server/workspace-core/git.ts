// Mission Control: atomic Git transactions for task files written by the dashboard.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, writeFile, rename, unlink, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, safePath } from './paths.ts';
import { hash } from './markdown.ts';
const exec = promisify(execFile);
export async function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trimEnd();
}
export async function gitDir(repo: string): Promise<string> { return realpath(await git(repo, ['rev-parse', '--absolute-git-dir'])); }
/** `after: null` deletes the file; `before: null` creates it. */
export interface Change { path: string; before: string | null; after: string | null }
export async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.mission-control-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}
export async function assertClean(repo: string, changes: Change[], roots: string[] = ['tasks']): Promise<void> {
  for (const change of changes) {
    const full = await safePath(repo, change.path, roots, change.before === null);
    const current = await readFile(full, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (current !== change.before) throw new AppError('The file changed. Reload; your proposal is still in the form.', 409);
    if (await git(repo, ['status', '--porcelain=v1', '--untracked-files=all', '--', change.path])) throw new AppError('This file has local changes. Commit or stash them in Git, then reload.', 409);
    // Compare bytes to HEAD too, bypassing assume-unchanged / skip-worktree flags.
    if (current !== null) {
      const head = (await exec('git', ['show', `HEAD:${change.path}`], { cwd: repo, maxBuffer: 8 * 1024 * 1024 })).stdout;
      if (head !== current) throw new AppError('The file differs from Git. Review it before editing.', 409);
      const flags = await git(repo, ['ls-files', '-v', '--', change.path]);
      if (!flags.startsWith('H ')) throw new AppError('This file has a special flag in the Git index; check it in a terminal.', 409);
    }
  }
}
export interface TransactionHooks { beforeWrite?: (index: number) => Promise<void>; beforeCommit?: () => Promise<void> }
/** `roots`: the only top-level folders this transaction may write (the tasks folder of the workspace layout). */
export async function transaction(repo: string, changes: Change[], action: string, ids: string[], hooks: TransactionHooks = {}, roots: string[] = ['tasks']): Promise<string> {
  const directory = await gitDir(repo);
  const marker = path.join(directory, 'mission-control-pending.json');
  const lockPath = path.join(directory, 'index.lock');
  const indexPath = path.join(directory, 'index');
  const isolated = path.join(directory, `mission-control-index-${randomUUID()}`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new AppError('Git is busy. Wait for the other operation and try again.', 409); }
  let wrote = false;
  let committed = false;
  let markerOwned = false;
  const written: Change[] = [];
  try {
    const pending = await readFile(marker, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (pending) throw new AppError('A previous action needs recovery. See "Recovery" in docs/INSTALL.md (mission-control-pending.json).', 409);
    await assertClean(repo, changes, roots);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const ref = await git(repo, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    if (!ref) throw new AppError('Use a Git branch, not a detached HEAD.', 409);
    await writeFile(marker, JSON.stringify({ head, action, ids, paths: changes.map(c => ({ path: c.path, before: c.before === null ? null : hash(c.before), after: c.after === null ? null : hash(c.after) })) }), { flag: 'wx', mode: 0o600 });
    markerOwned = true;
    try {
      for (let i = 0; i < changes.length; i++) {
        await hooks.beforeWrite?.(i);
        const change = changes[i];
        await assertClean(repo, [change], roots);
        const file = await safePath(repo, change.path, roots, change.before === null);
        written.push(change);
        if (change.after === null) await unlink(file); else await atomicWrite(file, change.after);
      }
      wrote = true;
    } catch (error) {
      for (const change of written.reverse()) {
        const file = await safePath(repo, change.path, roots, change.before === null || change.after === null);
        const current = await readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
        if (current === change.before) continue;
        // The file must be exactly as this write left it; absent, for a deletion.
        const asWritten = change.after === null ? current === null : current !== null && hash(current) === hash(change.after);
        if (!asWritten) throw new AppError('Write interrupted and the file was changed by another process. Manual recovery required.', 500);
        if (change.before === null) await unlink(file); else await atomicWrite(file, change.before);
      }
      await unlink(marker); markerOwned = false;
      throw error;
    }
    // A private index starts from HEAD: staged work belonging to others never enters this commit.
    const env = { GIT_INDEX_FILE: isolated };
    await git(repo, ['read-tree', head], env);
    await git(repo, ['add', '--', ...changes.map(c => c.path)], env);
    const tree = await git(repo, ['write-tree'], env);
    await hooks.beforeCommit?.();
    // Prepare replacement real index while retaining every unrelated staged entry.
    await copyFile(indexPath, lockPath);
    const entries = await git(repo, ['ls-files', '--stage', '--', ...changes.map(c => c.path)], env);
    for (const entry of entries.split('\n').filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) 0\t(.+)$/.exec(entry);
      if (!match) throw new Error('Unexpected index');
      await git(repo, ['update-index', '--add', '--cacheinfo', match[1], match[2], match[3]], { GIT_INDEX_FILE: lockPath });
    }
    // A deletion does not show up in ls-files: it must be removed from the replacement index explicitly.
    for (const change of changes) if (change.after === null) await git(repo, ['update-index', '--force-remove', '--', change.path], { GIT_INDEX_FILE: lockPath });
    // Catch concurrent external writers before recording the snapshot.
    for (const change of changes) {
      const current = await readFile(await safePath(repo, change.path, roots, change.after === null), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
      const asWritten = change.after === null ? current === null : current !== null && hash(current) === hash(change.after);
      if (!asWritten) throw new AppError('The file changed during the commit; manual recovery required.', 409);
    }
    const message = `mission-control: task ${action}\n\nMission-Control-Action: task.${action}\nMission-Control-IDs: ${ids.join(',')}\n`;
    const commit = await git(repo, ['-c', 'user.name=Mission Control', 'commit-tree', tree, '-p', head, '-m', message]);
    await git(repo, ['update-ref', '-m', `mission-control: ${action}`, ref, commit, head]);
    committed = true;
    await rename(lockPath, indexPath);
    await unlink(marker); markerOwned = false;
    return commit;
  } catch (error) {
    if (wrote) throw new AppError(committed ? 'Commit created, but finalizing the index failed. Do not repeat the action; follow "Recovery" in docs/INSTALL.md.' : 'Files written, but the commit failed. Do not repeat the action; follow "Recovery" in docs/INSTALL.md.', 500, { written: true, committed, paths: changes.map(c => c.path), action, ids });
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
    await unlink(lockPath + '.lock').catch(() => {});
    await unlink(isolated).catch(() => {});
    // Marker deliberately survives uncertain failures: subsequent writes are blocked.
    if (!wrote && markerOwned && written.length === 0) await unlink(marker).catch(() => {});
  }
}
