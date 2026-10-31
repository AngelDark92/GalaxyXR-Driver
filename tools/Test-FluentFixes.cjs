#!/usr/bin/env node
'use strict';
// Regression tests run the real TS services with an in-memory Tauri adapter.
// No filesystem path, process, SteamVR installation, or network is modified.
// Usage, after `npm ci` in GalaxyXRDriverGUI: node tools/Test-FluentFixes.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../GalaxyXRDriverGUI');
const guiRequire = createRequire(path.join(root, 'package.json'));
const ts = process.env.FLUENT_TEST_TYPESCRIPT ? require(process.env.FLUENT_TEST_TYPESCRIPT) : guiRequire('typescript');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let passed = 0;
const results = [];

function harness(vendor = 'galaxyxr') {
  const fixtureFile = path.join(__dirname, 'tests/fluent/mock-backend.cjs');
  const fixtureModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(fixtureFile, 'utf8'), { module: fixtureModule, console, Map, Set, JSON, Error });
  const { fixture, api } = fixtureModule.exports;
  const modules = new Map(), locks = new Map();
  const sandbox = {
    console: { ...console, warn() {}, log() {} }, structuredClone, queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval, performance, URL, URLSearchParams,
    TextEncoder, TextDecoder, AbortController, Promise, crypto: require('node:crypto').webcrypto,
    addEventListener() {}, removeEventListener() {},
    fetch: async () => { throw new TypeError('Network disabled in regression tests'); },
    navigator: { locks: { request(name, fn) {
      const task = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(fn);
      locks.set(name, task); return task;
    } } },
  };
  sandbox.self = sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  function load(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('environment-gen.ts')) source = `export const vendor = ${JSON.stringify(vendor)}; export const vendorUI = true;`;
    const result = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, useDefineForClassFields: false },
    });
    const module = { exports: {} }; modules.set(filename, module);
    const localRequire = id => {
      if (id === 'rxjs') return guiRequire('rxjs');
      if (id.startsWith('@tauri-apps/')) return api;
      if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id.endsWith('.ts') ? id : id + '.ts'));
      throw new Error(`Unexpected dependency: ${id}`);
    };
    vm.runInContext(`(function(require,module,exports){${result.outputText}\n})`, context, { filename })(localRequire, module, module.exports);
    return module.exports;
  }
  const source = rel => load(path.join(root, 'src-lit', rel+'.ts'));
  return { fixture, api, source, async app() {
    const paths = new (source('services/paths').PathsService)();
    await paths.ensureAllDirCreated();
    const ctx = source('app-context').createAppContext(paths);
    // These service tests have no browser. Dialog rendering/focus is tested
    // separately; preserve the old fixture's affirmative confirmation policy.
    ctx.dialog.confirm = async (...args) => { (fixture.dialogs ??= []).push({ kind: 'confirm', args }); return true; };
    ctx.dialog.message = async (...args) => { (fixture.dialogs ??= []).push({ kind: 'message', args }); };
    await Promise.all([ctx.appSetting.initTask, ctx.dss.initTask, ctx.dis.initTask, ctx.sds.initTask]);
    await tick(); await source('platform/writer').flushFileWrites(); await tick();
    return ctx;
  } };
}
async function test(name, fn) {
  try { await fn(); passed++; results.push({ test: name, passed: true }); console.log('PASS '+name); }
  catch (error) { results.push({test:name,passed:false,error:String(error)}); console.error('FAIL '+name, error); process.exitCode=1; }
}
module.exports = { harness, tick };
if (require.main === module) {
(async () => {
  await test('Settings booleans are strict and defaults are identified', () => {
    const {source}=harness(); const {inspectBooleanSettings,validateBooleanSettings}=source('domain/settings-inspection');
    assert.throws(()=>validateBooleanSettings({nested:{on:'false'}},{nested:{on:false}}), /JSON boolean/);
    assert.throws(()=>validateBooleanSettings({nested:null},{nested:{on:false}}), /JSON object/);
    const checks=inspectBooleanSettings({on:false,nested:{flag:true}},{on:false},'settings.json');
    assert.equal(checks.length,2);assert.equal(checks.find(x=>x.key==='on').origin,'stored');assert.equal(checks.find(x=>x.key==='nested.flag').origin,'default');
  });
  await test('Reactive computeds read fresh values synchronously',()=>{
    const {source}=harness();const {signal,computed}=source('reactive');const s=signal(false),c=computed(()=>s());assert.equal(c(),false);s.set(true);assert.equal(c(),true);
  });
  await test('Reactive branch switching detaches stale dependencies',async()=>{
    const {source}=harness();const {signal,computed}=source('reactive');const branch=signal(true),a=signal(1),b=signal(2);let reads=0;
    const c=computed(()=>{reads++;return branch()?a():b()});c();branch.set(false);await tick();const before=reads;a.set(3);await tick();assert.equal(reads,before);assert.equal(c(),2);
  });
  await test('Unsubscribing cancels queued notifications',async()=>{
    const {source}=harness();const s=source('reactive').signal(false);let n=0;const stop=s.subscribe(()=>n++);s.set(true);stop();await tick();assert.equal(n,0);
  });
  await test('Writer coalesces edits and flush waits for persistence',async()=>{
    const h=harness(),w=h.source('platform/writer').debouncedFileWriter('C:/test.json','C:/tmp',()=>true);
    const a=w.save('first'),b=w.save('last');await w.flush();await Promise.all([a,b]);assert.equal(h.fixture.files.get('C:/test.json'),'last');assert.equal(h.fixture.calls.filter(x=>x.kind==='write').length,1);w.dispose();
  });
  await test('Writer rejects failed saves rather than claiming success',async()=>{
    const h=harness();h.fixture.denied.add('C:/test.json');const w=h.source('platform/writer').debouncedFileWriter('C:/test.json','C:/tmp',()=>true);
    const save=w.save('value');const rejection=assert.rejects(save,/Permission denied/);await assert.rejects(w.flush(),/Permission denied/);await rejection;w.dispose();
  });
  await test('Replace-mode write failure cleans up the temporary file',async()=>{
    const h=harness();h.fixture.denied.add('C:/test.json');const w=h.source('platform/writer').debouncedFileWriter('C:/test.json','C:/tmp',()=>false);
    const save=w.save('value');const rejection=assert.rejects(save,/Permission denied/);await assert.rejects(w.flush(),/Permission denied/);await rejection;assert.equal([...h.fixture.files.keys()].filter(x=>x.startsWith('C:/tmp/')).length,0);w.dispose();
  });
  await test('Installation suspension cancels pending writes safely',async()=>{
    const h=harness(),writers=h.source('platform/writer'),w=writers.debouncedFileWriter('C:/test.json','C:/tmp',()=>true);
    const rejected=assert.rejects(w.save('cancelled'),/suspended/);await writers.suspendFileWrites();await rejected;assert.equal(h.fixture.files.has('C:/test.json'),false);writers.resumeFileWrites();const p=w.save('resumed');await w.flush();await p;assert.equal(h.fixture.files.get('C:/test.json'),'resumed');w.dispose();
  });
  await test('Cold paths cannot construct a broken service graph',()=>{
    const h=harness();assert.throws(()=>h.source('app-context').createAppContext(new (h.source('services/paths').PathsService)()),/Initialize PathsService/);
  });
  await test('Galaxy XR and neutral configuration paths remain isolated',async()=>{
    for(const [vendor,expected] of [['galaxyxr','GalaxyXR/CustomHeadset'],['','Roaming/CustomHeadset']]) {
      const h=harness(vendor),p=new (h.source('services/paths').PathsService)();await p.ensureAllDirCreated();assert.ok(p.appDataDirPath.endsWith(expected));
    }
  });
  await test('Driver detection works before any runtime info is published',async()=>{
    const h=harness();h.fixture.files.delete(h.fixture.data+'/info.json');const c=await h.app();assert.equal(c.sds.driverState(),'installed');assert.equal(c.sds.driverInstalled(),'1.2.3');c.dispose();
  });
  await test('Windows UTF-8 BOM manifests and settings are accepted',async()=>{
    const h=harness();for(const [key,value] of h.fixture.files){if(key.endsWith('.json')||key.endsWith('.vrpath')||key.endsWith('.vrsettings')||key.endsWith('.vrdrivermanifest'))h.fixture.put(key,'\uFEFF'+value);}
    const c=await h.app();assert.equal(c.sds.driverInstalled(),'1.2.3');assert.equal(c.appSetting.readFileError(),undefined);assert.equal(c.dss.readFileError(),undefined);assert.equal((await c.checks.refresh()).errors.length,0);c.dispose();
  });
  await test('Fresh verified installation initializes editable driver settings',async()=>{
    const h=harness();h.fixture.files.delete(h.fixture.data+'/settings.json');h.fixture.files.delete(h.fixture.data+'/info.json');const c=await h.app();assert.equal(c.sds.systemReady(),true);assert.ok(h.fixture.files.has(h.fixture.data+'/settings.json'));c.dispose();
  });
  await test('No installation does not create a missing driver configuration',async()=>{
    const h=harness();h.fixture.files.delete(h.fixture.data+'/settings.json');h.fixture.files.delete(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest');const c=await h.app();assert.equal(c.sds.systemReady(),false);await c.checks.refresh();assert.equal(h.fixture.files.has(h.fixture.data+'/settings.json'),false);c.dispose();
  });
  await test('About check does not recreate a configuration removed after startup',async()=>{
    const h=harness(),c=await h.app();h.fixture.files.delete(h.fixture.data+'/settings.json');const r=await c.checks.refresh();assert.equal(r.driverInstalled,true);assert.ok(r.errors.some(x=>x.includes('File not exists')));assert.equal(h.fixture.files.has(h.fixture.data+'/settings.json'),false);c.dispose();
  });
  await test('Refreshing watchers does not accumulate subscriptions',async()=>{
    const h=harness(),c=await h.app();const before=h.fixture.watchers.size;await c.dss.refreshWatch();await c.dss.refreshWatch();await c.sds.watchSteamVRSettings();assert.equal(h.fixture.watchers.size,before);c.dispose();assert.equal(h.fixture.watchers.size,0);
  });
  await test('Missing copied package can be found through external registration',async()=>{
    const h=harness(),old=h.fixture.runtime+'/drivers/GalaxyXRNative',dest='E:/Custom Package';
    for(const name of ['/driver.vrdrivermanifest','/bin/win64/driver_GalaxyXRNative.dll']){h.fixture.put(dest+name,h.fixture.files.get(old+name));h.fixture.files.delete(old+name);}
    h.fixture.put(h.fixture.openvr,{runtime:[h.fixture.runtime],config:[h.fixture.config],external_drivers:[dest]});
    const c=await h.app();assert.equal(c.sds.driverInstalled(),'1.2.3');c.dispose();
  });
  await test('A different driver identity is not treated as GalaxyXRNative',async()=>{
    const h=harness();h.fixture.put(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest',{name:'CustomHeadsetOpenVR',version:'1.2.3'});
    const c=await h.app();assert.equal(c.sds.driverState(),'not-installed');c.dispose();
  });
  await test('Inaccessible OpenVR paths report Unknown rather than uninstalled',async()=>{
    const h=harness();h.fixture.denied.add(h.fixture.openvr);const c=await h.app();assert.equal(c.sds.driverState(),'unknown');assert.match(c.sds.driverCheckError(),/Permission denied/);c.dispose();
  });
  await test('About checks coalesce and drain the last unsaved edit first',async()=>{
    const h=harness(),c=await h.app();const next=structuredClone(c.dss.values());next.galaxyXr.nativeResolution=false;
    const save=c.dss.save(next);const a=c.checks.refresh(),b=c.checks.refresh();assert.equal(a,b);const report=await a;await save;
    assert.equal(report.errors.length,0);assert.equal(report.checks.find(x=>x.key==='galaxyXr.nativeResolution').enabled,false);assert.equal(c.dss.values().galaxyXr.nativeResolution,false);c.dispose();
  });
  await test('About reads saved values without resetting or invoking native commands',async()=>{
    const h=harness(),c=await h.app();const next=structuredClone(c.dss.values());next.galaxyXr.nativeResolution=false;h.fixture.put(h.fixture.data+'/settings.json',next);
    h.fixture.put(h.fixture.config+'/steamvr.vrsettings',{driver_GalaxyXRNative:{enable:false}});const before=h.fixture.calls.length;const r=await c.checks.refresh();await tick();
    assert.equal(r.driverEnabled,false);assert.equal(c.galaxy.rootSetting.galaxyXr.nativeResolution,false);assert.equal(h.fixture.calls.length,before);c.dispose();
  });
  await test('Read-back covers every driver boolean in both On and Off states',async()=>{
    const h=harness(),c=await h.app();let count=0;
    for(const state of [false,true]){const values=structuredClone(c.dss.values());const fill=o=>{for(const [k,v] of Object.entries(o)){if(typeof v==='boolean'){o[k]=state;count++;}else if(v&&typeof v==='object'&&!Array.isArray(v))fill(v);}};fill(values);h.fixture.put(h.fixture.data+'/settings.json',values);const before=h.fixture.calls.length;const r=await c.checks.refresh();const checks=r.checks.filter(x=>x.source==='settings.json'&&x.kind==='boolean');assert.ok(checks.length>70);assert.ok(checks.every(x=>x.enabled===state));await tick();assert.equal(h.fixture.calls.length,before);}
    console.log('  verified boolean states:',count);c.dispose();
  });
  await test('Unreadable and malformed settings never overwrite the backing file',async()=>{
    const h=harness(),c=await h.app();h.fixture.put(h.fixture.data+'/settings.json','{"streamFrame":{"enable":"false"}}');const before=h.fixture.calls.length;let r=await c.checks.refresh();assert.ok(r.errors.some(x=>x.includes('JSON boolean')));assert.equal(c.dss.values(),undefined);
    assert.ok(r.settings.filter(x=>x.source!=='gui-settings.json').every(x=>x.state==='Unknown'&&x.origin==='unknown'));
    h.fixture.denied.add(h.fixture.data+'/settings.json');r=await c.checks.refresh();assert.ok(r.errors.some(x=>x.includes('Permission denied')));assert.equal(c.dss.values(),undefined);assert.equal(h.fixture.calls.length,before);c.dispose();
  });
  await test('Failed write rolls back a setting and exposes an actionable error',async()=>{
    const h=harness(),c=await h.app();const old=c.appSetting.values().advanceMode;h.fixture.denied.add(h.fixture.data+'/gui-settings.json');assert.equal(await c.appSetting.save({...c.appSetting.values(),advanceMode:!old}),false);assert.equal(c.appSetting.values().advanceMode,old);assert.match(c.appSetting.writeFileError(),/Permission denied/);c.dispose();
  });
  await test('Driver-disabled and safe-mode-blocked states are read independently',async()=>{
    const h=harness(),c=await h.app();for(const section of [{enable:false},{enable:true,blocked_by_safe_mode:true}]){h.fixture.put(h.fixture.config+'/steamvr.vrsettings',{driver_GalaxyXRNative:section});const r=await c.checks.refresh();assert.equal(r.driverEnabled,false);}c.dispose();
  });
  for(const invalid of ['broken JSON','[]','null','"{}"']) await test('Invalid driver JSON remains untouched: '+invalid,async()=>{
    const h=harness();h.fixture.put(h.fixture.data+'/settings.json',invalid);const c=await h.app();assert.equal(c.sds.systemReady(),false);assert.equal(h.fixture.files.get(h.fixture.data+'/settings.json'),invalid);c.dispose();
  });
  await test('Legacy empty GUI sentinel is accepted without weakening driver validation',async()=>{
    const h=harness();h.fixture.put(h.fixture.data+'/gui-settings.json','"{}"');const c=await h.app();assert.equal(c.appSetting.readFileError(),undefined);assert.equal(c.appSetting.values().colorScheme,'dark');assert.equal(c.appSetting.values().advanceMode,false);c.dispose();
  });
  await test('Explicit saved identity overrides a stale runtime default',async()=>{
    const h=harness();h.fixture.put(h.fixture.data+'/info.json',{defaultSettings:{galaxyXr:{nativeIdentity:false}}});h.fixture.put(h.fixture.data+'/settings.json',{galaxyXr:{nativeIdentity:false}});const c=await h.app();assert.equal(c.dss.values().galaxyXr.nativeIdentity,false);h.fixture.put(h.fixture.data+'/settings.json',{});await c.checks.refresh();assert.equal(c.dss.values().galaxyXr.nativeIdentity,true);c.dispose();
  });
  await test('Stale neutral settings do not claim that another driver is installed',async()=>{
    const h=harness(),c=await h.app();assert.equal(c.sds.getNeutralDriverEnabled({driver_CustomHeadsetOpenVR:{enable:true}}),false);const folder=h.fixture.runtime+'/drivers/CustomHeadsetOpenVR';h.fixture.put(folder+'/driver.vrdrivermanifest',{name:'CustomHeadsetOpenVR',version:'1.2.3'});h.fixture.put(folder+'/bin/win64/driver_CustomHeadsetOpenVR.dll','fixture');await c.sds.checkDriverInstalled();assert.equal(c.sds.getNeutralDriverEnabled({}),true);c.dispose();
  });
  await test('Native journal enablement changes are reread into the shared state',async()=>{
    const h=harness(),c=await h.app();const originalInvoke=h.api.invoke;let calls=0;
    h.api.invoke=async(name,args)=>{if(name==='update_galaxyxr_steamvr_settings'){calls++;let cfg=JSON.parse(h.fixture.files.get(h.fixture.config+'/steamvr.vrsettings'));for(const change of args.changes){cfg[change.section]??={};if(change.present)cfg[change.section][change.key]=change.value;else delete cfg[change.section][change.key];}h.fixture.put(h.fixture.config+'/steamvr.vrsettings',cfg);return;}return originalInvoke(name,args);};
    const before=h.fixture.calls.length;await c.sds.disableSteamVRDriver('GalaxyXRNative');assert.equal(c.sds.steamVrConfig().driver_GalaxyXRNative.enable,false);await c.sds.enableSteamVRDriver('GalaxyXRNative');assert.equal(c.sds.steamVrConfig().driver_GalaxyXRNative.enable,true);assert.equal(calls,2);assert.equal(h.fixture.calls.slice(before).filter(x=>x.kind==='write').length,0);c.dispose();
  });
  await test('Install, uninstall and reinstall preserve the bundle and rebind readiness',async()=>{
    const h=harness(),c=await h.app(),installed=h.fixture.runtime+'/drivers/GalaxyXRNative',bundle='E:/Portable/GalaxyXRNative';
    c.dialog.confirm=async()=>true;
    for(const suffix of ['/driver.vrdrivermanifest','/bin/win64/driver_GalaxyXRNative.dll'])h.fixture.put(bundle+suffix,h.fixture.files.get(installed+suffix));
    const originalInvoke=h.api.invoke;
    h.api.invoke=async(name,args)=>{
      if(name==='register_galaxyxr_driver'){for(const suffix of ['/driver.vrdrivermanifest','/bin/win64/driver_GalaxyXRNative.dll'])h.fixture.put(installed+suffix,h.fixture.files.get(bundle+suffix));return{registeredPath:installed};}
      if(name==='uninstall_galaxyxr_driver'){for(const key of [...h.fixture.files.keys()])if(key.startsWith(installed+'/')||key.startsWith(h.fixture.data+'/'))h.fixture.files.delete(key);return{outcome:'complete',preservedPaths:[],unresolvedItems:[],removedPaths:[installed],restoredSettings:1,legacyReset:false,warnings:[]};}
      return originalInvoke(name,args);
    };
    assert.equal(await c.sds.installDriver(),true);assert.equal(c.sds.systemReady(),true);assert.equal(await c.sds.uninstallDriver(),true);assert.equal(c.sds.systemReady(),false);assert.equal(h.fixture.files.has(bundle+'/driver.vrdrivermanifest'),true);assert.equal(await c.sds.installDriver(),true);assert.equal(c.sds.systemReady(),true);c.dispose();
  });
  for(const step of ['package inspection','settings initialization']) await test('Uninstall drains an older '+step+' before removing files',async()=>{
    const h=harness(),c=await h.app();c.dialog.confirm=async()=>true;let entered,release,deleted=false;
    const pause=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve);
    if(step==='package inspection'){const original=c.sds.inspectDriverPackage.bind(c.sds);let once=false;c.sds.inspectDriverPackage=async(p,name)=>{if(!once&&name==='CustomHeadsetOpenVR'){once=true;entered();await resume;}return original(p,name);};}
    else{const original=c.dss.ensureEditableSettings.bind(c.dss);c.dss._values.set(undefined);c.dss.ensureEditableSettings=async()=>{entered();await resume;return original();};}
    h.api.invoke=async name=>{if(name==='uninstall_galaxyxr_driver'){deleted=true;for(const key of [...h.fixture.files.keys()])if(key.startsWith(h.fixture.data+'/')||key.startsWith(h.fixture.runtime+'/drivers/GalaxyXRNative/'))h.fixture.files.delete(key);return{outcome:'complete',preservedPaths:[],unresolvedItems:[],removedPaths:[],restoredSettings:0,legacyReset:false,warnings:[]};}return true;};
    const older=c.sds.checkDriverInstalled();await pause;const uninstall=c.sds.uninstallDriver();await tick();assert.equal(deleted,false);release();assert.equal(await older,false);assert.equal(await uninstall,true);assert.equal(c.sds.systemReady(),false);assert.equal(h.fixture.files.has(h.fixture.data+'/settings.json'),false);c.dispose();
  });
  console.log(`\nFluent regression tests: ${passed}/${results.length} passed.`);
  if(process.env.FLUENT_TEST_REPORT)fs.writeFileSync(process.env.FLUENT_TEST_REPORT,JSON.stringify(results,null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});

}
