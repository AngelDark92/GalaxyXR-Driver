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
const stockEncoderConfig = {streamFrame:{
  nvencSettingsVersion:4,nvencTap:false,nvencFixLevel:false,nvencForceCbr:false,
  nvencBitrateScale:false,nvencPresetMerge:false,nvencVbvFrames:0,
  nvencLowDelayKfScale:0,nvencForceFps:0,nvencSplitMode:0,
  postPack:{enable:false,casEnable:false},
}};
async function scenario(fn, setup) { const h=harness(); setup?.(h); const c=await h.app(); c.dialog.confirm=async()=>true; c.dialog.message=async()=>{}; try { await fn(h,c); } finally {c.dispose();} }
function cleanMock(h, next) {
  const invoke=h.api.invoke;
  h.api.invoke=async (name,args)=>{
    if(name!=='clean_galaxyxr_settings')return invoke(name,args);
    h.fixture.calls.push({kind:'invoke',name,args});
    if(next) return next(args);
    h.fixture.put(h.fixture.data+'/settings.json',stockEncoderConfig);
    h.fixture.files.delete(h.fixture.data+'/info.json');h.fixture.files.delete(h.fixture.data+'/diagnostic.json');
    return {backupPath:'D:/Backups/test',resetFiles:['settings.json'],restoredSettings:2,removedIdentityKeys:[],removedIdentitySections:[],steamvrCleaned:!!args.steamvrPath,warnings:[]};
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
  await test('Cleanup fixture exactly matches the native stock encoder reset contract',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../GalaxyXRDriverGUI/src-tauri/src/driver_installation/settings_cleanup.rs'),'utf8');
    const literal=source.match(/fn clean_driver_config\(\) -> Value \{[\s\S]*?json!\((\{[\s\S]*?\})\)\s*\}/);
    assert.ok(literal,'native clean_driver_config JSON is available');assert.deepEqual(JSON.parse(literal[1]),stockEncoderConfig);
  });
  await test('Cancelled cleanup does not call native reset or change saved files',async()=>scenario(async(h,c)=>{cleanMock(h);c.dialog.confirm=async()=>false;const before=h.fixture.files.get(h.fixture.data+'/settings.json');assert.equal(await c.sds.cleanSettings(c.appSetting),undefined);assert.equal(h.fixture.files.get(h.fixture.data+'/settings.json'),before);assert.equal(h.fixture.calls.filter(x=>x.name==='clean_galaxyxr_settings').length,0);assert.equal(c.sds.installingDriver(),false);}));
  await test('Cleanup before driver installation is available and preserves the uninstalled state',async()=>scenario(async(h,c)=>{cleanMock(h);const r=await c.sds.cleanSettings(c.appSetting);assert.equal(r.backupPath,'D:/Backups/test');assert.equal(c.sds.driverInstalled(),undefined);assert.equal(c.sds.installingDriver(),false);assert.equal(c.dss.values().galaxyXr.nativeIdentity,true);},h=>h.fixture.files.delete(h.fixture.runtime+'/drivers/GalaxyXRNative/driver.vrdrivermanifest')));
  await test('Cleanup without registered SteamVR passes null to native local-only reset',async()=>scenario(async(h,c)=>{cleanMock(h);const r=await c.sds.cleanSettings(c.appSetting);assert.ok(r);const call=h.fixture.calls.find(x=>x.name==='clean_galaxyxr_settings');assert.equal(call.args.steamvrPath,null);assert.equal(r.steamvrCleaned,false);},h=>h.fixture.files.delete(h.fixture.openvr)));
  await test('Successful reset reloads stock encoder toggles, keeps app preferences, and clears runtime data',async()=>scenario(async(h,c)=>{
    cleanMock(h);const r=await c.sds.cleanSettings(c.appSetting);assert.ok(r);assert.equal(c.dss.values().galaxyXr.nativeIdentity,true);
    assert.equal(c.appSetting.values().advanceMode,true);assert.equal(c.dis.values(),undefined);assert.equal(c.sds.driverInstalled(),'1.2.3');assert.equal(c.dss.inspecting,false);assert.equal(c.appSetting.inspecting,false);
    await tick();const expected=stockEncoderConfig.streamFrame;
    for(const [key,value] of Object.entries(expected)){
      if(key==='postPack')for(const [field,enabled] of Object.entries(value))assert.equal(c.dss.values().streamFrame.postPack[field],enabled,key+'.'+field);
      else assert.equal(c.dss.values().streamFrame[key],value,key);
      if(typeof value==='boolean')assert.equal(c.galaxy.rootSetting.streamFrame[key],false,key+' switch');
    }
    assert.equal(c.galaxy.rootSetting.streamFrame.postPack.enable,false);assert.equal(c.galaxy.rootSetting.streamFrame.postPack.casEnable,false);
    await h.source('platform/writer').flushFileWrites();assert.deepEqual(JSON.parse(h.fixture.files.get(h.fixture.data+'/settings.json')),stockEncoderConfig);
  }));
  await test('Pending edits cannot rewrite freshly cleaned configuration',async()=>scenario(async(h,c)=>{cleanMock(h);const edited=structuredClone(c.dss.values());edited.galaxyXr.nativeIdentity=false;edited.streamFrame.nvencTap=true;const pending=c.dss.save(edited);await tick();await c.sds.cleanSettings(c.appSetting);await pending;await h.source('platform/writer').flushFileWrites();assert.deepEqual(JSON.parse(h.fixture.files.get(h.fixture.data+'/settings.json')),stockEncoderConfig);assert.equal(c.dss.values().galaxyXr.nativeIdentity,true);assert.equal(c.dss.values().streamFrame.nvencTap,false);}));
  await test('Native cleanup failure reloads unchanged files and always clears busy state',async()=>scenario(async(h,c)=>{cleanMock(h,()=>{throw Error('SteamVR is running')});let message='';c.dialog.message=async(_,v)=>{message=v};const before=h.fixture.files.get(h.fixture.data+'/settings.json');assert.equal(await c.sds.cleanSettings(c.appSetting),undefined);assert.match(message,/SteamVR is running/);assert.equal(h.fixture.files.get(h.fixture.data+'/settings.json'),before);assert.equal(c.sds.installingDriver(),false);assert.equal(c.dss.inspecting,false);}));
  await test('Cleanup is serialized against installation and other cleanup requests',async()=>scenario(async(h,c)=>{let release;cleanMock(h,()=>new Promise(r=>release=r));const a=c.sds.cleanSettings(c.appSetting);while(!release)await tick();assert.equal(await c.sds.cleanSettings(c.appSetting),undefined);release({backupPath:'B',resetFiles:[],restoredSettings:0,removedIdentityKeys:[],removedIdentitySections:[],steamvrCleaned:true,warnings:[]});await a;assert.equal(h.fixture.calls.filter(x=>x.name==='clean_galaxyxr_settings').length,1);}));
  await test('Installation actions are owned by Setup, not About or App Settings',()=>{
    const base=path.join(__dirname,'../GalaxyXRDriverGUI/src-lit/features');
    for(const name of ['app-settings-page','about-page']) {
      const source=fs.readFileSync(path.join(base,name+'.ts'),'utf8');
      assert.equal(source.includes('app-driver-troubleshooter'),false);
      assert.equal(source.includes('@click=${() => this.installDriver()}'),false);
    }
    const setup=fs.readFileSync(path.join(base,'setup-page.ts'),'utf8');
    assert.match(setup,/Clean Settings/);
    assert.match(setup,/Driver initialization verified in SteamVR/);
    assert.match(setup,/app-driver-enable-banner/);
  });
  if(process.env.ABOUT_SETUP_REPORT)fs.writeFileSync(process.env.ABOUT_SETUP_REPORT,JSON.stringify(results,null,2)+'\n');console.log(`\nAbout/setup service checks: ${results.filter(r=>r.passed).length}/${results.length} passed.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
