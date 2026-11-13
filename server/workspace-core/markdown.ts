// Mission Control: Markdown format of the workspace (frontmatter and unit state files).
import { createHash } from 'node:crypto';
import { parseDocument, isMap } from 'yaml';
import type { Fields, Project } from './shared.ts';

export const hash = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
// "Today" follows the server's TZ environment variable (set it in the service configuration).
export function today(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function parseMarkdown(raw: string): { fields: Fields; body: string; yaml: string; prefix: string; suffix: string } {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---[^\S\r\n]*(?:\r?\n|$))/m.exec(raw);
  if (!match || match.index !== 0) throw new Error('Missing or invalid frontmatter');
  const yaml = match[2];
  // Existing files contain unquoted ': ' in plain top-level scalar values.
  // Normalize only the in-memory parsing input; never rewrite the original YAML.
  const compatible = yaml.replace(/^([\w-]+:[ \t]+)([^\r\n]+)$/gm, (line, key: string, value: string) => {
    if (!/^[\s[\]{|>"'&*!]/.test(value) && /:\s/.test(value)) {
      const parts = /^(.*?)(\s+#.*)?$/.exec(value)!;
      return key + JSON.stringify(parts[1]) + (parts[2] ?? '');
    }
    return line;
  });
  const doc = parseDocument(compatible, { uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('Invalid frontmatter');
  const fields = doc.toJS({ maxAliasCount: 50 }) as Fields;
  return { fields, body: raw.slice(match[0].length), yaml, prefix: match[1], suffix: match[3] };
}
export function patchMarkdown(raw: string, changes: Fields): string {
  const parsed = parseMarkdown(raw);
  const newline = parsed.prefix.includes('\r\n') ? '\r\n' : '\n';
  let yaml = parsed.yaml;
  for (const [key, value] of Object.entries(changes)) {
    if (!/^[a-z_]+$/.test(key)) throw new Error('Invalid field');
    const entry = new RegExp(`^${key}:[^\\r\\n]*`, 'm');
    const found = entry.exec(yaml);
    const serialized = JSON.stringify(value);
    if (found) {
      const tail = yaml.slice(found.index + found[0].length);
      const next = /^(?:[a-zA-Z_][\w-]*|"[^"\n]+"|'[^'\n]+'):/m.exec(tail);
      const end = next ? found.index + found[0].length + next.index : yaml.length;
      const old = yaml.slice(found.index, end);
      const lines = old.split(/\r?\n/);
      const comment = yamlComment(lines[0]);
      // Preserve standalone comments, and lift comments on removed list values
      // onto their own lines so no history is lost when appending dependencies.
      const preserved = lines.slice(1).flatMap(line => {
        if (!line.trim()) return [line];
        if (/^\s*#/.test(line)) return [line];
        const comment = yamlComment(line);
        return comment ? [comment] : [];
      });
      if (preserved.at(-1) === '') preserved.pop();
      const replacement = `${key}: ${serialized}${comment ? ' ' + comment : ''}${newline}${preserved.length ? preserved.join(newline) + newline : ''}`;
      yaml = yaml.slice(0, found.index) + replacement + yaml.slice(end);
    } else yaml += `${key}: ${serialized}${newline}`;
  }
  const result = parsed.prefix + yaml + parsed.suffix + parsed.body;
  parseMarkdown(result);
  return result;
}
export function newMarkdown(fields: Fields, body: string): string {
  return '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`).join('') + '---\n' + body;
}

// Context of a unit (project, client, agent or system) read from its single state file (STATE.md or ESTADO.md).
const headingLevel = (line: string): number => /^(#{1,6})[ \t]/.exec(line)?.[1].length ?? 0;
const headingText = (line: string): string => line.replace(/^#{1,6}[ \t]+/, '').replace(/[ \t#]+$/, '');
// "## Next steps" or its Portuguese equivalent ("## Proximos passos", with or without the accent), in any layout.
const nextSteps = /^(?:next[ \t]+steps|pr[\u00f3o]ximos[ \t]+passos)(?![\p{L}\p{N}])/iu;
const doneStep = /^\s*[-*+][ \t]+\[[xX]\]/;
const ruleLine = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const statusLine = /^(?:>[ \t]*)?(?:[-*+][ \t]+)?(?:\*\*|__)?status(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*(\S.*)$/i;
const plain = (s: string): string | undefined => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().slice(0, 240) || undefined;
/** The excerpt shown in the dashboard: non-empty lines, no quotes, up to 9 lines and 900 characters. */
const excerpt = (lines: string[]): string | undefined => lines.filter(l => l.trim() && !l.startsWith('>')).slice(0, 9).join('\n').slice(0, 900) || undefined;
/** Excerpt of a state or next-steps file: from the first "## " heading on, skipping any preamble. */
export function sectionExcerpt(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/), first = lines.findIndex(l => headingLevel(l) === 2);
  return excerpt(first >= 0 ? lines.slice(first) : lines);
}
function statusOf(lines: string[]): string | undefined {
  // Status line near the top, before the first section: "> Status: active · Last updated: …".
  // Bold (**Status:**), a list item or a `status:` frontmatter line also count.
  for (const line of lines.slice(0, 40)) {
    if (headingLevel(line) === 2) break;
    const found = statusLine.exec(line.trim());
    if (found) return plain(found[1]);
  }
  // Older format: a "## Status" (or "## Current status") section, whose first text line counts.
  const at = lines.findIndex(l => headingLevel(l) === 2 && /^(?:current[ \t]+)?status\b/i.test(headingText(l)));
  for (const line of at < 0 ? [] : lines.slice(at + 1)) {
    if (headingLevel(line)) break;
    if (line.trim()) return plain(line.trim().replace(/^>[ \t]*/, '').replace(/^[-*+][ \t]+/, ''));
  }
  return undefined;
}
/** Status, state (without the queue) and next steps (the "## Next steps" section, with its subsections). */
export function unitContext(raw: string): Pick<Project, 'status' | 'state' | 'next'> {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex(l => headingLevel(l) === 2 && nextSteps.test(headingText(l)));
  const after = start < 0 ? -1 : lines.findIndex((l, i) => i > start && headingLevel(l) > 0 && headingLevel(l) <= 2);
  const end = after < 0 ? lines.length : after;
  const state = sectionExcerpt((start < 0 ? lines : [...lines.slice(0, start), ...lines.slice(end)]).join('\n'));
  // Completed items ("- [x]") and table rules are not next steps.
  const next = start < 0 ? undefined : excerpt(lines.slice(start + 1, end).filter(l => !doneStep.test(l) && !ruleLine.test(l)));
  return { status: statusOf(lines), state, next };
}

function yamlComment(line: string): string | undefined {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === '"' && c === '\\') { i++; continue; }
    if (quote) { if (c === quote) { if (quote === "'" && line[i + 1] === "'") i++; else quote = ''; } }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(i);
  }
  return undefined;
}
