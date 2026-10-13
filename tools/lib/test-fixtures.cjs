'use strict';
const fs = require('node:fs');
const path = require('node:path');

// External artifacts (2026-10-08): temporary fixtures share the project layout.
function fixtureRoot() {
  const root = path.resolve(__dirname, '../../../builds/GalaxyXR-Driver/build/test-fixtures');
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    try {
      const stat = fs.lstatSync(ancestor);
      if (stat.isSymbolicLink()) throw new Error(`Linked fixture ancestor: ${ancestor}`);
      if (!stat.isDirectory()) throw new Error(`Fixture ancestor is not a directory: ${ancestor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(ancestor) === ancestor) break;
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}
module.exports = { fixtureRoot };
