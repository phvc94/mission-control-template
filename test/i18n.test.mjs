import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n } from '../server/i18n.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pt = () => globalThis.MC_I18N_CATALOGS?.pt ?? {};
const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
const literal = raw => Function(`"use strict";return '${raw}';`)();
async function files(dir, accept) {
  const out = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    if (entry.isDirectory()) out.push(...await files(relative, accept));
    else if (accept(relative)) out.push(relative);
  }
  return out;
}

test('core: languages, exact keys, templates and fallback', () => {
  assert.equal(i18n.normalize('pt-BR'), 'pt');
  assert.equal(i18n.normalize('fr'), 'en');
  assert.equal(i18n.normalize(undefined), 'en');
  assert.equal(i18n.locale('pt'), 'pt-BR');
  globalThis.MC_I18N_CATALOGS.pt['__test {count} items__'] = '__teste {count} itens__';
  globalThis.MC_I18N_CATALOGS.pt['__test exact__'] = '__teste exato__';
  try {
    assert.equal(i18n.t('pt', '__test {count} items__', { count: 3 }), '__teste 3 itens__');
    assert.equal(i18n.t('en', '__test {count} items__', { count: 3 }), '__test 3 items__');
    assert.equal(i18n.translate('pt', '__test 7 items__'), '__teste 7 itens__');
    assert.equal(i18n.translate('pt', '__test exact__'), '__teste exato__');
    assert.equal(i18n.translate('en', '__test exact__'), '__test exact__');
    assert.equal(i18n.translate('pt', 'Unknown sentence.'), 'Unknown sentence.');
    assert.equal(i18n.t('pt', 'Unknown {x}', { x: 1 }), 'Unknown 1');
  } finally {
    delete globalThis.MC_I18N_CATALOGS.pt['__test {count} items__'];
    delete globalThis.MC_I18N_CATALOGS.pt['__test exact__'];
  }
});

test('Portuguese catalog keeps the same placeholders as each English key', () => {
  const wrong = Object.entries(pt()).filter(([k, v]) => typeof v !== 'string' || !v.trim() || placeholders(k).join() !== placeholders(v).join());
  assert.deepEqual(wrong.map(([k]) => k), []);
});

test('every literal t() key used by the interface has a Portuguese entry', async () => {
  const source = await readFile(path.join(root, 'public/app.js'), 'utf8');
  const keys = new Set([...source.matchAll(/(?<![\w$.])t\('((?:[^'\\]|\\.)*)'/g)].map(m => literal(m[1])));
  assert.ok(keys.size > 50, 'the interface should route its text through t()');
  const missing = [...keys].filter(k => !Object.prototype.hasOwnProperty.call(pt(), k));
  assert.deepEqual(missing, []);
});

test('every literal server error message has a Portuguese entry', async () => {
  const sources = await files('server', f => /\.(mjs|ts)$/.test(f) && !/\.test\.mjs$/.test(f) && f !== 'server/i18n.mjs');
  const missing = [];
  for (const file of sources) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const m of source.matchAll(/(?:(?:AppError|(?<![.\w])error|new Error)\(\s*|(?:GatewayError|GatewayClientError|startupError|identityError)\(\s*'[A-Z_]+',\s*)'((?:[^'\\\n]|\\.)*)'/g)) {
      const key = literal(m[1]);
      if (!Object.prototype.hasOwnProperty.call(pt(), key)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('English is the source language: no Portuguese text left in code outside the catalogs', async () => {
  const accented = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ]/;
  // Portuguese words are allowed only where the workspace layout declares its Portuguese aliases.
  const allowed = new Set(['server/workspace-core/layout.ts']);
  const sources = [
    'public/app.js', 'public/index.html', 'public/brand.js', 'public/i18n.js',
    ...await files('server', f => /\.(mjs|ts)$/.test(f) && !/\.test\.mjs$/.test(f)),
    ...await files('demo', f => /\.mjs$/.test(f)),
    'Dockerfile', 'docker-compose.yml', '.env.example',
  ].filter(f => !allowed.has(f));
  const found = [];
  for (const file of sources) {
    const lines = (await readFile(path.join(root, file), 'utf8')).split('\n');
    lines.forEach((line, i) => { if (accented.test(line)) found.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(found, []);
});

test('the two Portuguese catalogs never give different translations for the same key', async () => {
  const { runInNewContext } = await import('node:vm');
  const load = async file => { const context = {}; context.globalThis = context; runInNewContext(await readFile(path.join(root, file), 'utf8'), context); return context.MC_I18N_CATALOGS.pt; };
  const ui = await load('public/locales/pt.js'), messages = await load('public/locales/pt-messages.js');
  const conflicts = Object.keys(ui).filter(k => Object.hasOwn(messages, k) && ui[k] !== messages[k]);
  assert.deepEqual(conflicts, []);
});
