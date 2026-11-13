export type Fields = Record<string, unknown>;
export interface Link { label: string; target: string; href?: string; blocked?: string }
export interface Item { id: string; path: string; version: string; fields: Fields; body: string; links: Link[]; final?: Link }
export type UnitKind = 'projeto' | 'cliente' | 'agente' | 'sistema';
export interface Project { name: string; kind?: UnitKind; status?: string; state?: string; next?: string; stateFile?: string; source?: string; summary?: string }
/** Folder names the dashboard uses for this workspace (see layout.ts), so the interface can show and link them. */
export interface LayoutInfo { lang: 'en' | 'pt'; tasks: string; projects: string; agents: string; system: string; state: string; priorities: string; attachments: string }
export interface Snapshot { items: Item[]; projects: Project[]; priorities: { ids: string[]; version: string }; warnings: string[]; today: string; generalProjects: string[]; layout: LayoutInfo }
export interface ChildInput { titulo: string; projeto: string; tipo: string; slots_usuario: string; slots_execucao: string; dono: string; prazo: string; depende_de: string[]; status: string }
export interface CreateInput { titulo: string; projeto: string; tipo: string; dono: string; prazo: string; slots_usuario: string; slots_execucao: string; contexto: string }
export type Mutation = { action: 'complete'; id: string; version: string } | { action: 'reopen'; id: string; version: string } | { action: 'assign'; id: string; version: string; dono: string } | { action: 'document'; id: string; version: string; target: string } | { action: 'priorities'; ids: string[]; version: string } | { action: 'split'; id: string; version: string; children: ChildInput[]; parentStatus: string; confirmed: boolean } | { action: 'delete'; id: string; version: string; detach?: boolean } | { action: 'create'; version: string; task: CreateInput; confirmed: boolean };
export const str = (v: unknown): string => v == null ? '' : Array.isArray(v) ? v.map(String).join(', ') : String(v);
export const completed = (item: Item): boolean => ['feito', 'arquivado'].includes(str(item.fields.status));
