#!/usr/bin/env node
// Task board tooling for AI Business OS. Wraps the gh CLI.
//
//   node scripts/board.mjs list [arsh|saina]   show open tasks, with what blocks each
//   node scripts/board.mjs next <arsh|saina>   show tasks you can start now, in order
//   node scripts/board.mjs claim <ID>          assign yourself, mark it in progress
//   node scripts/board.mjs done <ID>           clear the in-progress mark (the pull request closes the issue)
//   node scripts/board.mjs render              rewrite the task tables in docs/WORKPLAN.md from tasks.json
//   node scripts/board.mjs sync                make the board Status column match the issues
//
// One-time setup commands (already run when the repo was created):
//   setup-labels, setup-issues, setup-project
//
// Source of truth: scripts/tasks.json for what a task is, GitHub Issues for its state.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const TASKS = join(here, 'tasks.json');
const MAP = join(here, 'issue-map.json');
const WORKPLAN = join(root, 'docs', 'WORKPLAN.md');

const { phases, tasks } = JSON.parse(readFileSync(TASKS, 'utf8'));
const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));
const loadMap = () => (existsSync(MAP) ? JSON.parse(readFileSync(MAP, 'utf8')) : { issues: {}, project: null });
const saveMap = (m) => writeFileSync(MAP, JSON.stringify(m, null, 2) + '\n');

const gh = (args, opts = {}) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryGh = (args) => { try { return gh(args); } catch (e) { return null; } };
const repo = () => gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);

const OWNER_NAME = { arsh: 'Arsh', saina: 'Saina', both: 'Arsh and Saina' };
const SIZE_NOTE = { S: 'S (under 1 hour)', M: 'M (1 to 3 hours)', L: 'L (3 to 5 hours)' };
const titleOf = (t) => `${t.id}: ${t.title}`;
const labelsOf = (t) => [`owner:${t.owner}`, `lane:${t.lane}`, `tier:${t.tier}`, ...(t.human ? ['human'] : []), ...(t.contract ? ['contract'] : [])];

function bodyOf(t, map) {
  const dep = (id) => (map.issues[id] ? `#${map.issues[id]} (${id})` : id);
  const lines = [
    `**Owner:** ${OWNER_NAME[t.owner]} | **Phase:** ${phases[t.phase]} | **Size:** ${SIZE_NOTE[t.size]} | **Tier:** ${t.tier.toUpperCase()}`,
    '',
    `**Depends on:** ${t.deps.length ? t.deps.map(dep).join(', ') : 'nothing'}`,
    `**Acceptance criteria served:** ${t.acs.length ? t.acs.join(', ') : 'none directly'}`,
    `**Needs a person:** ${t.human ? 'yes. Part of this cannot be done by an agent alone (accounts, a phone call, a payment on a second device, or a rehearsal).' : 'no'}`,
    '',
    '### Done when',
    ...t.done.map((d) => `- [ ] ${d}`),
    '',
    '### Directories this task owns',
    ...(t.paths.length ? t.paths.map((p) => `- \`${p}\``) : ['- none (no code)']),
    '',
    'A worker on this task stays inside these paths. If the work needs a change elsewhere, open an issue labelled `needs:arsh` or `needs:saina` instead of editing it.',
    '',
    '### Read first',
    ...t.read.map((r) => `- ${r}`),
    '- `AGENTS.md` for the working rules',
    '',
    `Branch: \`${t.owner === 'both' ? 'shared' : t.owner}/${t.id}-short-name\`. Close this issue from the pull request with \`Closes #<this issue>\`.`,
  ];
  return lines.join('\n');
}

function writeTemp(text) {
  const f = join(mkdtempSync(join(tmpdir(), 'board-')), 'body.md');
  writeFileSync(f, text);
  return f;
}

function fetchIssues() {
  const raw = gh(['issue', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title,state,labels,assignees,url']);
  const out = {};
  for (const i of JSON.parse(raw)) {
    const m = /^([SBU]-\d\d):/.exec(i.title);
    if (m) out[m[1]] = { ...i, labels: i.labels.map((l) => l.name), assignees: i.assignees.map((a) => a.login) };
  }
  return out;
}

const cmds = {
  'setup-labels'() {
    const labels = [
      ['owner:arsh', '1d76db', 'Arsh does this'], ['owner:saina', 'd93f0b', 'Saina does this'], ['owner:both', '5319e7', 'Both leads together'],
      ['lane:backend', 'c5def5', 'Payments, voice, approvals, webhooks, Google'], ['lane:ui', 'fbca04', 'apps/web'], ['lane:builder', 'f9d0c4', 'apps/server/src/builder'], ['lane:shared', 'bfdadc', 'Repo, contracts, integration, rehearsal'],
      ['tier:must', 'b60205', 'Full PRD P0 scope'], ['tier:should', 'e99695', 'PRD P1 items'],
      ['human', '000000', 'Part of this needs a person, not an agent'], ['contract', '0e8a16', 'Changes packages/contracts; the other lead must approve'],
      ['status:doing', '0052cc', 'Someone is working on this now'], ['status:blocked', 'e11d21', 'Cannot proceed; see the comment'],
      ['needs:arsh', '1d76db', 'Saina needs something from Arsh'], ['needs:saina', 'd93f0b', 'Arsh needs something from Saina'],
    ];
    for (const [name, color, description] of labels) gh(['label', 'create', name, '--color', color, '--description', description, '--force']);
    const r = repo();
    const existing = JSON.parse(gh(['api', `repos/${r}/milestones?state=all&per_page=100`])).map((m) => m.title);
    for (const title of Object.values(phases)) if (!existing.includes(title)) gh(['api', `repos/${r}/milestones`, '-f', `title=${title}`]);
    console.log(`labels: ${labels.length}, milestones: ${Object.keys(phases).length}`);
  },

  'setup-issues'() {
    const map = loadMap();
    const existing = fetchIssues();
    for (const t of tasks) {
      if (existing[t.id]) { map.issues[t.id] = existing[t.id].number; continue; }
      const url = gh(['issue', 'create', '--title', titleOf(t), '--body-file', writeTemp(bodyOf(t, map)), '--label', labelsOf(t).join(','), '--milestone', phases[t.phase]]);
      map.issues[t.id] = Number(url.split('/').pop());
      console.log(`created ${t.id} -> #${map.issues[t.id]}`);
      saveMap(map);
    }
    saveMap(map);
    // Second pass: now every issue number is known, so dependencies become links.
    for (const t of tasks) gh(['issue', 'edit', String(map.issues[t.id]), '--body-file', writeTemp(bodyOf(t, map))]);
    console.log(`issues in map: ${Object.keys(map.issues).length}`);
  },

  // Needs the "project" scope:  gh auth refresh -s project
  'setup-project'(collaborator) {
    const map = loadMap();
    const r = repo();
    const owner = r.split('/')[0];
    if (!map.project) {
      const p = JSON.parse(gh(['project', 'create', '--owner', owner, '--title', 'AI Business OS', '--format', 'json']));
      map.project = { number: p.number, id: p.id, url: p.url, items: {} };
      saveMap(map);
      gh(['project', 'link', String(p.number), '--owner', owner, '--repo', r]);
    }
    const P = map.project;
    const num = String(P.number);
    const fields = () => JSON.parse(gh(['project', 'field-list', num, '--owner', owner, '--format', 'json'])).fields;
    const ensure = (name, options) => {
      if (!fields().some((f) => f.name === name)) gh(['project', 'field-create', num, '--owner', owner, '--name', name, '--data-type', 'SINGLE_SELECT', '--single-select-options', options.join(',')]);
      return fields().find((f) => f.name === name);
    };
    const fOwner = ensure('Owner', ['Arsh', 'Saina', 'Both']);
    const fPhase = ensure('Phase', Object.keys(phases));
    const fTier = ensure('Tier', ['MUST', 'SHOULD']);
    const fStatus = fields().find((f) => f.name === 'Status');
    P.fields = { status: fStatus.id, statusOptions: Object.fromEntries(fStatus.options.map((o) => [o.name, o.id])) };
    const opt = (f, name) => f.options.find((o) => o.name === name).id;
    const setField = (item, f, name) => gh(['project', 'item-edit', '--id', item, '--project-id', P.id, '--field-id', f.id, '--single-select-option-id', opt(f, name)]);
    for (const t of tasks) {
      if (!P.items[t.id]) {
        const item = JSON.parse(gh(['project', 'item-add', num, '--owner', owner, '--url', `https://github.com/${r}/issues/${map.issues[t.id]}`, '--format', 'json']));
        P.items[t.id] = item.id;
        setField(item.id, fOwner, { arsh: 'Arsh', saina: 'Saina', both: 'Both' }[t.owner]);
        setField(item.id, fPhase, t.phase);
        setField(item.id, fTier, t.tier.toUpperCase());
        setField(item.id, fStatus, 'Todo');
        saveMap(map);
        console.log(`board: added ${t.id}`);
      }
    }
    if (collaborator) {
      const userId = gh(['api', `users/${collaborator}`, '--jq', '.node_id']);
      gh(['api', 'graphql', '-f', `query=mutation { updateProjectV2Collaborators(input: {projectId: "${P.id}", collaborators: [{userId: "${userId}", role: WRITER}]}) { clientMutationId } }`]);
      console.log(`board: ${collaborator} can edit`);
    }
    saveMap(map);
    console.log(`board: ${P.url} with ${Object.keys(P.items).length} items`);
  },

  list(owner) {
    const issues = fetchIssues();
    for (const t of tasks) {
      const i = issues[t.id];
      if (!i || i.state === 'CLOSED') continue;
      if (owner && t.owner !== owner && t.owner !== 'both') continue;
      const blockers = t.deps.filter((d) => issues[d] && issues[d].state !== 'CLOSED');
      const mark = i.labels.includes('status:doing') ? 'DOING' : blockers.length ? 'blocked' : 'ready';
      console.log(`${t.id}  #${String(i.number).padEnd(3)} ${mark.padEnd(7)} ${t.phase} ${t.tier.padEnd(6)} ${t.owner.padEnd(5)} ${t.title}${blockers.length ? `  [waits on ${blockers.join(', ')}]` : ''}`);
    }
  },

  next(owner) {
    if (!owner) throw new Error('usage: next <arsh|saina>');
    const issues = fetchIssues();
    const ready = tasks.filter((t) => {
      const i = issues[t.id];
      return i && i.state !== 'CLOSED' && (t.owner === owner || t.owner === 'both') && !i.labels.includes('status:doing') && t.deps.every((d) => issues[d] && issues[d].state === 'CLOSED');
    });
    ready.sort((a, b) => a.phase.localeCompare(b.phase) || (a.tier === b.tier ? 0 : a.tier === 'must' ? -1 : 1) || a.id.localeCompare(b.id));
    if (!ready.length) { console.log('Nothing is ready. Run "list" to see what blocks you.'); return; }
    for (const t of ready) console.log(`${t.id}  #${issues[t.id].number}  ${t.phase} ${t.tier} ${t.size}${t.human ? ' human' : ''}  ${t.title}`);
    console.log('\nTasks listed together do not depend on each other, so separate workers can take them at the same time.');
  },

  claim(id) {
    const t = taskById[id];
    if (!t) throw new Error(`unknown task ${id}`);
    const map = loadMap();
    const n = String(map.issues[id]);
    gh(['issue', 'edit', n, '--add-assignee', '@me', '--add-label', 'status:doing']);
    setBoardStatus(map, id, 'In Progress');
    console.log(`claimed ${id} (#${n}). Branch: ${t.owner === 'both' ? 'shared' : t.owner}/${id}-short-name`);
  },

  done(id) {
    const map = loadMap();
    if (!map.issues[id]) throw new Error(`unknown task ${id}`);
    tryGh(['issue', 'edit', String(map.issues[id]), '--remove-label', 'status:doing']);
    console.log(`${id}: in-progress mark cleared. The issue closes when its pull request merges with "Closes #${map.issues[id]}".`);
  },

  // Make the board's Status column match the issues: closed is Done,
  // status:doing is In Progress, everything else is Todo.
  sync() {
    const map = loadMap();
    const issues = fetchIssues();
    const tally = { Done: 0, 'In Progress': 0, Todo: 0 };
    for (const t of tasks) {
      const i = issues[t.id];
      if (!i) continue;
      const name = i.state === 'CLOSED' ? 'Done' : i.labels.includes('status:doing') ? 'In Progress' : 'Todo';
      setBoardStatus(map, t.id, name);
      tally[name]++;
    }
    console.log(`board synced: ${tally.Done} done, ${tally['In Progress']} in progress, ${tally.Todo} to do`);
  },

  render() {
    const map = loadMap();
    const link = (id) => (map.issues[id] ? `#${map.issues[id]}` : '');
    let out = '';
    for (const [key, name] of Object.entries(phases)) {
      const rows = tasks.filter((t) => t.phase === key);
      out += `\n### Phase ${name}\n\n| ID | Task | Owner | Size | Tier | Depends on | Serves | Person | Issue |\n|---|---|---|---|---|---|---|---|---|\n`;
      for (const t of rows) out += `| ${t.id} | ${t.title} | ${OWNER_NAME[t.owner]} | ${t.size} | ${t.tier.toUpperCase()} | ${t.deps.join(', ') || 'none'} | ${t.acs.join(', ') || ''} | ${t.human ? 'yes' : ''} | ${link(t.id)} |\n`;
    }
    let ac = '\n| Criterion | Tasks that deliver it |\n|---|---|\n';
    for (let n = 1; n <= 20; n++) {
      const id = `AC-${String(n).padStart(2, '0')}`;
      ac += `| ${id} | ${tasks.filter((t) => t.acs.includes(id)).map((t) => t.id).join(', ')} |\n`;
    }
    const count = (f) => tasks.filter(f).length;
    const totals = `\n${tasks.length} tasks: ${count((t) => t.owner === 'arsh')} for Arsh, ${count((t) => t.owner === 'saina')} for Saina, ${count((t) => t.owner === 'both')} for both together. ${count((t) => t.tier === 'must')} are MUST and ${count((t) => t.tier === 'should')} are SHOULD. ${count((t) => t.human)} need a person for part of the work.\n`;
    let md = readFileSync(WORKPLAN, 'utf8');
    const put = (tag, text) => { md = md.replace(new RegExp(`(<!-- ${tag}:START -->)[\\s\\S]*?(<!-- ${tag}:END -->)`), `$1\n${text}\n$2`); };
    put('TOTALS', totals);
    put('TASKS', out);
    put('ACS', ac);
    writeFileSync(WORKPLAN, md);
    console.log('docs/WORKPLAN.md task tables rewritten');
  },
};

function setBoardStatus(map, id, name) {
  const P = map.project;
  if (!P || !P.items?.[id] || !P.fields?.statusOptions?.[name]) return;
  // Works only if this gh login has the "project" scope. The issue label is the fallback signal.
  tryGh(['project', 'item-edit', '--id', P.items[id], '--project-id', P.id, '--field-id', P.fields.status, '--single-select-option-id', P.fields.statusOptions[name]]);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) {
  console.log('usage: node scripts/board.mjs <list|next|claim|done|sync|render> [arg]');
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](...args);
