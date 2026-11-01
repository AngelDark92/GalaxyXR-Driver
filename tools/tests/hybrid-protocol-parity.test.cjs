'use strict';
// The GXH1 schema and the hybrid codec sources exist twice: the driver writes the wire and
// encodes the rings, the sibling steamlink-patches helper parses and decodes them. A drift
// between the copies is a silent wire break, so they must stay identical apart from their
// own include lines. Skips when the sibling checkout is absent (CI checks out this
// repository alone).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '../..');
const client = path.resolve(project, '../steamlink-patches/extensions/hybrid-codec');
const hasClient = fs.existsSync(path.join(client, 'protocol/gxh1.h'));
const hybrid = relative => path.join(project, 'GalaxyXRDriver/src/Hybrid', relative);
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function schemaBlock(text) {
  const start = text.indexOf('// >>> GXH1-SCHEMA');
  const end = text.indexOf('// <<< GXH1-SCHEMA');
  assert.ok(start >= 0 && end > start, 'schema markers present');
  return text.slice(start, end);
}

function withoutFirstInclude(text) {
  const lines = text.split('\n');
  assert.match(lines[0], /^#include "/, 'copied source starts with its own header include');
  return lines.slice(1).join('\n');
}

function namespaceBody(text) {
  const start = text.indexOf('namespace gxh1 {');
  const end = text.lastIndexOf('}  // namespace gxh1');
  assert.ok(start >= 0 && end > start, 'namespace block present');
  return text.slice(start, end);
}

test('GXH1 schema block is identical in the driver and the client helper', { skip: !hasClient }, () => {
  assert.equal(schemaBlock(read(path.join(client, 'protocol/gxh1.h'))), schemaBlock(read(hybrid('Gxh1Protocol.h'))));
});

test('client codec sources are exact copies of the driver codec sources', { skip: !hasClient }, () => {
  const pairs = [
    ['AstcSubset.cpp', 'src/astc_decode.cpp'],
    ['PyroWaveCpu.cpp', 'src/pyrowave_decode.cpp'],
    ['Gxh1Codec.cpp', 'src/gxh1_parse.cpp'],
  ];
  for (const [host, copy] of pairs) {
    assert.equal(withoutFirstInclude(read(path.join(client, copy))), withoutFirstInclude(read(hybrid(host))),
      `${copy} drifted from ${host}`);
  }
  assert.equal(read(path.join(client, 'src/astc_decode.h')), read(hybrid('AstcSubset.h')), 'astc_decode.h drifted');
  assert.equal(read(path.join(client, 'src/pyrowave_decode.h')), read(hybrid('PyroWaveCpu.h')), 'pyrowave_decode.h drifted');
  assert.equal(namespaceBody(read(path.join(client, 'src/gxh1_parse.h'))), namespaceBody(read(hybrid('Gxh1Codec.h'))),
    'gxh1_parse.h declarations drifted');
});
