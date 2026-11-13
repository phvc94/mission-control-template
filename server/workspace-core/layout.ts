// Workspace layout: folder, file, field and value names in English or Portuguese.
// The dashboard accepts both. Folder names come from one layout per workspace (MC_WORKSPACE_LAYOUT=auto|en|pt);
// field names, values and headings inside files are accepted in either language.
// Internally (and in the HTTP API) task fields use canonical keys, which are the Portuguese ones.
import path from 'node:path';
import { lstatSync } from 'node:fs';
import type { Fields } from './shared.ts';

export type LayoutLang = 'en' | 'pt';
export interface Layout {
  lang: LayoutLang;
  tasks: string; projects: string; agents: string; system: string; research: string; resources: string;
  clients: string; state: string; legacyNext: string; priorities: string; attachments: string;
}
export const layouts: Readonly<Record<LayoutLang, Readonly<Layout>>> = Object.freeze({
  en: Object.freeze({ lang: 'en', tasks: 'tasks', projects: 'projects', agents: 'agents', system: 'system', research: 'research', resources: 'resources', clients: 'clients', state: 'STATE.md', legacyNext: 'NEXT.md', priorities: 'tasks/_priorities.md', attachments: 'attachments' }),
  pt: Object.freeze({ lang: 'pt', tasks: 'tarefas', projects: 'projetos', agents: 'agentes', system: 'sistema', research: 'pesquisas', resources: 'recursos', clients: 'clientes', state: 'ESTADO.md', legacyNext: 'PROXIMOS.md', priorities: 'tarefas/_prioridades.md', attachments: 'anexos' }),
});
const other = (lang: LayoutLang): LayoutLang => lang === 'en' ? 'pt' : 'en';
/** Top-level folders the document library may read, in both languages. */
export const contentRoots: readonly string[] = Object.freeze([...new Set((['en', 'pt'] as const).flatMap(l => [layouts[l].projects, layouts[l].tasks, layouts[l].research, layouts[l].system, layouts[l].resources, layouts[l].agents]))]);
/** State file names to look for in a unit folder: the layout's own name first, then the other language's. */
export const stateFiles = (layout: Layout): string[] => [layout.state, layouts[other(layout.lang)].state];
export const legacyNextFiles = (layout: Layout): string[] => [layout.legacyNext, layouts[other(layout.lang)].legacyNext];

const isDirectory = (full: string): boolean => { try { return lstatSync(full).isDirectory(); } catch { return false; } };
/** auto: tasks/ → English; tarefas/ → Portuguese; neither → English. */
export function resolveLayout(root: string, preference: string | undefined = process.env.MC_WORKSPACE_LAYOUT): Layout {
  const wanted = String(preference ?? 'auto').trim().toLowerCase() || 'auto';
  if (wanted === 'en' || wanted === 'pt') return layouts[wanted];
  if (wanted !== 'auto') throw Object.assign(new Error('MC_WORKSPACE_LAYOUT must be auto, en or pt.'), { status: 500 });
  if (isDirectory(path.join(root, layouts.en.tasks))) return layouts.en;
  if (isDirectory(path.join(root, layouts.pt.tasks))) return layouts.pt;
  return layouts.en;
}

/** Canonical (Portuguese) field key → English key. Keys not listed here (id, status, links, ids) are the same in both. */
export const englishField: Readonly<Record<string, string>> = Object.freeze({
  titulo: 'title', projeto: 'project', tipo: 'type', dono: 'owner', prazo: 'due', slots_usuario: 'user_slots', slots_execucao: 'exec_slots',
  depende_de: 'depends_on', documento_final: 'final_document', origem: 'origin', criado: 'created', atualizado: 'updated', confianca: 'confidence', contexto: 'context',
});
/** Canonical (Portuguese) value → English value, per field. Unknown values are kept as written. */
export const englishValue: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  status: Object.freeze({ aberto: 'open', feito: 'done', arquivado: 'archived', aguardando: 'waiting', estacionado: 'parked', 'entregue-revisar': 'delivered-review', 'a-confirmar': 'to-confirm' }),
  tipo: Object.freeze({ tarefa: 'task', melhoria: 'improvement', ideia: 'idea', pesquisa: 'research', decisao: 'decision', conversa: 'conversation', lembrete: 'reminder' }),
  confianca: Object.freeze({ alta: 'high', media: 'medium', baixa: 'low', 'a-confirmar': 'to-confirm' }),
});
const canonicalField = Object.freeze(Object.fromEntries(Object.entries(englishField).map(([pt, en]) => [en, pt])));
const canonicalValue = Object.freeze(Object.fromEntries(Object.entries(englishValue).map(([field, map]) => [field, Object.fromEntries(Object.entries(map).map(([pt, en]) => [en, pt]))])));

/**
 * Optional custom field names, from MC_TASK_FIELD_ALIASES="canonical=fileKey,...", for workspaces whose task files
 * use their own key for a field (for example `slots_usuario=my_slots`). Read and written in place of the standard key.
 */
export function fieldAliases(value: string | undefined = process.env.MC_TASK_FIELD_ALIASES): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const pair of String(value ?? '').split(',').map(p => p.trim()).filter(Boolean)) {
    const [canonical, custom] = pair.split('=').map(p => p.trim());
    if (!canonical || !custom || !/^[a-z_]+$/.test(canonical) || !/^[a-z_]+$/.test(custom) || !(canonical in englishField)) throw Object.assign(new Error('MC_TASK_FIELD_ALIASES must look like slots_usuario=my_slots,dono=owner_id.'), { status: 500 });
    out[canonical] = custom;
  }
  return out;
}
/** Language a task file is written in: English when it uses English keys and no Portuguese ones. */
export function fileLang(fields: Fields, fallback: LayoutLang): LayoutLang {
  const keys = Object.keys(fields);
  const en = keys.some(k => k in canonicalField), pt = keys.some(k => k in englishField);
  return en && !pt ? 'en' : pt && !en ? 'pt' : fallback;
}
/** Fields as the rest of the dashboard expects them: canonical keys and canonical values. */
export function toCanonical(fields: Fields, aliases: Readonly<Record<string, string>> = fieldAliases()): Fields {
  const custom = Object.fromEntries(Object.entries(aliases).map(([canonical, key]) => [key, canonical]));
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    const canonical = custom[key] ?? canonicalField[key] ?? key;
    if (canonical !== key && Object.hasOwn(fields, canonical)) continue; // A file mixing both keeps its canonical value.
    out[canonical] = value;
  }
  for (const [field, map] of Object.entries(canonicalValue)) {
    const value = out[field];
    if (typeof value === 'string' && Object.hasOwn(map, value)) out[field] = map[value];
  }
  return out;
}
/** Canonical fields translated to the language of the file being written. */
export function forFile(fields: Fields, lang: LayoutLang, aliases: Readonly<Record<string, string>> = fieldAliases()): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    const map = lang === 'en' ? englishValue[key] : undefined;
    const name = aliases[key] ?? (lang === 'en' ? englishField[key] ?? key : key);
    out[name] = typeof value === 'string' && map && Object.hasOwn(map, value) ? map[value] : value;
  }
  return out;
}

/** Text the dashboard writes into new workspace files, in the workspace's language. */
export const fileText = Object.freeze({
  en: Object.freeze({
    context: 'Context', done: 'Definition of done', doneBody: 'To be defined by the owner before execution.',
    created: 'Created in Mission Control.', subtask: (parent: string, link: string) => `Subtask of [${parent}](${link}), created by an explicit split in the dashboard.`,
    priorities: 'Priorities', fallbackTask: 'task', fallbackSubtask: 'subtask',
  }),
  pt: Object.freeze({
    context: 'Contexto', done: 'Critério de pronto', doneBody: 'A definir pelo responsável antes da execução.',
    created: 'Criada no Mission Control.', subtask: (parent: string, link: string) => `Subtarefa de [${parent}](${link}), criada por divisão explícita no painel.`,
    priorities: 'Prioridades', fallbackTask: 'tarefa', fallbackSubtask: 'subtarefa',
  }),
});
