# Workspace format

The dashboard reads and writes a Markdown workspace that is its own Git repository.
The workspace can be laid out in English or in Portuguese; the dashboard accepts both.
Never point the dashboard at this template's repository: code and operational data
stay separate. The workspace files belong to the installation's owner and never go
into the template.

## Choosing the language

Set `MC_WORKSPACE_LAYOUT` in the service configuration:

- `auto` (default): if `tasks/` exists, the English layout; otherwise, if `tarefas/`
  exists, the Portuguese layout; if neither exists, English.
- `en`: always the English layout.
- `pt`: always the Portuguese layout.

The layout decides the **folder and file names**. Inside the files, the dashboard
accepts field names, values and headings in either language, whatever the layout.
Keep each file in one language: do not mix English and Portuguese keys in the same file.

When the dashboard **creates** a file (a task, a subtask, the priority list), it
writes it in the layout's language. When it **edits** an existing file, it keeps
that file's own language.

## Folders and files

| English | Portuguese | What it holds |
|---|---|---|
| `tasks/` | `tarefas/` | One Markdown file per task, plus the priority list |
| `tasks/_priorities.md` | `tarefas/_prioridades.md` | Priority order: a frontmatter `ids:` list |
| `projects/` | `projetos/` | One folder per project |
| `projects/<p>/clients/<c>/` | `projetos/<p>/clientes/<c>/` | Clients served by a project |
| `agents/` | `agentes/` | One folder per agent |
| `system/` | `sistema/` | The workspace's own state |
| `research/` | `pesquisas/` | Research that does not belong to a single project |
| `resources/` | `recursos/` | Reusable material |
| `STATE.md` | `ESTADO.md` | A unit's state file |
| `NEXT.md` | `PROXIMOS.md` | Legacy next-steps file, read only when the state file has no next-steps section |
| `MEMORY.md`, `memory/` | `MEMORY.md`, `memory/` | An agent's memory, in `agents/<id>/` |

Empty folders may not show up in Git; create only the ones you use.

## Units and state files

A **unit** is a folder with a state file (`STATE.md` or `ESTADO.md`; both names are
accepted in either layout): a project (`projects/<name>/`), a
subproject (`projects/<name>/<sub>/`), a client (`projects/<name>/clients/<client>/`),
an agent (`agents/<id>/`, only when it has a state file) or the system (`system/`).
The unit's name is its folder name, and it must match the `project:` value of its
tasks exactly. If two units share a name, the first one found wins, in this order:
projects, subprojects, clients, agents, system.

A state file has a title, a status line near the top, a description and the next steps:

```markdown
# Example project

**Status:** active

## What it is
A short description of the project.

## Next steps
- [ ] Try the dashboard with a test workspace
```

- The status line comes before the first `##` section. The word `Status` is the
  same in both languages; `> Status: active · Last updated: 2026-11-13`, a list item
  or a frontmatter `status:` line also work. The older format, a `## Status` or
  `## Current status` section whose first line is the status, is still read.
- `## What it is` | `## O que é` describes the unit.
- `## Next steps` | `## Próximos passos` is accepted in any layout. The dashboard
  shows that section as written, without completed items (`- [x]`).
- `NEXT.md` | `PROXIMOS.md` is read only when the state file has no next-steps section.

| Status (English) | Status (Portuguese) |
|---|---|
| `idea` | `ideia` |
| `active` | `ativo` |
| `paused` | `pausado` |
| `closed` | `encerrado` |
| `building` | `em construção` |
| `archived` | `arquivado` |

## Tasks

A task is a Markdown file `tasks/<id>.md`: YAML frontmatter followed by free text.
`id` (letters, digits, `-` and `_`, unique) and `title` are required.
Files whose names start with `_` or `.` are not tasks.

| English key | Portuguese key | Meaning |
|---|---|---|
| `id` | `id` | Unique identifier, usually the file name without `.md` |
| `title` | `titulo` | Title |
| `project` | `projeto` | The unit's name (its folder name) |
| `type` | `tipo` | Kind of item (values below) |
| `status` | `status` | Open, done or archived (values below) |
| `owner` | `dono` | Who does it; your own identifier is `ownerId` in `public/brand.js` |
| `user_slots` | `slots_usuario` | Owner's effort, in 30-minute slots |
| `exec_slots` | `slots_execucao` | Execution effort (agents), in 30-minute slots |
| `due` | `prazo` | `YYYY-MM-DD`, or `—` when there is none |
| `depends_on` | `depende_de` | List of task IDs this task waits for |
| `final_document` | `documento_final` | Path of the deliverable, relative to the workspace |
| `origin` | `origem` | Where the task came from: `mission-control`, or the parent task's ID for a subtask |
| `created` | `criado` | Creation date |
| `updated` | `atualizado` | Last update date |
| `confidence` | `confianca` | How settled the task is |
| `links` items `{label, target}` | `links` items `{rotulo, destino}` | Related documents; without this field, the Markdown links in the text are used |

| Field | English values | Portuguese values |
|---|---|---|
| `status` | `open`, `done`, `archived` | `aberto`, `feito`, `arquivado` |
| `type` | `task`, `improvement`, `idea`, `research`, `decision` | `tarefa`, `melhoria`, `ideia`, `pesquisa`, `decisao` |
| `confidence` | `to-confirm` | `a-confirmar` |

The dashboard also recognizes the status values `waiting` | `aguardando`,
`parked` | `estacionado` and `delivered-review` | `entregue-revisar`; the types
`conversation` | `conversa` and `reminder` | `lembrete`; and the confidence values
`high` | `alta`, `medium` | `media` and `low` | `baixa`. Other values are kept as written.

An example task in an English workspace. A Portuguese workspace uses the
Portuguese keys and values from the tables above.

```yaml
---
id: 2026-11-13-try-the-dashboard
title: Try the dashboard
project: example
type: task
status: open
owner: user
user_slots: '1'
exec_slots: '0'
due: '—'
depends_on: []
origin: [mission-control]
created: 2026-11-13
updated: 2026-11-13
confidence: to-confirm
---
What to do, and how to know it is done.
```

A slot is 30 minutes; use `—` when the effort is not known yet. Tasks created in the
dashboard get an ID made of the date and the title (`YYYY-MM-DD-<title>`),
`origin: [mission-control]` and `confidence: to-confirm`.

The priority list is `tasks/_priorities.md` | `tarefas/_prioridades.md`; its
frontmatter `ids:` list holds task IDs, most important first:

```yaml
---
ids:
  - 2026-11-13-try-the-dashboard
updated: 2026-11-13
---
```

## Writing to the workspace

The dashboard records every change as a Git commit. Writes require:

- an independent Git repository, initialized, with a first commit;
- an active branch (not a detached `HEAD`);
- `user.email` configured in that repository;
- no conflicts, and no uncommitted local changes in the files being changed.

The dashboard's commits use the workspace repository's `user.email`, with the
author name `<user.name> (via Mission Control)` taken from the same repository.
The backend also records the authenticated person in its own audit log.
If a write is interrupted, follow [Recovery](INSTALL.md#recovery) in the install guide.

## Attachments

Files attached in the dashboard's chat are stored in the workspace, and the agent
receives their path as it sees it. `MC_GATEWAY_WORKSPACE` must therefore be the
path at which your agents see this same workspace, so that attachments land in the
right place.

| Choice in the dashboard | Where the file goes (English layout) | Portuguese layout |
|---|---|---|
| Temporary (default) | `.tmp/anexos/<agent>/<date>/`, deleted after 3 days | same |
| Keep in the agent's folder | `agents/<id>/attachments/<date>/` | `agentes/<id>/anexos/<date>/` |

Add `.tmp/` and `agents/*/attachments/` (or `agentes/*/anexos/`) to your
workspace's own `.gitignore`, so attachments do not end up in its Git history.

