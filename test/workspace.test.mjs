import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkspace } from '../server/workspace.mjs';

const exec = promisify(execFile);
const task = `---
id: tarefa-exemplo
titulo: Revisar documento de teste
projeto: exemplo
tipo: tarefa
status: aberto
dono: usuario
depende_de: []
origem: [teste]
campo_preservado: sim
---
\nCorpo de teste com **formatação**.\n`;
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mission-control-fixture-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace'), stateDir = path.join(base, 'state');
  for (const dir of ['tarefas', 'projetos/exemplo', 'pesquisas', 'sistema', 'agentes/teste/memory', 'recursos']) await mkdir(path.join(root, dir), { recursive: true });
  const docs = {
    'tarefas/tarefa-exemplo.md': task,
    'projetos/exemplo/ESTADO.md': '# Exemplo\n\n**Status:** ativo\n\n## O que é\nProjeto de teste.\n\n## Próximos passos\n- Rever.\n',
    'projetos/exemplo/documento.md': '# Documento\n\nTexto inicial <script>não executável</script>.\n',
    'projetos/exemplo/metricas.json': '{"cpu":12,"tokens":1234}',
    'projetos/exemplo/tabela.csv': 'item,valor\na,1\n',
    'projetos/exemplo/credentials.json': '{"password":"fixture-invalida"}',
    'projetos/exemplo/config.json': '{"nested":{"access_token":"fixture-invalida"}}',
    'agentes/teste/ESTADO.md': '# Agente de teste\n\n**Status:** ativo\n',
    'agentes/teste/MEMORY.md': '# Memória de fixture\n',
    'agentes/teste/memory/2026-10-05.md': 'Diário exclusivamente sintético.\n',
    'alheio.txt': 'Original\n',
  };
  for (const [file, content] of Object.entries(docs)) await writeFile(path.join(root, file), content);
  const git = async args => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root })).stdout;
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Executor de fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['add', '.']); await git(['commit', '-m', 'Fixture inicial']);
  return { root, stateDir, git, api: createWorkspace({ root, stateDir }) };
}

test('pt layout: snapshot reads the canonical format and needs no external service', async t => {
  const f = await fixture(t), snap = await f.api.snapshot();
  assert.equal(snap.items.length, 1); assert.equal(snap.items[0].fields.titulo, 'Revisar documento de teste');
  assert(snap.projects.some(p => p.name === 'exemplo' && p.stateFile === 'projetos/exemplo/ESTADO.md'));
  assert(snap.projects.some(p => p.kind === 'agente'));
  assert.deepEqual(snap.priorities.ids, []);
  assert.deepEqual(snap.generalProjects, ['sistema']);
  assert.equal((await f.git(['status', '--porcelain'])).trim(), '');
});

test('pt layout: folders and search use metadata; agent memory needs an explicit path', async t => {
  const f = await fixture(t);
  const top = await f.api.listFiles();
  assert(top.directories.some(d => d.path === 'agentes')); assert.equal(top.files.length, 0);
  const all = await f.api.listFiles({ query: '.md' });
  assert(all.files.some(d => d.path === 'projetos/exemplo/documento.md'));
  assert(!all.files.some(d => /^agentes\//.test(d.path)));
  assert(!all.files.some(d => 'content' in d));
  const memory = await f.api.listFiles({ path: 'agentes/teste/memory' });
  assert.equal(memory.files[0].name, '2026-10-05.md');
  const inside = await f.api.listFiles({ path: 'agentes/teste', query: '2026' });
  assert.equal(inside.files[0].path, 'agentes/teste/memory/2026-10-05.md');
  assert.equal((await f.api.listFiles({ path: 'projetos/exemplo', limit: 1 })).files.length, 1);
});

test('pt layout: traversal, dotfiles, credentials, binaries and symlinks are blocked', async t => {
  const f = await fixture(t);
  await symlink(path.join(f.root, 'projetos/exemplo/documento.md'), path.join(f.root, 'projetos/exemplo/alias.md'));
  await symlink(path.join(f.root, 'projetos/exemplo'), path.join(f.root, 'projetos/alias'));
  for (const file of ['../fora.md', '/etc/passwd', 'projetos/../alheio.txt', '.git/config', 'projetos/exemplo/.env', 'projetos/exemplo/credentials.json', 'projetos/exemplo/config.json', 'projetos/exemplo/alias.md', 'projetos/alias/documento.md']) {
    await assert.rejects(() => f.api.readDocument(file), { status: 403 });
  }
  const files = await f.api.listFiles({ path: 'projetos/exemplo' });
  assert(!files.files.some(d => /credentials|alias/.test(d.name)));
  const doc = await f.api.readDocument('projetos/exemplo/metricas.json');
  assert.equal(doc.content, '{"cpu":12,"tokens":1234}');
  assert.equal(doc.editable, true);
  await assert.rejects(() => f.api.readDocument('projetos/exemplo/inexistente.md'), { status: 404 });
});

test('pt layout: saving a document requires confirmation, version and identity, and keeps conflicts', async t => {
  const f = await fixture(t), doc = await f.api.readDocument('projetos/exemplo/documento.md');
  await assert.rejects(() => f.api.saveDocument({ ...doc, content: 'Novo\n' }, 'Usuario'), { status: 400 });
  await assert.rejects(() => f.api.saveDocument({ ...doc, content: 'Novo\n', confirmed: true }), { status: 403 });
  await writeFile(path.join(f.root, doc.path), 'Edição simultânea\n');
  await assert.rejects(() => f.api.saveDocument({ ...doc, content: 'Novo\n', confirmed: true }, 'Usuario'), { status: 409 });
  assert.equal(await readFile(path.join(f.root, doc.path), 'utf8'), 'Edição simultânea\n');
  const newer = await f.api.readDocument(doc.path);
  await assert.rejects(() => f.api.saveDocument({ ...newer, content: 'Outra\n', confirmed: true }, 'Usuario'), { status: 409 });
});

test('pt layout: saving makes a backup, an isolated commit and an audit without content', async t => {
  const f = await fixture(t), doc = await f.api.readDocument('projetos/exemplo/documento.md');
  await writeFile(path.join(f.root, 'alheio.txt'), 'Mudança staged alheia\n'); await f.git(['add', 'alheio.txt']);
  const content = '# Alterado\n\nConteúdo exclusivo da fixture.\n';
  const saved = await f.api.saveDocument({ ...doc, content, confirmed: true }, { email: 'usuario@fixture.invalid' });
  assert.equal(saved.content, content); assert.notEqual(saved.version, doc.version); assert(saved.saved); assert.match(saved.commit, /^[a-f0-9]{40,64}$/);
  assert.equal((await f.git(['show', '--name-only', '--format=', saved.commit])).trim(), doc.path);
  assert.equal((await f.git(['diff', '--cached', '--name-only'])).trim(), 'alheio.txt');
  assert.equal((await f.git(['log', '-1', '--format=%an|%ae'])).trim(), 'Executor de fixture (via Mission Control)|fixture@example.invalid');
  assert.equal((await f.git(['config', 'user.name'])).trim(), 'Executor de fixture');
  const backups = await readdir(path.join(f.stateDir, 'document-backups'));
  assert.equal(backups.length, 1); assert.equal(await readFile(path.join(f.stateDir, 'document-backups', backups[0]), 'utf8'), doc.content);
  const audit = await readFile(path.join(f.stateDir, 'workspace-audit.jsonl'), 'utf8');
  assert(audit.includes(saved.commit)); assert(audit.includes('usuario@fixture.invalid')); assert(!audit.includes('Conteúdo exclusivo'));
  assert(!(await readdir(path.join(f.root, '.git'))).includes('mission-control-pending.json'));
});

test('pt layout: a Git lock or an interrupted write blocks a new save', async t => {
  const f = await fixture(t), doc = await f.api.readDocument('projetos/exemplo/documento.md');
  const input = { ...doc, content: 'Novo\n', confirmed: true };
  await writeFile(path.join(f.root, '.git/index.lock'), '');
  await assert.rejects(() => f.api.saveDocument(input, 'Usuario'), { status: 409 });
  await rm(path.join(f.root, '.git/index.lock'));
  await writeFile(path.join(f.root, '.git/mission-control-pending.json'), '{}');
  await assert.rejects(() => f.api.saveDocument(input, 'Usuario'), { status: 409 });
  assert.equal((await f.api.readDocument(doc.path)).content, doc.content);
});

test('pt layout: a real task mutation keeps the body, signs and audits', async t => {
  const f = await fixture(t), item = (await f.api.snapshot()).items[0];
  const result = await f.api.mutate({ action: 'complete', id: item.id, version: item.version }, 'Usuario autenticado');
  const after = (await f.api.snapshot()).items[0];
  assert.equal(after.fields.status, 'feito'); assert.equal(after.body, item.body);
  assert.equal(after.fields.campo_preservado, 'sim');
  assert.equal((await f.git(['log', '-1', '--format=%an|%ae'])).trim(), 'Executor de fixture (via Mission Control)|fixture@example.invalid');
  assert.match((await f.git(['log', '-1', '--format=%s'])).trim(), /^mission-control:/);
  assert((await readFile(path.join(f.stateDir, 'workspace-audit.jsonl'), 'utf8')).includes(result.commit));
  await assert.rejects(() => f.api.mutate({ action: 'complete', id: item.id, version: item.version }, 'Usuario'), { status: 409 });
});

test('pt layout: priorities and subtasks are real files with version conflicts', async t => {
  const f = await fixture(t), snap = await f.api.snapshot(), item = snap.items[0];
  await f.api.mutate({ action: 'priorities', ids: [item.id], version: snap.priorities.version }, 'Usuario');
  const priorities = (await f.api.snapshot()).priorities;
  assert.deepEqual(priorities.ids, [item.id]);
  const child = { titulo: 'Etapa sintética', projeto: 'exemplo', tipo: 'tarefa', status: 'aberto', slots_usuario: '1', slots_execucao: '1', dono: 'usuario', prazo: '—', depende_de: [] };
  const result = await f.api.mutate({ action: 'split', id: item.id, version: item.version, children: [child], parentStatus: '', confirmed: true }, 'Usuario');
  assert.equal(result.ids.length, 2); assert.equal((await f.api.snapshot()).items.length, 2);
});

test('pt layout: credentials are not saved and stateDir inside Git is refused', async t => {
  const f = await fixture(t), doc = await f.api.readDocument('projetos/exemplo/metricas.json');
  await assert.rejects(() => f.api.saveDocument({ ...doc, content: '{"password":"nao-permitido"}', confirmed: true }, 'Usuario'), { status: 403 });
  assert.throws(() => createWorkspace({ root: f.root, stateDir: path.join(f.root, 'estado-local') }));
});

test('pt layout: untracked files and nested repositories are read-only with an explicit reason', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'projetos/exemplo/novo.md'), '# Ainda não rastreado\n');
  const untracked = await f.api.readDocument('projetos/exemplo/novo.md');
  assert.equal(untracked.editable, false); assert.match(untracked.editReason, /not tracked in Git/);
  await assert.rejects(() => f.api.saveDocument({ ...untracked, content: 'Outra\n', confirmed: true }, 'Usuario'), { status: 409 });
  const nested = path.join(f.root, 'projetos/proprio');
  await mkdir(nested); await exec('git', ['init', '-b', 'main'], { cwd: nested });
  await writeFile(path.join(nested, 'documento.md'), '# Repositório próprio\n');
  const doc = await f.api.readDocument('projetos/proprio/documento.md');
  assert.equal(doc.editable, false); assert.match(doc.editReason, /another repository/);
});

test('pt layout: an audit failure after the commit does not turn confirmed writes into errors', async t => {
  const f = await fixture(t), records = [];
  const api = createWorkspace({ root: f.root, stateDir: f.stateDir, auditSink: async record => {
    records.push(record);
    if (record.phase === 'committed') throw new Error('Falha sintética no destino de auditoria');
  } });
  const doc = await api.readDocument('projetos/exemplo/documento.md');
  const saved = await api.saveDocument({ ...doc, content: '# Versão confirmada\n', confirmed: true }, 'Usuario QA');
  assert.equal(saved.saved, true);
  assert.match(saved.auditWarning, /commit confirmed/);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), saved.commit);
  assert.equal((await api.readDocument(doc.path)).content, '# Versão confirmada\n');
  assert(!(await readdir(path.join(f.root, '.git'))).includes('mission-control-pending.json'));
  const item = (await api.snapshot()).items[0];
  const changed = await api.mutate({ action: 'complete', id: item.id, version: item.version }, 'Usuario QA');
  assert.equal(changed.committed, true);
  assert.match(changed.auditWarning, /commit confirmed/);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), changed.commit);
  assert.equal((await api.snapshot()).items[0].fields.status, 'feito');
  assert(records.some(record => record.action === 'document.save' && record.phase === 'committed'));
  assert(records.some(record => record.action === 'task.complete' && record.phase === 'committed'));
});

test('pt layout: an audit failure before the change prevents the write and the commit', async t => {
  const f = await fixture(t), before = (await f.git(['rev-parse', 'HEAD'])).trim();
  const api = createWorkspace({ root: f.root, stateDir: f.stateDir, auditSink: async () => { throw new Error('Destino indisponível'); } });
  const doc = await api.readDocument('projetos/exemplo/documento.md');
  await assert.rejects(() => api.saveDocument({ ...doc, content: 'Não deve ser salvo', confirmed: true }, 'Usuario QA'));
  const item = (await api.snapshot()).items[0];
  await assert.rejects(() => api.mutate({ action: 'complete', id: item.id, version: item.version }, 'Usuario QA'));
  assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), before);
  assert.equal((await api.readDocument(doc.path)).content, doc.content);
  assert.equal((await api.snapshot()).items[0].fields.status, 'aberto');
});

test('pt layout: creating, assigning and reopening a task produce their own file and commit', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.api.mutate({ action: 'create', version: 'new', confirmed: true, task: { titulo: '', projeto: 'exemplo', tipo: 'tarefa', dono: 'usuario', prazo: '—', slots_usuario: '', slots_execucao: '', contexto: '' } }, 'Usuario'), { status: 400 });
  const created = await f.api.mutate({ action: 'create', version: 'new', confirmed: true, task: { titulo: 'Ligar para o contador', projeto: 'exemplo', tipo: 'tarefa', dono: 'assistente', prazo: '2026-10-10', slots_usuario: '1', slots_execucao: '1', contexto: 'Pedido feito pelo painel.\nSegunda linha.' } }, 'Usuario');
  assert.equal(created.ids.length, 1);
  const item = (await f.api.snapshot()).items.find(i => i.id === created.ids[0]);
  assert.equal(item.fields.titulo, 'Ligar para o contador'); assert.equal(item.fields.dono, 'assistente'); assert.equal(item.fields.status, 'aberto');
  assert.deepEqual(item.fields.origem, ['mission-control']);
  assert.match(item.body, /Segunda linha/);
  await assert.rejects(() => f.api.mutate({ action: 'reopen', id: item.id, version: item.version }, 'Usuario'), { status: 409 });
  const assigned = await f.api.mutate({ action: 'assign', id: item.id, version: item.version, dono: 'revisor' }, 'Usuario');
  let after = (await f.api.snapshot()).items.find(i => i.id === item.id);
  assert.equal(after.fields.dono, 'revisor'); assert.ok(assigned.commit);
  await f.api.mutate({ action: 'complete', id: after.id, version: after.version }, 'Usuario');
  after = (await f.api.snapshot()).items.find(i => i.id === item.id);
  await f.api.mutate({ action: 'reopen', id: after.id, version: after.version }, 'Usuario');
  after = (await f.api.snapshot()).items.find(i => i.id === item.id);
  assert.equal(after.fields.status, 'aberto');
  assert.equal((await f.git(['status', '--porcelain'])).trim(), '');
});

test('pt layout: recent commits expose metadata only and mark sync routines', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'projetos/exemplo/documento.md'), 'segredo PRIVATE-MARKER\n');
  await f.git(['commit', '-am', 'sync automatico: 2026-10-06']);
  const commits = await f.api.recentCommits(5);
  assert.equal(commits.length, 2); assert.equal(commits[0].routine, true); assert.equal(commits[1].routine, false);
  assert.ok(!JSON.stringify(commits).includes('PRIVATE-MARKER'));
  assert.equal(commits[0].author, 'Executor de fixture');
});

test('pt layout: uploads go to the agent folder or a temporary folder, refusing dangerous names and unknown destinations', async t => {
  const f = await fixture(t);
  const { Readable } = await import('node:stream');
  const stream = () => Readable.from([Buffer.from('%PDF-1.4 '), Buffer.from('conteúdo sintético')]);
  for (const name of ['.env', 'credentials.pdf', 'chave.pem', 'token.txt', '', '-x.pdf']) await assert.rejects(() => f.api.storeUpload({ agentId: 'teste', name, mimeType: 'application/pdf', stream: stream() }, 'Usuario'), { status: 400 });
  await assert.rejects(() => f.api.storeUpload({ agentId: '../x', name: 'ok.pdf', mimeType: 'application/pdf', stream: stream() }, 'Usuario'), { status: 400 });
  // Path segments and control characters in the name are neutralized, not accepted as sent.
  const sanitized = await f.api.storeUpload({ agentId: 'teste', name: '../a\u0000b.pdf', mimeType: 'application/pdf', stream: stream() }, 'Usuario');
  assert.equal(sanitized.name, 'ab.pdf');
  await assert.rejects(() => f.api.storeUpload({ agentId: 'teste', destination: 'raiz', name: 'ok.pdf', mimeType: 'application/pdf', stream: stream() }, 'Usuario'), { status: 400 });
  await assert.rejects(() => f.api.storeUpload({ agentId: 'teste', name: 'grande.pdf', mimeType: 'application/pdf', stream: stream(), maxBytes: 4 }, 'Usuario'), { status: 413 });
  const first = await f.api.storeUpload({ agentId: 'teste', destination: 'anexos', name: 'Print da tela.png', mimeType: 'image/png', stream: stream() }, 'Usuario');
  const second = await f.api.storeUpload({ agentId: 'teste', destination: 'anexos', name: 'Print da tela.png', mimeType: 'image/png', stream: stream() }, 'Usuario');
  assert.match(first.path, /^agentes\/teste\/anexos\/\d{4}-\d{2}-\d{2}\/Print da tela\.png$/);
  assert.equal(first.temporary, false);
  assert.match(second.name, /^Print da tela-2\.png$/);
  assert.equal(first.gatewayPath, '/workspace/' + first.path);
  assert.equal(await readFile(path.join(f.root, first.path), 'utf8'), '%PDF-1.4 conteúdo sintético');
  assert.ok((await readFile(path.join(f.stateDir, 'workspace-audit.jsonl'), 'utf8')).includes('upload.store'));
  assert.ok(!(await readdir(path.join(f.root, 'agentes/teste/anexos'))).some(n => n.startsWith('.upload-')));
});

test('pt layout: deleting an item with dependents is refused unless detach clears them in the same transaction', async t => {
  const f = await fixture(t), item = (await f.api.snapshot()).items[0];
  const child = { titulo: 'Filha', projeto: 'exemplo', tipo: 'tarefa', status: 'aberto', slots_usuario: '1', slots_execucao: '1', dono: 'usuario', prazo: '—', depende_de: [] };
  const split = await f.api.mutate({ action: 'split', id: item.id, version: item.version, children: [child], parentStatus: '', confirmed: true }, 'Usuario');
  let snap = await f.api.snapshot();
  const sub = snap.items.find(i => i.id === split.ids[1]);
  await assert.rejects(() => f.api.mutate({ action: 'delete', id: sub.id, version: sub.version }, 'Usuario'), { status: 409 });
  const result = await f.api.mutate({ action: 'delete', id: sub.id, version: sub.version, detach: true }, 'Usuario');
  assert.deepEqual(result.ids.sort(), [item.id, sub.id].sort());
  snap = await f.api.snapshot();
  assert.ok(!snap.items.some(i => i.id === sub.id));
  assert.deepEqual(snap.items.find(i => i.id === item.id).fields.depende_de, []);
  assert.equal((await f.git(['status', '--porcelain'])).trim(), '');
});

test('pt layout: attachments are temporary by default: hidden folder, invisible in the library, swept after 3 days', async t => {
  const f = await fixture(t);
  const { Readable } = await import('node:stream');
  const { utimes } = await import('node:fs/promises');
  const temp = await f.api.storeUpload({ agentId: 'teste', name: 'print.png', mimeType: 'image/png', stream: Readable.from([Buffer.from('x')]) }, 'Usuario');
  assert.match(temp.path, /^\.tmp\/anexos\/teste\/\d{4}-\d{2}-\d{2}\/print\.png$/);
  assert.equal(temp.temporary, true); assert.ok(temp.expiresAt);
  await assert.rejects(() => f.api.listFiles({ path: '.tmp' }), { status: 403 });
  const old = path.join(f.root, temp.path);
  await utimes(old, new Date(Date.now() - 4 * 86400000), new Date(Date.now() - 4 * 86400000));
  const fresh = await f.api.storeUpload({ agentId: 'teste', name: 'novo.png', mimeType: 'image/png', stream: Readable.from([Buffer.from('y')]) }, 'Usuario');
  const result = await f.api.sweepUploads();
  assert.equal(result.removed, 1);
  await assert.rejects(() => readFile(old), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.root, fresh.path), 'utf8'), 'y');
});

test('pt layout: attachments use the path configured for the agents installation',async t=>{
 const before=process.env.MC_GATEWAY_WORKSPACE;
 process.env.MC_GATEWAY_WORKSPACE='/srv/agentes/workspace';
 t.after(()=>{if(before===undefined)delete process.env.MC_GATEWAY_WORKSPACE;else process.env.MC_GATEWAY_WORKSPACE=before;});
 const f=await fixture(t);
 const stored=await f.api.storeUpload({agentId:'teste',name:'exemplo.txt',mimeType:'text/plain',stream:(async function*(){yield Buffer.from('Dados fictícios');})()},'usuario@example.test');
 assert.equal(stored.gatewayPath,'/srv/agentes/workspace/'+stored.path);
});
