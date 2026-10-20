'use strict';
// Shared, fixture-testable portable staging. Use the renamed Cargo package while preserving the display name.
const fs = require('node:fs');
const path = require('node:path');
const BINARY_NAME = 'Galaxy XR Companion.exe';
function stagePayload(payloadDir, destinationDir) {
  if (!payloadDir) return undefined;
  const required = ['XR_APILAYER_XRFrameBridge_diagnostic.dll', 'ofxr_bridge.ini', 'payload.json', 'LICENSE', 'NOTICE'];
  for (const name of required) {
    const file = path.join(payloadDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error('OFXR payload is missing or empty: ' + file);
    }
  }
  const destination = path.join(destinationDir, 'ofxr');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(payloadDir, destination, { recursive: true });
  return destination;
}
function stageCompanion(sourceDir, destinationDir, payloadDir) {
  const source = path.join(sourceDir, 'galaxyxrdriver-gui.exe');
  if (!fs.existsSync(source) || !fs.statSync(source).isFile() || fs.statSync(source).size === 0) {
    throw new Error(`Tauri did not produce a nonempty executable: ${source}`);
  }
  fs.mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, BINARY_NAME);
  // Copy to a temporary name first. A failed copy cannot leave a truncated
  // executable with the final release name.
  const temporary = destination + '.tmp';
  try {
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  const oldDestination = path.join(destinationDir, 'galaxyxrdriver-gui.exe');
  if (fs.existsSync(oldDestination)) fs.unlinkSync(oldDestination);
  // The OFXR payload ships beside the executable as <exe dir>/ofxr, the
  // Rust bundled_directory() contract.
  stagePayload(payloadDir, destinationDir);
  return destination;
}
module.exports = { stageCompanion, stagePayload, BINARY_NAME };
if (require.main === module) {
  if (process.argv.length !== 4 && process.argv.length !== 5) throw new Error('Usage: node stage-companion.cjs <Tauri release directory> <portable GUI directory> [OFXR payload directory]');
  console.log(stageCompanion(process.argv[2], process.argv[3], process.argv[4]));
}
