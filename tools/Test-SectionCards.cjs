#!/usr/bin/env node
'use strict';
// Section ownership tests use the real helpers. With npm ci they use Lit's
// actual template objects; without dependencies an inert template adapter can
// validate grouping/CSS only. No adapter is shipped in production code.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../GalaxyXRDriverGUI'),requireGui=createRequire(root+'/package.json');
const ts=process.env.FLUENT_TEST_TYPESCRIPT?require(process.env.FLUENT_TEST_TYPESCRIPT):requireGui('typescript');
(async()=>{
 let lit,decorators,mode='real Lit templates';
 try{lit=await import(pathToFileURL(requireGui.resolve('lit')));decorators=await import(pathToFileURL(requireGui.resolve('lit/decorators.js')));}
 catch(e){if(e.code!=='MODULE_NOT_FOUND'&&e.code!=='ERR_MODULE_NOT_FOUND')throw e;mode='inert template adapter (not a production Lit render)';lit={LitElement:class{},html:(strings,...values)=>({strings,values}),css:(strings,...values)=>({cssText:strings.reduce((s,v,i)=>s+v+(values[i]?.cssText??values[i]??''),'')})};decorators={property:()=>()=>{}};}
 const cache=new Map();
 function load(file){if(cache.has(file))return cache.get(file);const module={exports:{}};cache.set(file,module.exports);const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,useDefineForClassFields:false}}).outputText;const req=id=>id==='lit'?lit:id==='lit/decorators.js'?decorators:id.endsWith('/i18n')?{t:s=>s}:load(path.resolve(path.dirname(file),id+'.ts'));vm.runInNewContext('(function(require,module,exports){'+js+'})',{WeakMap,Math,String})(req,module,module.exports);cache.set(file,module.exports);return module.exports;}
 const h=load(root+'/src-lit/features/page-base.ts'),html=lit.html;let count=0;
 function test(name,fn){fn();count++;console.log('PASS '+name);}
 function children(t){return Array.isArray(t.values?.at(-1))?t.values.at(-1):[];}
 function flatten(v){if(Array.isArray(v))return v.map(flatten).join('');if(v?.strings)return v.strings.reduce((s,text,i)=>s+text+flatten(v.values[i]),'');if(typeof v==='function'||v==null)return '';return String(v);}
 function handlers(v){if(Array.isArray(v))return v.flatMap(handlers);if(typeof v==='function')return [v];return v?.values?handlers(v.values):[];}
 function maxCardDepth(v,depth=0){if(Array.isArray(v))return Math.max(depth,...v.map(child=>maxCardDepth(child,depth)));if(!v?.strings)return depth;const next=depth+(v.strings[0].includes('<section class="section-card')?1:0);return Math.max(next,...v.values.map(child=>maxCardDepth(child,next)));}
 const parentRow=h.fieldRow('Official Controller Input Profile',html`<input type="checkbox" aria-label="Official Controller Input Profile">`);
 const childRow=h.fieldRow('Grip Convention',html`<input type="checkbox" checked aria-label="Grip Convention">`);
 const deepRow=h.fieldRow('Prediction strength',html`<input type="number" value="1.15" aria-label="Prediction strength">`);
 const imageRow=h.fieldRow('Brightness',html`<input type="number" value="1" aria-label="Brightness">`);
 const bypassRow=h.fieldRow('Controller Bypass',html`<input type="checkbox">`);
 const offsetRow=h.fieldRow('Rotation Offset',html`<input type="number">`);
 let clicks=0;
 const cards=h.sectionCards([h.sectionRow('Controllers',true,0,()=>clicks++),parentRow,h.sectionRow('Controller Fix',true,1,()=>clicks++),childRow,h.sectionGroup('Kalman Advanced Settings',2),deepRow,h.sectionGroup('Controllers Advanced',1),bypassRow,h.sectionRow('Controller Offsets',true,2,()=>clicks++),offsetRow,h.sectionHeading('Image Processing'),h.sectionRow('Color',true,1,()=>clicks++),imageRow]);
 const roots=cards.values[0];
 test('Top-level headings produce separate cards',()=>assert.equal(roots.length,2));
 test('Parent controls belong to their parent card body',()=>assert.equal(children(roots[0])[0],parentRow));
 test('Child controls are nested inside a second card, not flat siblings',()=>assert.equal(children(children(roots[0])[1])[0],childRow));
 test('Kalman advanced fields retain ownership in a plain labeled group',()=>{
   const group=children(children(roots[0])[1])[1];assert.equal(children(group)[0],deepRow);
   assert.match(flatten(group),/class="section-group advanced"/);assert.match(flatten(group),/Kalman Advanced Settings/);
   assert.doesNotMatch(flatten(group),/section-card|aria-expanded|chevron/);assert.equal(handlers(group).length,0);
 });
 test('Controllers Advanced belongs beside Controller Fix and owns its offset fields',()=>{
   const controllerChildren=children(roots[0]),advanced=controllerChildren[2];
   assert.equal(controllerChildren.length,3);assert.equal(children(advanced)[0],bypassRow);
   assert.equal(children(children(advanced)[1])[0],offsetRow);
   assert.doesNotMatch(flatten(controllerChildren[1]),/Controller Bypass|Rotation Offset/);
 });
 test('Inline ownership groups never add a third nested card',()=>assert.equal(maxCardDepth(cards),2));
 test('Excess card hierarchy becomes a plain visible group',()=>{
   const nested=h.sectionCards([h.sectionRow('One',true,0,()=>clicks++),h.sectionRow('Two',true,1,()=>clicks++),h.sectionRow('Three',false,2,()=>clicks++),deepRow]);
   assert.equal(maxCardDepth(nested),2);assert.match(flatten(nested),/class="section-group source"/);
   assert.match(flatten(nested),/Prediction strength/);assert.equal(handlers(nested).length,2);
 });
 test('Source labels group diagnostics without introducing a card or collapse action',()=>{
   const source=h.sectionCards([h.sectionGroup('Controllers',0,'source'),deepRow]);
   assert.equal(maxCardDepth(source),0);assert.equal(handlers(source).length,0);
   assert.match(flatten(source),/class="section-group source"/);assert.match(flatten(source),/Prediction strength/);
 });
 test('Image Processing owns its Color section',()=>assert.equal(children(children(roots[1])[0])[0],imageRow));
 test('Header rendering never calls feature actions or saves settings',()=>assert.equal(clicks,0));
 test('Collapsing removes descendant controls but keeps an accessible header',()=>{const t=h.sectionCards([h.sectionRow('Closed',false,0,()=>{}),childRow]);const text=flatten(t);assert.ok(!text.includes('Grip Convention'));assert.match(text,/aria-expanded=false/);assert.match(text,/aria-controls=settings-section-0-body/);});
 test('Closing a parent card also hides its inline advanced controls',()=>{const t=h.sectionCards([h.sectionRow('Controllers',false,0,()=>{}),h.sectionGroup('Controllers Advanced',1),bypassRow]);assert.doesNotMatch(flatten(t),/Controllers Advanced|Controller Bypass/);});
 test('No redundant Expand or Collapse labels remain',()=>assert.doesNotMatch(flatten(cards),/>\s*(Expand|Collapse)\s*</));
 test('Rows before the first heading stay outside section cards',()=>{const t=h.sectionCards([parentRow,h.sectionHeading('Section'),childRow]);assert.equal(t.values[0][0],parentRow);assert.equal(children(t.values[0][1])[0],childRow);});
 test('All seven pages use the shared state-aware grouping helper',()=>{for(const file of ['driver-settings-page','stream-frame-page','debug-page','distortion-profile-page','app-settings-page','about-page','setup-page'])assert.match(fs.readFileSync(root+'/src-lit/features/'+file+'.ts','utf8'),/this\.sectionCardsFor\((body|parts|\[)/,file);});
 test('Page grouping uses saved heading state and toggles without saving driver settings',()=>{
   let state={'heading:Image Processing':false},updates=0;
   const page={ctx:{galaxy:{sections:Object.assign(()=>state,{set:next=>{state=next;updates++;}})}},toggleSection:h.BasePage.prototype.toggleSection};
   const rows=[h.sectionHeading('Image Processing'),imageRow];
   const closed=h.BasePage.prototype.sectionCardsFor.call(page,rows);
   assert.doesNotMatch(flatten(closed),/Brightness/);
   assert.match(flatten(closed),/aria-expanded=false/);
   const [toggle]=handlers(closed);assert.equal(typeof toggle,'function');toggle();
   assert.equal(updates,1);assert.equal(state['heading:Image Processing'],true);
   assert.match(flatten(h.BasePage.prototype.sectionCardsFor.call(page,rows)),/Brightness/);
 });
 test('Fresh headings collapse on the first click, retain state across tabs, and work after restart',()=>{
   // Each session starts with only the explicitly declared section defaults.
   for(let session=0;session<2;session++){
     let state={color:true,debug:false},updates=0;
     const ctx={galaxy:{sections:Object.assign(()=>state,{set:next=>{state=next;updates++;}})}};
     // Recreate the page for each render, as switching tabs does, while
     // keeping the application-owned section state.
     const render=(title,row)=>h.BasePage.prototype.sectionCardsFor.call(
       {ctx,toggleSection:h.BasePage.prototype.toggleSection},[h.sectionHeading(title),row]);
     for(const [title,row,content] of [['Image Processing',imageRow,'Brightness'],['Setup',childRow,'Grip Convention']]){
       const initial=render(title,row);
       assert.match(flatten(initial),/aria-expanded=true/);
       assert.ok(flatten(initial).includes(content));
       handlers(initial)[0]();
       assert.equal(state['heading:'+title],false,'first click must close '+title);
       const closed=render(title,row);
       assert.match(flatten(closed),/aria-expanded=false/);
       assert.ok(!flatten(closed).includes(content));
     }
     assert.equal(updates,2);
     const revisited=render('Image Processing',imageRow);
     assert.match(flatten(revisited),/aria-expanded=false/);
     handlers(revisited)[0]();
     assert.ok(flatten(render('Image Processing',imageRow)).includes('Brightness'));
     assert.equal(state['heading:Setup'],false);
     assert.equal(state.color,true);assert.equal(state.debug,false);
     assert.equal(updates,3);
   }
 });
 test('Explicitly open and closed feature sections still toggle on the first click',()=>{
   let state={color:true,debug:false};
   const page={ctx:{galaxy:{sections:Object.assign(()=>state,{set:next=>{state=next;}})}},toggleSection:h.BasePage.prototype.toggleSection};
   for(const key of ['color','debug']){
     const initial=state[key];
     const cards=h.BasePage.prototype.sectionCardsFor.call(page,[h.sectionRow(key,initial,0,()=>page.toggleSection(key)),imageRow]);
     handlers(cards)[0]();
     assert.equal(state[key],!initial);
   }
 });
 // Real BasePage target method with inert DOM endpoints. No settings service
 // write is provided: revealing a destination must only touch presentation.
 {
   const defaults=load(root+'/src-lit/domain/driver-defaults.ts').driverDefaults;
   const snapshot=JSON.stringify(defaults);let state={},focused='',scrolled=false,updates=0,revealedClass='',blurHook=false;
   const page={
     ctx:{dss:{values:()=>defaults},appSetting:{values:()=>({advanceMode:false}),readFileError:()=>undefined},sds:{driverInstalled:()=> '1.2.3'},
       galaxy:{vendor:'galaxyxr',sections:Object.assign(()=>state,{set:next=>{state=next;updates++;}})}},
     revealAdvanced:false,requestUpdate:()=>{},updateComplete:Promise.resolve(),isConnected:true,
     shadowRoot:{getElementById:id=>({focus:()=>{focused=id;},scrollIntoView:()=>{scrolled=true;},
       classList:{add:c=>{revealedClass=c;},remove:()=>{revealedClass='';}},addEventListener:ev=>{blurHook=ev==='blur';}})},
   };
   const reason=await h.BasePage.prototype.showSetting.call(page,'streamFrame.nvencForceCbr');
   test('Show setting expands stable ancestors and focuses the field without saving',()=>{
     assert.equal(reason,undefined);assert.equal(state['heading:encoder'],true);assert.equal(Object.hasOwn(state,'encoderAdv'),false);
     assert.equal(focused,'setting-streamFrame.nvencForceCbr');assert.equal(scrolled,true);assert.equal(page.revealAdvanced,true);
     assert.equal(revealedClass,'revealed');assert.equal(blurHook,true);
     assert.equal(page.ctx.appSetting.values().advanceMode,false);assert.equal(JSON.stringify(defaults),snapshot);
   });
   h.BasePage.prototype.clearSettingTarget.call(page);
   const countBefore=updates;
   const blocked=await h.BasePage.prototype.showSetting.call(page,'streamFrame.dither');
   test('Leaving a target removes temporary visibility and hidden features stay off',()=>{
     assert.equal(page.revealAdvanced,false);assert.match(blocked,/Image Enhancements is off/);assert.equal(updates,countBefore);
     assert.equal(defaults.streamFrame.enable,false);assert.equal(JSON.stringify(defaults),snapshot);
   });
 }
 test('Checker fields share their catalog label and stable focus ID',()=>{
   const row=flatten(h.settingFieldRow('streamFrame.nvencForceCbr',html`<input type="checkbox">`));
   assert.match(row,/setting-streamFrame.nvencForceCbr/);assert.match(row,/Constant Bitrate/);assert.match(row,/tabindex=-1/);
 });
 test('Explicit heading keys survive localized label changes',()=>{
   const cards=h.sectionCards([h.sectionHeading('Translated encoder',0,'encoder'),imageRow],{sections:{'heading:encoder':false},onToggle:()=>{}});
   assert.match(flatten(cards),/aria-expanded=false/);assert.doesNotMatch(flatten(cards),/Brightness/);
 });
 test('Shared styles indent complete child cards and collapse cleanly on narrow screens',()=>{assert.match(h.fieldStyles.cssText,/\.section-body\s*\{[^}]*padding: 4px 16px 12px 22px/);assert.match(h.fieldStyles.cssText,/\.section-body > \.section-card\s*\{[^}]*margin: 12px 0 8px 12px/);assert.match(h.fieldStyles.cssText,/\.section-card \.field \.title::after \{ display: none/);});
 console.log(`${count} section-card checks passed using ${mode}.`);
 if(process.env.SECTION_CARD_FIXTURE){let markup=flatten(cards).replace(/\?hidden=false/g,'').replace(/\?hidden=true/g,'hidden').replace(/@click=\s*/g,'');fs.writeFileSync(process.env.SECTION_CARD_FIXTURE,`<!doctype html><html><head><meta charset="utf-8"><style>:root{--colorNeutralForeground1:#242424;--colorNeutralBackground1:#fff;--colorNeutralBackground2:#fafafa;--colorNeutralBackground3:#f5f5f5;--colorNeutralStroke2:#d1d1d1;--colorNeutralStroke1:#c7c7c7;--colorBrandStroke1:#0f6cbd;--colorNeutralStrokeAccessible:#616161;}body{margin:0;padding:16px;font:16px system-ui;background:var(--colorNeutralBackground2);color:var(--colorNeutralForeground1)}input{max-width:140px} ${h.fieldStyles.cssText}</style></head><body><p>Layout-only fixture: production grouping helper and CSS; native controls substitute for Fluent controls.</p>${markup}</body></html>`);}
})().catch(e=>{console.error(e);process.exitCode=1;});
