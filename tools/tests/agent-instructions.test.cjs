'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '../..');
const workspace = path.resolve(project, '..');
const hasWorkspace = fs.existsSync(path.join(workspace, 'AGENTS.md')) &&
  fs.existsSync(path.join(workspace, '.opencode/instructions/workspace-conventions.md'));
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');
const readWorkspace = relative => fs.readFileSync(path.join(workspace, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(project, relative));
const fileSize = relative => fs.statSync(path.join(project, relative)).size;

const instructionFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursor/rules/project.mdc',
  '.github/copilot-instructions.md',
  '.github/instructions/project-routing.instructions.md',
  '.github/instructions/cross-project-protocol.instructions.md',
  '.agents/AGENTS.md',
  '.opencode/skills/customheadset-gxr/SKILL.md',
  '.opencode/skills/customheadset-gxr/workflow-add-feature.md',
  '.opencode/skills/customheadset-gxr/workflow-edit-behavior.md',
  '.opencode/skills/customheadset-gxr/workflow-fix-bug.md',
  '.opencode/skills/customheadset-gxr/references/runtime-evidence.md',
  '.opencode/skills/galaxyxr-workspace/SKILL.md',
  '.opencode/skills/galaxyxr-workspace/references/project-map.md',
  '.opencode/skills/cavecrew/SKILL.md',
  '.opencode/agents/cavecrew-investigator.md',
  '.opencode/agents/cavecrew-builder.md',
  '.opencode/agents/cavecrew-reviewer.md',
  '.codex/agents/cavecrew-investigator.toml',
  '.codex/agents/cavecrew-builder.toml',
  '.codex/agents/cavecrew-reviewer.toml',
];

test('canonical instruction files exist and stay within their size budgets', () => {
  const budgets = new Map([
    ['AGENTS.md', 9000],
    ['CLAUDE.md', 1500],
    ['.cursor/rules/project.mdc', 1800],
    ['.github/copilot-instructions.md', 2600],
    ['.github/instructions/project-routing.instructions.md', 2200],
    ['.github/instructions/cross-project-protocol.instructions.md', 2200],
    ['.agents/AGENTS.md', 1500],
    ['.opencode/skills/customheadset-gxr/SKILL.md', 4000],
    ['.opencode/skills/customheadset-gxr/workflow-add-feature.md', 2500],
    ['.opencode/skills/customheadset-gxr/workflow-edit-behavior.md', 2500],
    ['.opencode/skills/customheadset-gxr/workflow-fix-bug.md', 2500],
    ['.opencode/skills/customheadset-gxr/references/runtime-evidence.md', 3000],
    ['.opencode/skills/galaxyxr-workspace/SKILL.md', 4500],
    ['.opencode/skills/galaxyxr-workspace/references/project-map.md', 18000],
    ['.opencode/skills/cavecrew/SKILL.md', 4500],
    ['.opencode/agents/cavecrew-investigator.md', 3000],
    ['.opencode/agents/cavecrew-builder.md', 3000],
    ['.opencode/agents/cavecrew-reviewer.md', 3000],
    ['.codex/agents/cavecrew-investigator.toml', 1500],
    ['.codex/agents/cavecrew-builder.toml', 1500],
    ['.codex/agents/cavecrew-reviewer.toml', 1500],
  ]);
  for (const relative of instructionFiles) assert.ok(exists(relative), `missing ${relative}`);
  for (const [relative, budget] of budgets) {
    assert.ok(fileSize(relative) <= budget, `${relative} is ${fileSize(relative)} bytes; budget ${budget}`);
  }
  if (hasWorkspace) {
    assert.ok(fs.statSync(path.join(workspace, 'AGENTS.md')).size <= 8000, 'workspace AGENTS.md exceeds 8000 bytes');
    assert.ok(fs.statSync(path.join(workspace, '.opencode/skills/cavecrew/SKILL.md')).size <= 4500,
      'workspace cavecrew skill exceeds 4500 bytes');
  }
});

test('host adapters link to the canonical project contract without restating the settings defaults', () => {
  const adapters = [
    'CLAUDE.md',
    '.cursor/rules/project.mdc',
    '.github/copilot-instructions.md',
    '.github/instructions/project-routing.instructions.md',
    '.github/instructions/cross-project-protocol.instructions.md',
    '.agents/AGENTS.md',
  ];
  for (const relative of adapters) assert.match(read(relative), /AGENTS\.md/, `${relative} must link AGENTS.md`);
  for (const relative of adapters) {
    assert.doesNotMatch(read(relative), /Force CBR|Lifted-Blacks|Multi-Engine|SDR 10-bit baseline/,
      `${relative} must link the settings-authority table instead of copying it`);
  }
});

test('settings defaults live only in the canonical project AGENTS.md', () => {
  const canonical = read('AGENTS.md');
  const rows = [
    [/\| Lifted-Blacks Fix[^\n]*\| Off/, 'Lifted-Blacks default'],
    [/\| Force CBR \| Off/, 'Force CBR default'],
    [/\| Multi-Engine Encoding \| On/, 'Multi-Engine default'],
    [/\| SDR 10-bit baseline \| On/, 'SDR 10-bit baseline default'],
    [/\| `galaxyXr\.profileSupports10bit` \| User-owned/, 'profileSupports10bit ownership'],
    [/\| Image Enhancements \| On/, 'Image Enhancements default'],
    [/\| H\.264 tile \| 1024x4096/, 'H.264 tile class'],
  ];
  for (const [pattern, label] of rows) assert.match(canonical, pattern, `AGENTS.md missing ${label}`);
  for (const relative of instructionFiles.filter(relative => relative !== 'AGENTS.md')) {
    assert.doesNotMatch(read(relative), /Force CBR|Lifted-Blacks|Multi-Engine|SDR 10-bit baseline|profileSupports10bit/,
      `${relative} duplicates the settings-authority table`);
  }
  assert.doesNotMatch(canonical, /Force CBR is ON|Force CBR is On/, 'stale Force CBR default');
});

test('project policy requires explicit commit, push and deployment authorization', () => {
  const projectPolicy = read('AGENTS.md');
  assert.match(projectPolicy, /commits, pushes, release publication and manual workflow dispatch require explicit authorization/i,
    'project policy must require explicit commit/push/release authorization');
  assert.match(projectPolicy, /Standing authorization covers the documented allowlist/i,
    'project policy must scope standing authorization to routine cleanup');
});

test('workspace authorization agrees with the project contract', { skip: !hasWorkspace }, () => {
  const workspacePolicy = readWorkspace('AGENTS.md');
  const conventions = readWorkspace('.opencode/instructions/workspace-conventions.md');
  assert.match(workspacePolicy, /explicit user authorization/, 'workspace policy must require explicit authorization');
  assert.doesNotMatch(workspacePolicy, /Commit and push every completed change/i, 'stale standing commit rule');
  assert.doesNotMatch(conventions, /Commit and push every completed change/i, 'stale standing commit rule');
  assert.match(conventions, /AGENTS\.md/, 'workspace conventions must point to the canonical policy');
});

test('mirror skills are pointers to existing canonical files', () => {
  const pointers = [
    '.agents/skills/customheadset-gxr/SKILL.md',
    '.agents/skills/galaxyxr-workspace/SKILL.md',
    '.agents/skills/cavecrew/SKILL.md',
  ];
  for (const relative of pointers) {
    const text = read(relative);
    assert.match(text, /Canonical:/, `${relative} is not a canonical pointer`);
    const match = /\]\(([^)]+)\)/.exec(text);
    assert.ok(match, `${relative} has no canonical link`);
    const target = path.resolve(path.dirname(path.join(project, relative)), match[1]);
    assert.ok(fs.existsSync(target), `${relative} points to missing ${target}`);
    assert.ok(fs.statSync(path.join(project, relative)).size <= 1500, `${relative} is too large for a pointer`);
  }
  if (hasWorkspace) {
    for (const relative of [
      '.opencode/skills/customheadset-gxr/SKILL.md',
      '.opencode/skills/galaxyxr-workspace/SKILL.md',
      '.opencode/instructions/galaxyxr-driver/project-routing.instructions.md',
      '.opencode/instructions/galaxyxr-driver/cross-project-protocol.instructions.md',
    ]) {
      assert.ok(fs.existsSync(path.join(workspace, relative)), `missing workspace pointer ${relative}`);
    }
  }
});

test('project and workspace cavecrew contracts match when the workspace is present', { skip: !hasWorkspace }, () => {
  const normalized = text => text.replace(/\r\n/g, '\n');
  assert.equal(normalized(read('.opencode/skills/cavecrew/SKILL.md')),
    normalized(readWorkspace('.opencode/skills/cavecrew/SKILL.md')),
    'project and workspace cavecrew contracts drifted');
});

test('instruction files contain no stale artifact or accidental paths', () => {
  const scanned = [...instructionFiles];
  if (hasWorkspace) scanned.push('../AGENTS.md', '../.opencode/instructions/workspace-conventions.md',
    '../.opencode/instructions/README.md', '../.opencode/skills/cavecrew/SKILL.md');
  for (const relative of scanned) {
    const file = path.isAbsolute(relative) ? relative : path.join(project, relative);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /builds\/project\//, `${relative} uses the literal builds/project path`);
    assert.doesNotMatch(text, /GalgxyXR/, `${relative} contains the accidental GalgxyXR path`);
  }
});
