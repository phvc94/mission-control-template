// Mission Control: path rules for the Markdown workspace.
import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import type { Link } from './shared.ts';
// Folder names exist in English and Portuguese (see layout.ts). Ideas are items with `type: idea` in the
// tasks folder or a step in a unit's state file; clients live in projects/<p>/clients/<c>/.
// Documents linked from tasks may be read from these roots, in either language.
export const readRoots = ['tasks', 'tarefas', 'projects', 'projetos', 'research', 'pesquisas', 'system', 'sistema'];
// From an agent's folder the dashboard reads only the state file: memory, persona and client conversations stay out.
export const agentState = (relative: string): boolean => /^(?:agents|agentes)\/[^/]+\/(?:STATE|ESTADO)\.md$/.test(relative);
export class AppError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 400, details?: unknown) { super(message); this.status = status; this.details = details; }
}
const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
export async function safePath(repo: string, relative: string, roots = readRoots, missing = false): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f]/.test(relative) || relative.split('/').some(x => x === '..' || x === '.' || !x)) throw new AppError('Path not allowed');
  if (relative.split('/').some(x => x.startsWith('.')) || !/\.(md|pdf|txt|html)$/i.test(relative)) throw new AppError('Document type not allowed');
  if (relative.split('/').some(x => /(?:^|[-_.])(?:env|credentials?|credenciais|secrets?|segredos|passwords?|senhas|private[-_]?key|auth[-_]?profiles|oauth)(?:[-_.]|$)/i.test(x))) throw new AppError('Credential files are not allowed', 403);
  // The agent exception holds only for document reads; writes always pass their own narrower roots.
  const allowed = roots.find(r => inside(relative, r)) ?? (roots === readRoots && agentState(relative) ? path.posix.dirname(relative) : undefined);
  if (!allowed) throw new AppError('Document outside the allowed folders');
  const root = await realpath(repo);
  const full = path.join(root, relative);
  // Refuse every symlink component, including aliases within an allowed root.
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try { if ((await lstat(current)).isSymbolicLink()) throw new AppError('Symbolic links are not allowed'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && missing && current === full) break; throw e; }
  }
  const canonicalParent = await realpath(path.dirname(full));
  if (!inside(canonicalParent, path.join(root, allowed))) throw new AppError('Path outside the root');
  if (!missing && !inside(await realpath(full), path.join(root, allowed))) throw new AppError('Path outside the root');
  return full;
}
export async function resolveLink(repo: string, target: string, label = target, source?: string): Promise<Link> {
  try {
    if (typeof target !== 'string' || !target || /[\x00-\x20\\]/.test(target.replaceAll(' ', ''))) throw new AppError('Invalid target');
    if (/^https?:\/\//i.test(target)) {
      const url = new URL(target);
      if (url.username || url.password) throw new AppError('Credentials in URLs are not allowed');
      return { label, target, href: url.href };
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) throw new AppError('Protocol or path not allowed');
    const decoded = decodeURIComponent(target.split('#')[0]);
    // Only links already in a Markdown body can resolve relative ../ segments.
    const relative = source && !readRoots.some(r => decoded.startsWith(r + '/')) && !agentState(decoded) ? path.posix.normalize(path.posix.join(path.posix.dirname(source), decoded)) : decoded;
    await safePath(repo, relative);
    return { label, target: relative, href: '/api/document?path=' + encodeURIComponent(relative) };
  } catch { return { label, target, blocked: 'Link unavailable or outside the allowed folders' }; }
}
