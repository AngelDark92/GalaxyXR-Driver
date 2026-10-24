'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const project = path.resolve(__dirname, '../..');

test('workspace cleanup fixtures pass', { skip: process.platform !== 'win32', timeout: 300000 }, () => {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(project, 'tools/Test-WorkspaceCleanup.ps1')], {
    encoding: 'utf8', windowsHide: true, timeout: 240000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Workspace cleanup tests passed: \d+ assertions/);
});
