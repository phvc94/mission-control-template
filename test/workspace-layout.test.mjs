import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createWorkspace } from '../server/workspace.mjs';
import { resolveLayout, toCanonical, forFile, fileLang, layouts, fieldAliases } from '../server/workspace-core/layout.ts';
import { unitContext } from '../server/workspace-core/markdown.ts';

const exec = promisify(execFile);
const englishTask = `---
id: example-task
title: Review the test document
project: example
type: task
status: open
owner: user
user_slots: '1'
exec_slots: '0'
due: '—'
depends_on: []
confidence: high
kept_field: yes
---

Test body with **formatting**.
`;
async function workspace(t, docs, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mission-control-layout-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace'), stateDir = path.join(base, 'state');
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(docs)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const git = async args => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root })).stdout;
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Fixture runner']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['add', '-A']); await git(['commit', '--allow-empty', '-m', 'Initial fixture']);
  return { root, git, api: createWorkspace({ root, stateDir, ...options }) };
}
const englishDocs = {
  'tasks/example-task.md': englishTask,
  'projects/example/STATE.md': '# Example\n\n**Status:** active\n\n## What it is\nTest project.\n\n## Next steps\n- [ ] Review — owner: user\n- [x] Already done\n',
  'agents/helper/STATE.md': '# Helper agent\n\n**Status:** active\n',
  'system/STATE.md': '# System\n\n**Status:** active\n',
};

test('layout: auto picks English for tasks/, Portuguese for tarefas/, English for an empty workspace', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mission-control-layout-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const dir of ['en/tasks', 'pt/tarefas', 'empty']) await mkdir(path.join(base, dir), { recursive: true });
  assert.equal(resolveLayout(path.join(base, 'en'), 'auto').lang, 'en');
  assert.equal(resolveLayout(path.join(base, 'pt'), 'auto').lang, 'pt');
  assert.equal(resolveLayout(path.join(base, 'pt'), undefined).lang, 'pt');
  assert.equal(resolveLayout(path.join(base, 'empty'), 'auto').lang, 'en');
  assert.equal(resolveLayout(path.join(base, 'en'), 'pt').lang, 'pt');
  assert.throws(() => resolveLayout(base, 'fr'), /MC_WORKSPACE_LAYOUT/);
  assert.throws(() => createWorkspace({ root: base, stateDir: path.join(os.tmpdir(), 'x'), layout: 'fr' }), /MC_WORKSPACE_LAYOUT/);
});

test('layout: field names and values map both ways, and a file keeps its own language', () => {
  const canonical = toCanonical({ id: 'a', title: 'T', owner: 'me', status: 'done', type: 'decision', confidence: 'low', due: '—', custom: 1 });
  assert.deepEqual(canonical, { id: 'a', titulo: 'T', dono: 'me', status: 'feito', tipo: 'decisao', confianca: 'baixa', prazo: '—', custom: 1 });
  assert.deepEqual(forFile({ status: 'feito', atualizado: '2026-01-01', depende_de: [] }, 'en'), { status: 'done', updated: '2026-01-01', depends_on: [] });
  assert.deepEqual(forFile({ status: 'feito' }, 'pt'), { status: 'feito' });
  assert.equal(toCanonical({ status: 'custom-state' }).status, 'custom-state');
  assert.equal(fileLang({ id: 'a', title: 'x' }, 'pt'), 'en');
  assert.equal(fileLang({ id: 'a', titulo: 'x' }, 'en'), 'pt');
  assert.equal(fileLang({ ids: [] }, 'en'), 'en');
  assert.equal(layouts.en.priorities, 'tasks/_priorities.md');
});

test('layout: "## Next steps" and "## Próximos passos" are both read in any workspace', () => {
  assert.equal(unitContext('# X\n\n**Status:** active\n\n## Next steps\n- [ ] A\n- [x] B\n').next, '- [ ] A');
  assert.equal(unitContext('# X\n\n**Status:** ativo\n\n## Próximos passos\n- [ ] A\n').next, '- [ ] A');
  assert.equal(unitContext('# X\n\n## Current status\nPaused for now\n').status, 'Paused for now');
});

test('en layout: snapshot reads English folders, STATE.md and English fields as canonical fields', async t => {
  const f = await workspace(t, englishDocs);
  const snap = await f.api.snapshot();
  assert.equal(snap.layout.lang, 'en');
  assert.equal(snap.layout.tasks, 'tasks');
  assert.equal(snap.items.length, 1);
  const item = snap.items[0];
  assert.equal(item.fields.titulo, 'Review the test document');
  assert.equal(item.fields.status, 'aberto');
  assert.equal(item.fields.tipo, 'tarefa');
  assert.equal(item.fields.confianca, 'alta');
  assert.equal(item.fields.kept_field, 'yes');
  const project = snap.projects.find(p => p.name === 'example');
  assert.equal(project.stateFile, 'projects/example/STATE.md');
  assert.equal(project.status, 'active');
  assert.equal(project.next, '- [ ] Review — owner: user');
  assert(snap.projects.some(p => p.name === 'helper' && p.kind === 'agente'));
  assert(snap.projects.some(p => p.name === 'system' && p.kind === 'sistema'));
  assert.deepEqual(snap.generalProjects, ['system']);
  assert.deepEqual(snap.warnings, []);
});

test('en layout: completing, prioritizing and creating write English files', async t => {
  const f = await workspace(t, englishDocs);
  let snap = await f.api.snapshot();
  const item = snap.items[0];
  await f.api.mutate({ action: 'complete', id: item.id, version: item.version }, 'Fixture user');
  const completed = await readFile(path.join(f.root, 'tasks/example-task.md'), 'utf8');
  assert.match(completed, /^status: "done"$/m);
  assert.match(completed, /^updated: "\d{4}-\d{2}-\d{2}"$/m);
  assert.doesNotMatch(completed, /^(status: "feito"|atualizado:)/m);
  assert.match(completed, /Test body with \*\*formatting\*\*\./);
  snap = await f.api.snapshot();
  assert.equal(snap.items[0].fields.status, 'feito');
  await f.api.mutate({ action: 'priorities', ids: [item.id], version: snap.priorities.version }, 'Fixture user');
  const priorities = await readFile(path.join(f.root, 'tasks/_priorities.md'), 'utf8');
  assert.match(priorities, /^ids: \["example-task"\]$/m);
  assert.match(priorities, /^updated: /m);
  assert.match(priorities, /^# Priorities$/m);
  const created = await f.api.mutate({ action: 'create', version: 'new', confirmed: true, task: { titulo: 'Call the accountant', projeto: 'example', tipo: 'tarefa', dono: 'helper', prazo: '2026-10-10', slots_usuario: '1', slots_execucao: '1', contexto: '' } }, 'Fixture user');
  const createdFile = await readFile(path.join(f.root, `tasks/${created.ids[0]}.md`), 'utf8');
  for (const line of ['title: "Call the accountant"', 'type: "task"', 'project: "example"', 'status: "open"', 'confidence: "to-confirm"', 'owner: "helper"', 'due: "2026-10-10"', 'user_slots: "1"', 'exec_slots: "1"', 'depends_on: []']) assert(createdFile.includes(line + '\n'), line);
  assert.match(createdFile, /## Context\nCreated in Mission Control\.\n\n## Definition of done\n/);
  assert.doesNotMatch(createdFile, /titulo|dono|prazo|Contexto/);
  assert.equal((await f.git(['status', '--porcelain'])).trim(), '');
  assert.equal((await f.git(['log', '-1', '--format=%an'])).trim(), 'Fixture runner (via Mission Control)');
});

test('en layout: splitting and deleting keep each file in English', async t => {
  const f = await workspace(t, englishDocs);
  let snap = await f.api.snapshot();
  const item = snap.items[0];
  const child = { titulo: 'First part', projeto: 'example', tipo: 'tarefa', slots_usuario: '1', slots_execucao: '0', dono: 'user', prazo: '—', status: 'aberto', depende_de: [] };
  const split = await f.api.mutate({ action: 'split', id: item.id, version: item.version, children: [child], parentStatus: 'aguardando', confirmed: true }, 'Fixture user');
  const subId = split.ids[1];
  const parent = await readFile(path.join(f.root, 'tasks/example-task.md'), 'utf8');
  assert.match(parent, /^depends_on: \["[^"]+"\]$/m);
  assert.match(parent, /^status: "waiting"$/m);
  const sub = await readFile(path.join(f.root, `tasks/${subId}.md`), 'utf8');
  assert.match(sub, /Subtask of \[example-task\]\(example-task\.md\)/);
  snap = await f.api.snapshot();
  const subItem = snap.items.find(i => i.id === subId);
  await f.api.mutate({ action: 'delete', id: subItem.id, version: subItem.version, detach: true }, 'Fixture user');
  assert.match(await readFile(path.join(f.root, 'tasks/example-task.md'), 'utf8'), /^depends_on: \[\]$/m);
});

test('pt layout: an individual task file written with English keys is read and edited in English', async t => {
  const f = await workspace(t, { 'tarefas/mixed.md': englishTask.replace('id: example-task', 'id: mixed'), 'projetos/example/ESTADO.md': '# Exemplo\n\n**Status:** ativo\n' });
  const snap = await f.api.snapshot();
  assert.equal(snap.layout.lang, 'pt');
  const item = snap.items[0];
  assert.equal(item.fields.titulo, 'Review the test document');
  await f.api.mutate({ action: 'assign', id: item.id, version: item.version, dono: 'helper' }, 'Fixture user');
  const after = await readFile(path.join(f.root, 'tarefas/mixed.md'), 'utf8');
  assert.match(after, /^owner: "helper"$/m);
  assert.doesNotMatch(after, /^dono:/m);
});

test('en layout: kept attachments go to agents/<id>/attachments; unknown destinations are refused', async t => {
  const f = await workspace(t, englishDocs);
  const stream = () => Readable.from([Buffer.from('content')]);
  const kept = await f.api.storeUpload({ agentId: 'helper', destination: 'anexos', name: 'Screenshot.png', mimeType: 'image/png', stream: stream() }, 'Fixture user');
  assert.match(kept.path, /^agents\/helper\/attachments\/\d{4}-\d{2}-\d{2}\/Screenshot\.png$/);
  await assert.rejects(() => f.api.storeUpload({ agentId: 'helper', destination: 'inbox', name: 'Book.pdf', mimeType: 'application/pdf', stream: stream() }, 'Fixture user'), { status: 400 });
  const listed = await f.api.listFiles({ path: 'projects' });
  assert.equal(listed.path, 'projects');
});

test('custom field names: MC_TASK_FIELD_ALIASES maps a file key to a dashboard field, both ways', async t => {
  assert.deepEqual(fieldAliases('slots_usuario=my_slots, dono=assignee'), { slots_usuario: 'my_slots', dono: 'assignee' });
  assert.throws(() => fieldAliases('unknown_field=x'), /MC_TASK_FIELD_ALIASES/);
  assert.throws(() => fieldAliases('slots_usuario'), /MC_TASK_FIELD_ALIASES/);
  const aliases = { slots_usuario: 'my_slots' };
  assert.equal(toCanonical({ my_slots: '2' }, aliases).slots_usuario, '2');
  assert.deepEqual(forFile({ slots_usuario: '2', status: 'aberto' }, 'pt', aliases), { my_slots: '2', status: 'aberto' });
  assert.deepEqual(forFile({ slots_usuario: '2', status: 'aberto' }, 'en', aliases), { my_slots: '2', status: 'open' });
  const previous = process.env.MC_TASK_FIELD_ALIASES;
  process.env.MC_TASK_FIELD_ALIASES = 'slots_usuario=my_slots';
  t.after(() => { if (previous === undefined) delete process.env.MC_TASK_FIELD_ALIASES; else process.env.MC_TASK_FIELD_ALIASES = previous; });
  const f = await workspace(t, { 'tarefas/a.md': '---\nid: a\ntitulo: Tarefa\nprojeto: x\nstatus: aberto\nmy_slots: \'3\'\n---\n', 'projetos/x/ESTADO.md': '# X\n' });
  const snap = await f.api.snapshot();
  assert.equal(snap.items[0].fields.slots_usuario, '3');
  const created = await f.api.mutate({ action: 'create', version: 'new', confirmed: true, task: { titulo: 'Nova', projeto: 'x', tipo: 'tarefa', dono: 'eu', prazo: '—', slots_usuario: '1', slots_execucao: '0', contexto: '' } }, 'Fixture user');
  const file = await readFile(path.join(f.root, `tarefas/${created.ids[0]}.md`), 'utf8');
  assert.match(file, /^my_slots: "1"$/m);
  assert.doesNotMatch(file, /^slots_usuario:/m);
});

test('MC_GIT_AUTHOR_NAME sets the author of commits made by the dashboard', async t => {
  const previous = process.env.MC_GIT_AUTHOR_NAME;
  process.env.MC_GIT_AUTHOR_NAME = 'Owner (via Mission Control)';
  t.after(() => { if (previous === undefined) delete process.env.MC_GIT_AUTHOR_NAME; else process.env.MC_GIT_AUTHOR_NAME = previous; });
  const f = await workspace(t, englishDocs);
  const item = (await f.api.snapshot()).items[0];
  await f.api.mutate({ action: 'complete', id: item.id, version: item.version }, 'Fixture user');
  assert.equal((await f.git(['log', '-1', '--format=%an'])).trim(), 'Owner (via Mission Control)');
});
