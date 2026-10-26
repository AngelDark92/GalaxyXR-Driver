#!/usr/bin/env node
'use strict';
// Runs actual application services against the in-memory Tauri test adapter.
// Native filesystem transactions and runtime PID validation have separate Rust tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, tick } = require('./Test-FluentFixes.cjs');
const results = [];
async function test(test, fn) {
  try { await fn(); results.push({ test, passed: true }); console.log('PASS ' + test); }
  catch (e) { results.push({ test, passed: false, error: String(e) }); console.error('FAIL ' + test, e); process.exitCode = 1; }
}
function runtime(overrides = {}) { return {state:'waiting',detail:'Waiting',steamvrRunning:true,driverInitialized:false,headsetConnected:false,driverVersion:'1.2.3',serverPid:42,checkedAt:Date.now(),...overrides}; }
const freshDriverConfig = {galaxyXr:{nativeIdentity:true}};
const schemaStamps = new Set(['sdr10SettingsVersion','nvencSettingsVersion','streamFrameSchema']);
const withoutSchemaStamps = value => JSON.parse(JSON.stringify(value,(key,item)=>schemaStamps.has(key)?undefined:item));
function effectiveSettings(value) {
  const settings=withoutSchemaStamps(value);
  // Retired compatibility field: the current SDR policy ignores this stored
  // flag and requests no 10-bit capability with the baseline OFF. Cleanup
  // suppresses migrations while inspecting; normal reload later normalizes it.
  if(settings.galaxyXr)delete settings.galaxyXr.profileSupports10bit;
  return settings;
}
const localFiles = h => [...h.fixture.files].filter(([name])=>name.startsWith(h.fixture.data+'/')).sort(([a],[b])=>a.localeCompare(b));
async function freshDefaults() {
  const h=harness();h.fixture.put(h.fixture.data+'/settings.json',freshDriverConfig);
  h.fixture.files.delete(h.fixture.data+'/info.json');
  const c=await h.app();
  try { return {values:effectiveSettings(c.dss.values()),views:effectiveSettings(c.galaxy.rootSetting)}; }
  finally { c.dispose(); }
}
function dirtySettings(h) {
  h.fixture.put(h.fixture.data+'/nvenc-settings-v4.migrated','old migration marker');
  h.fixture.put(h.fixture.data+'/settings.json',{
    galaxyXr:{nativeIdentity:false,nativeResolution:false,streamQuality:'custom',customBandwidthMbit:425,
      renderModelScale:1.3,vrlinkExtraKeys:{targetBandwidth:{i:425}},sdr10SettingsVersion:2},
    streamFrame:{streamFrameSchema:4,nvencSettingsVersion:4,enable:true,saturation:73,gamma:2.4,
      nvencTap:false,nvencBitrateConstancyPct:100,nvencForceCbr:false,nvencPreset:7,nvencForceFps:72,
      nvencVbvFrames:5,postPack:{enable:false,casEnable:false},alignment:{leftH:0.2}},
    controllers:{rotationOffsetDeg:{x:7,y:8,z:9}},customShader:{enable:true,contrast:63},
  });
  h.fixture.put(h.fixture.data+'/info.json',{driverVersion:'old-package',defaultSettings:{
    galaxyXr:{nativeIdentity:false,nativeResolution:false,renderModelScale:2},
    streamFrame:{saturation:13,gamma:3,nvencTap:false,nvencBitrateConstancyPct:0,nvencPreset:6,
      nvencForceCbr:false,nvencVbvFrames:8,postPack:{enable:false,casEnable:false}},
    controllers:{rotationOffsetDeg:{x:11,y:12,z:13}},customShader:{contrast:17},
  }});
}
async function scenario(fn, setup) { const h=harness(); setup?.(h); const c=await h.app(); c.dialog.confirm=async()=>true; c.dialog.message=async()=>{}; try { await fn(h,c); } finally {c.dispose();} }
function cleanMock(h, next) {
  const invoke=h.api.invoke;
  h.api.invoke=async (name,args)=>{
    if(name!=='clean_galaxyxr_settings')return invoke(name,args);
    h.fixture.calls.push({kind:'invoke',name,args});
    if(next) return next(args);
    h.fixture.put(h.fixture.data+'/settings.json',freshDriverConfig);
    h.fixture.put(h.fixture.data+'/gui-settings.json',{});
    h.fixture.files.delete(h.fixture.data+'/info.json');h.fixture.files.delete(h.fixture.data+'/diagnostic.json');
    h.fixture.files.delete(h.fixture.data+'/nvenc-settings-v4.migrated');
    return {outcome:'complete',preservedPaths:['D:/Backups/test'],unresolvedItems:[],backupPath:'D:/Backups/test',resetFiles:['settings.json','gui-settings.json'],restoredSettings:2,removedIdentityKeys:[],removedIdentitySections:[],steamvrCleaned:!!args.steamvrPath,warnings:[]};
  };
}
(async()=>{
  await test('Default and invalid routes land on Setup uninstalled, Driver Settings installed',()=>{const n=harness().source('domain/navigation');assert.equal(n.parseRoute('',false),'setup');assert.equal(n.parseRoute('',true),'driver-settings');assert.equal(n.parseRoute('#/missing',false),'setup');assert.equal(n.parseRoute('#/missing',true),'driver-settings');});
  await test('Before installation, App Settings, Setup, and About keep their order',()=>{const n=harness().source('domain/navigation');assert.deepEqual(Array.from(n.visibleRoutes(false)),['app-settings','setup','about']);assert.equal(n.permittedRoute('driver-settings',false),'setup');assert.equal(n.permittedRoute('app-settings',false),'app-settings');});
  await test('Runtime checking is read-only and uses the detected SteamVR path',async()=>scenario(async(h,c)=>{
    const calls=[];h.api.invoke=async(name,args)=>{calls.push({name,args});return runtime();};await c.startup.refresh();assert.equal(calls.length,1);assert.equal(calls[0].name,'get_galaxyxr_runtime_status');assert.equal(calls[0].args.steamvrPath,h.fixture.runtime);assert.equal(c.startup.status().driverInitialized,false);
  }));
  await test('Launch success is not driver initialization success',async()=>scenario(async(h,c)=>{h.api.invoke=async()=>runtime({steamvrRunning:false,state:'not-running'});let launched=0;c.sds.launchSteamVR=async()=>{launched++;return true;};assert.equal(await c.startup.start(),true);assert.equal(launched,1);assert.equal(c.startup.status().driverInitialized,false);}));
  await test('A running SteamVR session is not launched a second time',async()=>scenario(async(h,c)=>{h.api.invoke=async()=>runtime();let launched=0;c.sds.launchSteamVR=async()=>{launched++;return true;};await c.startup.start();assert.equal(launched,0);}));
  await test('Failed launch is reported instead of silently succeeding',async()=>scenario(async(h,c)=>{h.api.invoke=async()=>runtime({steamvrRunning:false});c.sds.launchSteamVR=async()=>false;assert.equal(await c.startup.start(),false);assert.match(c.startup.error(),/could not be started/);}));
  await test('A failed runtime read removes an older green status',async()=>scenario(async(h,c)=>{h.api.invoke=async()=>runtime({state:'initialized',driverInitialized:true});await c.startup.refresh();assert.equal(c.startup.status().driverInitialized,true);h.api.invoke=async()=>{throw Error('denied')};await c.startup.refresh();assert.equal(c.startup.status(),undefined);assert.match(c.startup.error(),/denied/);}));
  await test('Invalidation rejects an in-flight stale runtime report',async()=>scenario(async(h,c)=>{let resolve;h.api.invoke=()=>new Promise(r=>resolve=r);const p=c.startup.refresh();c.startup.invalidate();resolve(runtime({driverInitialized:true}));await p;assert.equal(c.startup.status(),undefined);}));
  await test('Runtime refresh calls coalesce',async()=>scenario(async(h,c)=>{let resolve,count=0;h.api.invoke=()=>{count++;return new Promise(r=>resolve=r)};const a=c.startup.refresh(),b=c.startup.refresh();assert.equal(a,b);resolve(runtime());await a;assert.equal(count,1);}));
  for (const registered of [true,false]) await test(`Runtime polling detects SteamVR before installation, registered path: ${registered}`,async()=>scenario(async(h,c)=>{
    const calls=[];h.api.invoke=async(name,args)=>{calls.push({name,args});return runtime({driverVersion:null,serverPid:null});};
    await c.startup.refresh();assert.equal(c.startup.status().steamvrRunning,true);assert.equal(c.startup.status().driverInitialized,false);
    assert.equal(await c.startup.start(),false);assert.equal(calls.length,1);
    assert.equal(calls[0].name,'get_galaxyxr_runtime_status');assert.equal(calls[0].args.steamvrPath,registered?h.fixture.runtime:null);assert.equal(calls[0].args.expectedVersion,'');
  },h=>{h.fixture.files.delete(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest');if(!registered)h.fixture.files.delete(h.fixture.openvr);}));
  for (const changed of ['path','version','busy']) for (const failure of [false,true]) await test(`Runtime rejects stale async ${failure?'failure':'success'} after ${changed} changes`,async()=>scenario(async(h,c)=>{
    let resolve,reject;h.api.invoke=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});const pending=c.startup.refresh();
    if(changed==='path')c.sds._steamVRinstalled.set('E:/DifferentSteamVR');
    if(changed==='version')c.sds._driverInstalled.set('2.0.0');
    if(changed==='busy')c.sds._installingDriver.set(true);
    if(failure)reject(Error('outdated failure'));else resolve(runtime({driverInitialized:true}));
    await pending;assert.equal(c.startup.status(),undefined);assert.equal(c.startup.error(),undefined);
  }));
  await test('Cleanup fixture exactly matches the native fresh-install defaults contract',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../GalaxyXRDriverGUI/src-tauri/src/driver_installation/settings_cleanup.rs'),'utf8');
    const literal=source.match(/fn clean_driver_config\(\) -> Value \{[\s\S]*?json!\((\{[\s\S]*?\})\)\s*\}/);
    assert.ok(literal,'native clean_driver_config JSON is available');assert.deepEqual(JSON.parse(literal[1]),freshDriverConfig);
  });
  await test('Cancelled cleanup preserves custom settings, stale telemetry, and migration marker',async()=>scenario(async(h,c)=>{cleanMock(h);c.dialog.confirm=async()=>{assert.equal(c.sds.installingDriver(),false);return false;};const before=localFiles(h),values=effectiveSettings(c.dss.values());assert.equal(await c.sds.cleanSettings(c.appSetting),undefined);assert.deepEqual(localFiles(h),before);assert.deepEqual(effectiveSettings(c.dss.values()),values);assert.equal(c.dss.values().streamFrame.nvencTap,false);assert.equal(h.fixture.calls.filter(x=>x.name==='clean_galaxyxr_settings').length,0);assert.equal(c.sds.installingDriver(),false);},dirtySettings));
  await test('Cleanup before driver installation is available and preserves the uninstalled state',async()=>scenario(async(h,c)=>{cleanMock(h);const r=await c.sds.cleanSettings(c.appSetting);assert.equal(r.backupPath,'D:/Backups/test');assert.equal(c.sds.driverInstalled(),undefined);assert.equal(c.sds.installingDriver(),false);assert.equal(c.dss.values().galaxyXr.nativeIdentity,true);},h=>h.fixture.files.delete(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest')));
  await test('Cleanup without registered SteamVR passes null to native local-only reset',async()=>scenario(async(h,c)=>{cleanMock(h);const r=await c.sds.cleanSettings(c.appSetting);assert.ok(r);const call=h.fixture.calls.find(x=>x.name==='clean_galaxyxr_settings');assert.equal(call.args.steamvrPath,null);assert.equal(r.steamvrCleaned,false);},h=>h.fixture.files.delete(h.fixture.openvr)));
  await test('Successful reset restores driver and app defaults and clears runtime data',async()=>scenario(async(h,c)=>{
    cleanMock(h);const r=await c.sds.cleanSettings(c.appSetting);assert.ok(r);assert.equal(c.dss.values().galaxyXr.nativeIdentity,true);
    assert.equal(c.appSetting.values().advanceMode,false);assert.equal(c.appSetting.values().colorScheme,'dark');assert.equal(c.appSetting.values().updateMode,'rewrite');assert.equal(c.appSetting.values().driverVerified,false);assert.equal(c.dis.values(),undefined);assert.equal(c.sds.driverInstalled(),'1.2.3');assert.equal(c.dss.inspecting,false);assert.equal(c.appSetting.inspecting,false);
    await tick();const expected=h.source('domain/driver-defaults').driverDefaults.streamFrame;
    for(const key of ['nvencTap','nvencFixLevel','nvencForceCbr','nvencBitrateConstancyPct','nvencPresetMerge','nvencVbvFrames','nvencLowDelayKfScale','nvencForceFps','nvencSplitMode']){
      assert.equal(c.dss.values().streamFrame[key],expected[key],key);
      assert.equal(c.galaxy.rootSetting.streamFrame[key],expected[key],key+' switch');
    }
    assert.equal(c.galaxy.rootSetting.streamFrame.nvencTap,true);assert.equal(c.galaxy.rootSetting.streamFrame.nvencBitrateConstancyPct,0);
    assert.deepEqual(withoutSchemaStamps(c.galaxy.rootSetting.streamFrame.postPack),withoutSchemaStamps(expected.postPack));
    await h.source('platform/writer').flushFileWrites();assert.deepEqual(JSON.parse(h.fixture.files.get(h.fixture.data+'/settings.json')),freshDriverConfig);
  }));
  await test('Cleanup discards stale telemetry and custom tuning across every setting, including after save and reopen',async()=>{
    const expected=await freshDefaults();
    await scenario(async(h,c)=>{
      assert.equal(c.dss.values().streamFrame.nvencTap,false);assert.equal(c.dss.values().streamFrame.saturation,73);
      cleanMock(h);assert.ok(await c.sds.cleanSettings(c.appSetting));await tick();
      assert.equal(h.fixture.files.has(h.fixture.data+'/nvenc-settings-v4.migrated'),false);
      assert.deepEqual(effectiveSettings(c.dss.values()),expected.values,'all effective reloaded settings match a fresh service');
      assert.deepEqual(effectiveSettings(c.galaxy.rootSetting),expected.views,'all effective control values match a fresh service');
      for(const settings of [c.dss.values(),expected.values]){
        assert.equal(settings.galaxyXr.sdr10Baseline,true);assert.equal(settings.galaxyXr.sdr10AllowEnhancements,false);
      }
      assert.equal(await c.dss.loadSetting(),true);await tick();
      const saving=c.dss.save(structuredClone(c.dss.values()));await tick();await h.source('platform/writer').flushFileWrites();assert.equal(await saving,true);
      assert.deepEqual(effectiveSettings(c.dss.values()),expected.values,'reload and save preserve fresh settings');
      assert.equal(c.dss.values().galaxyXr.profileSupports10bit,false,'normal reload applies the existing legacy migration');
      const persisted=h.fixture.files.get(h.fixture.data+'/settings.json');
      const reopened=harness();reopened.fixture.put(reopened.fixture.data+'/settings.json',persisted);reopened.fixture.files.delete(reopened.fixture.data+'/info.json');
      const next=await reopened.app();
      try {assert.deepEqual(effectiveSettings(next.dss.values()),expected.values,'reopening preserves every effective fresh default');assert.deepEqual(effectiveSettings(next.galaxy.rootSetting),expected.views);assert.equal(next.dss.values().galaxyXr.profileSupports10bit,false);}
      finally {next.dispose();}
    },dirtySettings);
  });
  await test('Pending edits cannot rewrite freshly cleaned configuration',async()=>scenario(async(h,c)=>{cleanMock(h);const edited=structuredClone(c.dss.values());edited.galaxyXr.nativeIdentity=false;edited.streamFrame.nvencTap=false;const pending=c.dss.save(edited);await tick();await c.sds.cleanSettings(c.appSetting);await pending;await h.source('platform/writer').flushFileWrites();assert.deepEqual(JSON.parse(h.fixture.files.get(h.fixture.data+'/settings.json')),freshDriverConfig);assert.equal(c.dss.values().galaxyXr.nativeIdentity,true);assert.equal(c.dss.values().streamFrame.nvencTap,true);}));
  await test('Native cleanup failure preserves custom files and migration marker, then clears busy state',async()=>scenario(async(h,c)=>{cleanMock(h,()=>{throw Error('SteamVR is running')});let message='';c.dialog.message=async(_,v)=>{message=v};const before=localFiles(h),values=effectiveSettings(c.dss.values());assert.equal(await c.sds.cleanSettings(c.appSetting),undefined);assert.match(message,/SteamVR is running/);assert.deepEqual(localFiles(h),before);assert.deepEqual(effectiveSettings(c.dss.values()),values);assert.equal(c.dss.values().streamFrame.nvencTap,false);assert.equal(c.sds.installingDriver(),false);assert.equal(c.dss.inspecting,false);},dirtySettings));
  await test('Cleanup is serialized against installation and other cleanup requests',async()=>scenario(async(h,c)=>{let release;cleanMock(h,()=>new Promise(r=>release=r));const a=c.sds.cleanSettings(c.appSetting);while(!release)await tick();assert.equal(await c.sds.cleanSettings(c.appSetting),undefined);release({backupPath:'B',resetFiles:[],restoredSettings:0,removedIdentityKeys:[],removedIdentitySections:[],steamvrCleaned:true,warnings:[]});await a;assert.equal(h.fixture.calls.filter(x=>x.name==='clean_galaxyxr_settings').length,1);}));
  await test('Cancelled uninstall leaves preferences, verification, files and native commands unchanged',async()=>scenario(async(h,c)=>{
    c.dialog.confirm=async()=>{assert.equal(c.sds.installingDriver(),false);return false;};const before=localFiles(h),app=JSON.stringify(c.appSetting.values());const calls=h.fixture.calls.length;
    assert.equal(await c.sds.uninstallDriver(c.appSetting),false);assert.deepEqual(localFiles(h),before);assert.equal(JSON.stringify(c.appSetting.values()),app);
    assert.equal(h.fixture.calls.slice(calls).filter(x=>x.kind==='write'||x.name==='uninstall_galaxyxr_driver').length,0);
  }));
  await test('Uninstall clears active state and stale writes while permitting deliberate app preference edits',async()=>scenario(async(h,c)=>{
    h.fixture.put(h.fixture.data+'/Distortion/saved.json','saved profile');
    const invoke=h.api.invoke;h.api.invoke=async(name,args)=>{
      if(name!=='uninstall_galaxyxr_driver')return invoke(name,args);
      h.fixture.calls.push({kind:'invoke',name,args});
      for(const path of [...h.fixture.files.keys()])if(path.startsWith(h.fixture.data+'/')&&!path.startsWith(h.fixture.data+'/Distortion/'))h.fixture.files.delete(path);
      h.fixture.files.delete(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest');
      return {outcome:'complete',preservedPaths:[h.fixture.data+'/Distortion'],unresolvedItems:[],removedPaths:[h.fixture.data+'/settings.json'],restoredSettings:1,legacyReset:false,warnings:[]};
    };
    const pending=c.dss.save(structuredClone(c.dss.values()));
    assert.equal(await c.sds.uninstallDriver(c.appSetting),true);await pending;await tick();await h.source('platform/writer').flushFileWrites();
    assert.equal(c.sds.driverInstalled(),undefined);assert.equal(c.dss.values(),undefined);assert.equal(c.dis.values(),undefined);
    assert.equal(c.appSetting.values().advanceMode,false);assert.equal(c.appSetting.values().driverVerified,false);
    assert.equal(h.fixture.files.has(h.fixture.data+'/gui-settings.json'),false);assert.equal(h.fixture.files.get(h.fixture.data+'/Distortion/saved.json'),'saved profile');
    assert.equal(await c.appSetting.save({...c.appSetting.values(),advanceMode:true}),true);
    assert.equal(c.appSetting.values().advanceMode,true);assert.equal(JSON.parse(h.fixture.files.get(h.fixture.data+'/gui-settings.json')).advanceMode,true);
    assert.equal(h.fixture.files.has(h.fixture.data+'/settings.json'),false);assert.equal(h.fixture.files.has(h.fixture.data+'/info.json'),false);
  }));
  await test('Incomplete native uninstall produces retry state and never resumes settings writers',async()=>scenario(async(h,c)=>{
    const invoke=h.api.invoke;h.api.invoke=async(name,args)=>name==='uninstall_galaxyxr_driver'
      ? {outcome:'incomplete',preservedPaths:['recovery'],unresolvedItems:['A locked file remains. Retry Uninstall.'],removedPaths:[],restoredSettings:1,legacyReset:false,warnings:[]} : invoke(name,args);
    assert.equal(await c.sds.uninstallDriver(c.appSetting),true);assert.equal(c.sds.lastUninstallReport.outcome,'incomplete');assert.equal(c.sds.driverState(),'unknown');
    assert.match(c.sds.driverCheckError(),/Retry Uninstall/);assert.equal(await c.appSetting.save({...c.appSetting.values(),advanceMode:true}),false);
    assert.equal(c.appSetting.values().advanceMode,false);assert.match(c.appSetting.writeFileError(),/suspended/);
  }));
  await test('Missing driver binaries do not prevent the explicit uninstall cleanup command',async()=>scenario(async(h,c)=>{
    let requested=false;const invoke=h.api.invoke;h.api.invoke=async(name,args)=>{
      if(name!=='uninstall_galaxyxr_driver')return invoke(name,args);requested=true;
      return {outcome:'complete',preservedPaths:[],unresolvedItems:[],removedPaths:[],restoredSettings:0,legacyReset:false,warnings:[]};
    };
    assert.equal(c.sds.driverInstalled(),undefined);assert.equal(await c.sds.uninstallDriver(c.appSetting),true);assert.equal(requested,true);
  },h=>h.fixture.files.delete(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest')));
  for(const retry of ['reset','uninstall','install']) await test('A failed '+retry+' retry after completed removal restores only deliberate app preference writes',async()=>scenario(async(h,c)=>{
    const staleDriver=structuredClone(c.dss.values());const installed=h.fixture.runtime+'/drivers/GalaxyXRNative',bundle='E:/Portable/GalaxyXRNative';
    for(const suffix of ['/driver.vrdrivermanifest','/bin/win64/driver_GalaxyXRNative.dll'])h.fixture.put(bundle+suffix,h.fixture.files.get(installed+suffix));
    const original=h.api.invoke;let removed=false;
    h.api.invoke=async(name,args)=>{
      if(name==='uninstall_galaxyxr_driver'&&!removed){
        removed=true;for(const path of [...h.fixture.files.keys()])if(path.startsWith(h.fixture.data+'/')||path.startsWith(installed+'/'))h.fixture.files.delete(path);
        return {outcome:'complete',preservedPaths:[],unresolvedItems:[],removedPaths:[],restoredSettings:0,legacyReset:false,warnings:[]};
      }
      if(['uninstall_galaxyxr_driver','clean_galaxyxr_settings','register_galaxyxr_driver'].includes(name))throw Error('Injected no-commit retry failure');
      return original(name,args);
    };
    assert.equal(await c.sds.uninstallDriver(c.appSetting),true);
    assert.equal(await c.appSetting.save({...c.appSetting.values(),colorScheme:'light'}),true);
    if(retry==='reset')assert.equal(await c.sds.cleanSettings(c.appSetting),undefined);
    else if(retry==='uninstall')assert.equal(await c.sds.uninstallDriver(c.appSetting),false);
    else assert.equal(await c.sds.installDriver(),false);
    assert.equal(await c.appSetting.save({...c.appSetting.values(),colorScheme:'dark'}),true);
    assert.equal(await c.dss.save(staleDriver),false);assert.equal(h.fixture.files.has(h.fixture.data+'/settings.json'),false);
  }));
  await test('A failed retry after incomplete removal keeps app and driver writes blocked',async()=>scenario(async(h,c)=>{
    const original=h.api.invoke;let attempted=false;
    h.api.invoke=async(name,args)=>{
      if(name!=='uninstall_galaxyxr_driver')return original(name,args);
      if(attempted)throw Error('Injected no-commit retry failure');attempted=true;
      return {outcome:'incomplete',preservedPaths:['recovery'],unresolvedItems:['Retry removal'],removedPaths:[],restoredSettings:0,legacyReset:false,warnings:[]};
    };
    assert.equal(await c.sds.uninstallDriver(c.appSetting),true);assert.equal(await c.sds.uninstallDriver(c.appSetting),false);
    assert.equal(await c.appSetting.save({...c.appSetting.values(),advanceMode:true}),false);assert.equal(c.appSetting.values().advanceMode,false);
  }));
  await test('Opening Companion after uninstall does not recreate files or directories',async()=>{
    const h=harness();for(const path of [...h.fixture.files.keys()])if(path.startsWith(h.fixture.data+'/'))h.fixture.files.delete(path);
    h.fixture.files.delete(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest');h.fixture.directories.clear();
    const paths=new (h.source('services/paths').PathsService)();await paths.initialize();
    const c=h.source('app-context').createAppContext(paths);
    try {
      await Promise.all([c.appSetting.initTask,c.dss.initTask,c.dis.initTask,c.sds.initTask]);await tick();await h.source('platform/writer').flushFileWrites();
      assert.equal(c.appSetting.values().advanceMode,false);assert.equal(c.appSetting.values().colorScheme,'dark');assert.equal(c.dss.values(),undefined);
      assert.equal(localFiles(h).length,0);assert.equal(h.fixture.directories.size,0);assert.equal(h.fixture.calls.filter(x=>x.kind==='write').length,0);
      // An intentional app preference edit remains possible in a fresh process.
      const save=c.appSetting.save({...c.appSetting.values(),colorScheme:'light'});await tick();await h.source('platform/writer').flushFileWrites();assert.equal(await save,true);
      assert.equal(JSON.parse(h.fixture.files.get(h.fixture.data+'/gui-settings.json')).colorScheme,'light');
    } finally {c.dispose();}
  });
  await test('Installation actions are owned by Setup, not About or App Settings',()=>{
    const base=path.join(__dirname,'../GalaxyXRDriverGUI/src-lit/features');
    for(const name of ['app-settings-page','about-page']) {
      const source=fs.readFileSync(path.join(base,name+'.ts'),'utf8');
      assert.equal(source.includes('app-driver-troubleshooter'),false);
      assert.equal(source.includes('@click=${() => this.installDriver()}'),false);
    }
    const setup=fs.readFileSync(path.join(base,'setup-page.ts'),'utf8');
    assert.match(setup,/Restore defaults/);
    assert.match(setup,/Driver initialization verified in SteamVR/);
    assert.match(setup,/app-driver-enable-banner/);
  });
  if(process.env.ABOUT_SETUP_REPORT)fs.writeFileSync(process.env.ABOUT_SETUP_REPORT,JSON.stringify(results,null,2)+'\n');console.log(`\nAbout/setup service checks: ${results.filter(r=>r.passed).length}/${results.length} passed.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
