// Mission Control: tasks, priorities and units of the Markdown workspace.
// Folder names follow the workspace layout (English or Portuguese, see layout.ts). Fields are exposed with the
// canonical keys and values; files are written in their own language (new files in the layout's language).
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { hash, today, parseMarkdown, patchMarkdown, newMarkdown, unitContext, sectionExcerpt } from './markdown.ts';
import { safePath, resolveLink, AppError } from './paths.ts';
import { resolveLayout, stateFiles, legacyNextFiles, toCanonical, forFile, fileLang, fileText, type Layout } from './layout.ts';
import { transaction, type Change, type TransactionHooks } from './git.ts';
import { str, type Item, type Snapshot, type Mutation, type ChildInput, type CreateInput, type Fields, type Project, type UnitKind } from './shared.ts';
const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');
const idValid = (s: unknown): s is string => typeof s === 'string' && /^[\p{L}\p{N}_-]{1,180}$/u.test(s);
const textValid = (s: unknown, max = 500): s is string => typeof s === 'string' && s.length <= max && !/[\x00-\x1f]/.test(s);
const multilineValid = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s);
const list = (s: unknown): string[] => Array.isArray(s) && s.every(x => typeof x === 'string') ? s : [];
const slugOf = (title: string, fallback: string): string => title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 95) || fallback;
export class Repository {
  root: string;
  layout: Layout;
  generalProjects: string[];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string, generalProjects?: string[], layout?: Layout) {
    this.root = path.resolve(root);
    this.layout = layout ?? resolveLayout(this.root);
    this.generalProjects = generalProjects ?? [this.layout.system];
  }
  get taskRoot(): string { return this.layout.tasks; }
  get priorityPath(): string { return this.layout.priorities; }
  async raw(relative: string): Promise<string> { return readFile(await safePath(this.root, relative), 'utf8'); }
  async priorities(): Promise<{ ids: string[]; version: string }> {
    try {
      const raw = await this.raw(this.priorityPath);
      const data = parseMarkdown(raw).fields;
      if (!Array.isArray(data.ids) || !data.ids.every(idValid) || new Set(data.ids).size !== data.ids.length) throw new AppError('Invalid priority index; check the file.', 409);
      return { ids: data.ids, version: hash(raw) };
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ids: [], version: 'missing' }; throw e; }
  }
  async snapshot(): Promise<Snapshot> {
    const items: Item[] = [], warnings: string[] = [];
    for (const name of (await this.entries(this.taskRoot)).map(e => e.name).sort()) {
      if (!name.endsWith('.md') || name.startsWith('_') || name.startsWith('.')) continue;
      const relative = `${this.taskRoot}/${name}`;
      try {
        const raw = await this.raw(relative), parsed = parseMarkdown(raw), fields = toCanonical(parsed.fields), body = parsed.body;
        if (!idValid(fields.id) || !textValid(fields.titulo) || !fields.titulo) throw new Error('Invalid identification');
        if (items.some(i => i.id === fields.id)) throw new AppError(`Duplicate ID in ${relative}`, 409);
        const links = [];
        if (Array.isArray(fields.links)) for (const link of fields.links) {
          if (link && typeof link === 'object') links.push(await resolveLink(this.root, str(link.destino ?? link.target), str(link.rotulo ?? link.label)));
        }
        if (!links.length) for (const match of body.matchAll(/(?<!!)\[([^\]\n]+)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) links.push(await resolveLink(this.root, match[2].replace(/^<|>$/g, ''), match[1], relative));
        items.push({ id: fields.id, fields, body, path: relative, version: hash(raw), links, final: fields.documento_final ? await resolveLink(this.root, str(fields.documento_final), 'Final document') : undefined });
      } catch (e) {
        if (e instanceof AppError && e.status === 409) throw e;
        warnings.push(`Could not read ${relative}. Check its frontmatter and path.`);
      }
    }
    const noProject = 'No project';
    const names = new Set(items.map(i => str(i.fields.projeto) || noProject));
    const projects: Project[] = [];
    // A unit is a folder with a state file. Its name must match the items' `project:` exactly; the first one found
    // wins (project, subproject, client, agent). There are no aliases or fuzzy matching.
    const units = new Map<string, { folder: string; kind: UnitKind }>();
    const unit = (name: string, folder: string, kind: UnitKind) => { if (!units.has(name)) units.set(name, { folder, kind }); };
    const projectsRoot = this.layout.projects;
    const entries = (await this.entries(projectsRoot)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = entry.name;
      if (file.startsWith('.')) continue;
      if (entry.isDirectory()) { unit(file, `${projectsRoot}/${file}`, 'projeto'); continue; }
      if (!entry.isFile() || !file.endsWith('.md') || file.startsWith('_') || /^readme\.md$/i.test(file)) continue;
      const relative = `${projectsRoot}/${file}`;
      const raw = await this.raw(relative);
      let name = file.slice(0, -3), summary = raw;
      if (raw.startsWith('---')) { try { const p = parseMarkdown(raw), fields = toCanonical(p.fields); name = str(fields.projeto || fields.id) || name; summary = p.body; } catch { /* Plain Markdown project remains readable. */ } }
      names.add(name); projects.push({ name, source: relative, summary: summary.slice(0, 600) });
    }
    const top = [...units.values()].map(u => u.folder);
    // Subproject with its own state file inside a project (e.g. projects/content/newsletter/).
    for (const folder of top) for (const sub of await this.subdirectories(folder)) if (sub !== this.layout.clients && await this.stateFile(`${folder}/${sub}`)) unit(sub, `${folder}/${sub}`, 'projeto');
    // Clients live inside the project that serves them: projects/<project>/clients/<client>/.
    for (const folder of top) for (const client of await this.subdirectories(`${folder}/${this.layout.clients}`)) unit(client, `${folder}/${this.layout.clients}/${client}`, 'cliente');
    // An agent is a unit only when it has a state file; nothing else in its folder is read.
    for (const agent of await this.subdirectories(this.layout.agents)) if (await this.stateFile(`${this.layout.agents}/${agent}`)) unit(agent, `${this.layout.agents}/${agent}`, 'agente');
    if (await this.stateFile(this.layout.system)) unit(this.layout.system, this.layout.system, 'sistema');
    for (const name of units.keys()) names.add(name);
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const project = projects.find(p => p.name === name) ?? { name };
      if (!projects.includes(project)) projects.push(project);
      const found = units.get(name);
      if (!found) continue;
      project.kind = found.kind;
      const stateFile = await this.stateFile(found.folder) ?? `${found.folder}/${this.layout.state}`;
      try { Object.assign(project, unitContext(await this.raw(stateFile)), { stateFile }); }
      catch (e) { if (!missing(e)) warnings.push(`Context unavailable: ${stateFile}`); }
      // The separate next-steps file is legacy; it is read only while the state file has no "## Next steps" section.
      if (!project.next && found.kind !== 'agente') {
        for (const legacy of legacyNextFiles(this.layout)) {
          try { project.next = sectionExcerpt(await this.raw(`${found.folder}/${legacy}`)); break; }
          catch (e) { if (!missing(e)) { warnings.push(`Context unavailable: ${found.folder}/${legacy}`); break; } }
        }
      }
    }
    const { lang, tasks, projects: projectsFolder, agents, system, state, priorities, attachments } = this.layout;
    const layout = { lang, tasks, projects: projectsFolder, agents, system, state, priorities, attachments };
    return { items, projects: projects.sort((a, b) => a.name.localeCompare(b.name)), priorities: await this.priorities(), warnings, today: today(), generalProjects: this.generalProjects, layout };
  }
  mutate(input: Mutation, hooks: TransactionHooks = {}): Promise<{ commit: string; ids: string[] }> {
    const task = this.queue.then(() => this.perform(input, hooks));
    this.queue = task.catch(() => {}); return task;
  }
  private async perform(input: Mutation, hooks: TransactionHooks) {
    if (!input || typeof input !== 'object' || !['complete', 'reopen', 'assign', 'document', 'split', 'priorities', 'delete', 'create'].includes(input.action) || typeof input.version !== 'string') throw new AppError('Invalid action');
    const snapshot = await this.snapshot();
    const lang = this.layout.lang, text = fileText[lang], taskRoot = this.taskRoot, priorityPath = this.priorityPath;
    // Changes are computed with canonical fields and written in each file's own language.
    const patchFile = (raw: string, changes: Fields) => patchMarkdown(raw, forFile(changes, fileLang(parseMarkdown(raw).fields, lang)));
    let changes: Change[] = [];
    let ids: string[];
    if (input.action === 'create') {
      // New task from the dashboard: its own file in the tasks folder, same format as subtasks, touching no other item.
      if (input.confirmed !== true) throw new AppError('Confirm the task creation');
      const task = this.validateCreate(input.task);
      const occupied = new Set(snapshot.items.map(i => i.id));
      const base = `${today()}-${slugOf(task.titulo, text.fallbackTask)}`;
      let id = base, counter = 2;
      while (occupied.has(id) || await this.exists(`${taskRoot}/${id}.md`)) id = `${base}-${counter++}`;
      const fields = { id, titulo: task.titulo, tipo: task.tipo, projeto: task.projeto, status: 'aberto', slots_usuario: task.slots_usuario || '—', slots_execucao: task.slots_execucao || '—', confianca: 'a-confirmar', prazo: task.prazo || '—', dono: task.dono, depende_de: [], origem: ['mission-control'], criado: today(), atualizado: today() };
      const after = newMarkdown(forFile(fields, lang), `\n## ${text.context}\n${task.contexto.trim() || text.created}\n\n## ${text.done}\n${text.doneBody}\n`);
      parseMarkdown(after);
      changes = [{ path: `${taskRoot}/${id}.md`, before: null, after }];
      ids = [id];
    } else if (input.action === 'priorities') {
      if (!Array.isArray(input.ids) || input.ids.length > 1000 || !input.ids.every(idValid) || new Set(input.ids).size !== input.ids.length) throw new AppError('Invalid priority list');
      if (input.version !== snapshot.priorities.version) throw new AppError('Priorities changed. Reload before reordering.', 409);
      if (input.ids.some(id => !snapshot.items.some(i => i.id === id) && !snapshot.priorities.ids.includes(id))) throw new AppError('Item not found');
      const before = snapshot.priorities.version === 'missing' ? null : await this.raw(priorityPath);
      // Recheck raw snapshot because external writers do not participate in the UI queue.
      if (before !== null && hash(before) !== input.version) throw new AppError('Priorities were changed. Reload.', 409);
      const fields = { ids: input.ids, atualizado: today() };
      changes = [{ path: priorityPath, before, after: before === null ? newMarkdown(forFile(fields, lang), `\n# ${text.priorities}\n`) : patchFile(before, fields) }];
      ids = [...new Set([...snapshot.priorities.ids, ...input.ids])];
    } else {
      if (!idValid(input.id)) throw new AppError('Invalid ID');
      const item = snapshot.items.find(i => i.id === input.id);
      if (!item) throw new AppError('Item not found', 404);
      const raw = await this.raw(item.path);
      if (hash(raw) !== input.version) throw new AppError('Another process changed this file. Reload; your form was preserved.', 409);
      ids = [item.id];
      let patch: Fields = { atualizado: today() };
      if (input.action === 'complete') patch.status = 'feito';
      if (input.action === 'reopen') {
        if (!['feito', 'arquivado'].includes(str(item.fields.status))) throw new AppError('Only done or archived tasks can be reopened.', 409);
        patch.status = 'aberto';
      }
      if (input.action === 'assign') {
        if (!textValid(input.dono, 160) || !input.dono.trim()) throw new AppError('Choose an owner.');
        patch.dono = input.dono.trim();
      }
      if (input.action === 'document') {
        if (!textValid(input.target, 2000)) throw new AppError('Invalid target');
        if (input.target && !(await resolveLink(this.root, input.target)).href) throw new AppError('Document outside the allowed folders, or invalid URL');
        patch.documento_final = input.target;
      }
      if (input.action === 'split') {
        if (input.confirmed !== true || !Array.isArray(input.children) || input.children.length < 1 || input.children.length > 30) throw new AppError('Confirm the creation of 1 to 30 subtasks');
        if (!textValid(input.parentStatus, 100)) throw new AppError('Invalid parent task status');
        const occupied = new Set(snapshot.items.map(i => i.id));
        for (const child of input.children) {
          this.validateChild(child);
          const base = `${today()}-${slugOf(child.titulo, text.fallbackSubtask)}`;
          let id = base, counter = 2;
          while (occupied.has(id) || await this.exists(`${taskRoot}/${id}.md`)) id = `${base}-${counter++}`;
          occupied.add(id); ids.push(id);
          const fields = { id, ...child, origem: [item.id], criado: today(), atualizado: today(), confianca: 'a-confirmar' };
          const after = newMarkdown(forFile(fields, lang), `\n## ${text.context}\n${text.subtask(item.id, path.posix.relative(taskRoot, item.path))}\n\n## ${text.done}\n${text.doneBody}\n`);
          parseMarkdown(after);
          changes.push({ path: `${taskRoot}/${id}.md`, before: null, after });
        }
        if (item.fields.depende_de !== undefined && !Array.isArray(item.fields.depende_de)) throw new AppError("The parent task's dependencies are not a list; fix the Markdown before splitting.");
        patch = { ...patch, depende_de: [...new Set([...list(item.fields.depende_de), ...ids.slice(1)])] };
        if (input.parentStatus) patch.status = input.parentStatus;
      }
      if (input.action === 'delete') {
        // Deleting with dependents would leave orphan references: the owner resolves them first, with the context at hand.
        const dependents = snapshot.items.filter(i => i.id !== item.id && list(i.fields.depende_de).includes(item.id));
        if (dependents.length && input.detach !== true) throw new AppError(`These items depend on it: ${dependents.map(i => i.id).join(', ')}. Remove the dependency before deleting.`, 409);
        // With `detach`, the same transaction removes the id from the other items' dependencies (typical case: a subtask from a split).
        for (const dep of dependents) {
          const depRaw = await this.raw(dep.path);
          if (hash(depRaw) !== dep.version) throw new AppError(`${dep.id} changed while the deletion was being prepared. Reload.`, 409);
          changes.push({ path: dep.path, before: depRaw, after: patchFile(depRaw, { depende_de: list(dep.fields.depende_de).filter(id => id !== item.id), atualizado: today() }) });
          ids.push(dep.id);
        }
        if (snapshot.priorities.ids.includes(item.id)) {
          const before = await this.raw(priorityPath);
          if (hash(before) !== snapshot.priorities.version) throw new AppError('Priorities changed. Reload before deleting.', 409);
          changes.push({ path: priorityPath, before, after: patchFile(before, { ids: snapshot.priorities.ids.filter(id => id !== item.id), atualizado: today() }) });
        }
        changes.push({ path: item.path, before: raw, after: null });
      } else changes.push({ path: item.path, before: raw, after: patchFile(raw, patch) });
    }
    if (changes.every(c => c.before === c.after)) throw new AppError('No changes to record');
    const commit = await transaction(this.root, changes, input.action, ids, hooks, [taskRoot]);
    return { commit, ids };
  }
  private async exists(relative: string): Promise<boolean> {
    try { await lstat(await safePath(this.root, relative, [this.taskRoot], true)); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  }
  /** Folder checked component by component, without following symbolic links. Missing: ENOENT for the caller. */
  private async directory(relative: string): Promise<string> {
    let current = this.root;
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new AppError('Symbolic root folders are not allowed');
    }
    return current;
  }
  /** Entries of a top-level folder; a folder the workspace does not use yet reads as empty. */
  private async entries(relative: string) {
    try { return await readdir(await this.directory(relative), { withFileTypes: true }); }
    catch (e) { if (missing(e)) return []; throw e; }
  }
  /** Real subfolders, in order; a missing folder is not an error and a symbolic link does not count as a subfolder. */
  private async subdirectories(relative: string): Promise<string[]> {
    return (await this.entries(relative)).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
  }
  private async isFile(relative: string): Promise<boolean> {
    try { return (await lstat(path.join(this.root, relative))).isFile(); }
    catch (e) { if (missing(e)) return false; throw e; }
  }
  /** The unit's state file (STATE.md or ESTADO.md, the layout's own name first), if there is one. */
  private async stateFile(folder: string): Promise<string | undefined> {
    for (const name of stateFiles(this.layout)) if (await this.isFile(`${folder}/${name}`)) return `${folder}/${name}`;
    return undefined;
  }
  private validateCreate(task: CreateInput): CreateInput {
    if (!task || typeof task !== 'object') throw new AppError('Invalid task');
    const keys = ['titulo', 'projeto', 'tipo', 'dono', 'prazo', 'slots_usuario', 'slots_execucao', 'contexto'] as const;
    if (Object.keys(task).some(k => !(keys as readonly string[]).includes(k))) throw new AppError('Unknown task field');
    for (const key of keys) if (!(key === 'contexto' ? multilineValid(task[key] ?? '', 4000) : textValid(task[key] ?? '', key === 'titulo' ? 500 : 160))) throw new AppError(`Invalid field: ${key}`);
    const clean = Object.fromEntries(keys.map(k => [k, str(task[k]).trim()])) as unknown as CreateInput;
    if (!clean.titulo || !clean.projeto || !clean.tipo || !clean.dono) throw new AppError('Fill in title, project, type and owner');
    if (clean.prazo && clean.prazo !== '—' && !/^\d{4}-\d{2}-\d{2}$/.test(clean.prazo)) throw new AppError('Due date must be YYYY-MM-DD or —');
    return clean;
  }
  private validateChild(child: ChildInput) {
    if (!child || typeof child !== 'object') throw new AppError('Invalid subtask');
    const keys = ['titulo', 'projeto', 'tipo', 'slots_usuario', 'slots_execucao', 'dono', 'prazo', 'status'] as const;
    if (Object.keys(child).some(k => ![...keys, 'depende_de'].includes(k as typeof keys[number]))) throw new AppError('Unknown subtask field');
    for (const key of keys) if (!textValid(child[key], key === 'titulo' ? 500 : 160)) throw new AppError(`Invalid field: ${key}`);
    if (!child.titulo.trim() || !child.projeto.trim() || !child.tipo.trim() || !child.status.trim()) throw new AppError('Fill in title, project, type and status');
    if (!Array.isArray(child.depende_de) || !child.depende_de.every(idValid)) throw new AppError('Invalid dependencies');
    if (child.prazo && child.prazo !== '—' && !/^\d{4}-\d{2}-\d{2}$/.test(child.prazo)) throw new AppError('Due date must be YYYY-MM-DD or —');
  }
}
