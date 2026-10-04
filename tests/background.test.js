import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, defaultSettings } from '../src/store.js';
import { PatrolEngine } from '../src/engine.js';
import { DshModel } from '../src/model.js';
import { readingMaterial, parseReading, parseMemo, backgroundHash, backgroundInput } from '../src/background.js';
const note = n => ({ kind: 'note', sourceKey: 'note:' + String(n).padStart(24,'0'), title: '背景文章'+n, text: '本文称小鲸鱼是用户形象。', context: '', url: '', coverage: {} });
const reading = { summary: '本文解释角色称呼，但说法未独立核实。', observations: [{ kind:'term', subject:'小鲸鱼', explanation:'该来源将其称为用户形象', sourcePart:'正文', quote:'小鲸鱼是用户形象', status:'source_claim' }], uncertainties: [] };
const normal = { decision:'normal', categories:['正常讨论'], reason:'本条为感谢', targetQuote:'谢谢', interpretation:'感谢作者', evidence:[], findings:[], uncertainties:[], confidence:.8 };
async function* stream(value) { yield {type:'text-delta',index:0,text:JSON.stringify(value)}; yield {type:'finish',reason:{kind:'stop'}}; }
async function fixture(t, overrides={}) {
 const dir=await mkdtemp(join(tmpdir(),'patrol-background-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const model={selection:()=>({provider:'fixture',model:'text'}), readBackground:async()=>structuredClone(reading), summarizeBackground:async rows=>({memo:'人物与称呼：该来源称小鲸鱼为用户形象，其他解释尚未确认。['+rows[0].ref+']'}), analyze:async()=>normal,...overrides};
 const actual=new DshModel({agentDefaultModel:{currentSelection:model.selection}});model.cacheKey=actual.cacheKey.bind(actual);
 return new PatrolEngine(new Store(dir),{close:async()=>{}},model).init();
}
test('背景阅读保留来源原文，拒绝借错位置引文；模糊图片知识点不得标成事实',()=>{
 const material=readingMaterial({...note(1),vision:{pages:[{index:1,text:'模糊文字',description:'图像不清',uncertain:true}]},coverage:{imageCount:1}},[{text:'我反对',context:'回复某人'}]);
 assert.equal(parseReading(JSON.stringify(reading),material).observations[0].status,'source_claim');
 assert.throws(()=>parseReading(JSON.stringify({...reading,observations:[{...reading.observations[0],sourcePart:'评论1'}]}),material),/引文/);
 const blurred=parseReading(JSON.stringify({...reading,observations:[{...reading.observations[0],sourcePart:'配图1文字',quote:'模糊文字',status:'direct_observation'}]}),material);
 assert.equal(blurred.observations[0].status,'uncertain');assert.ok(blurred.uncertainties.length);
 assert.throws(()=>parseMemo('这是一段背景笔记但引用了未曾阅读的第三篇文章。[B3]',[{ref:'B1'}]),/来源/);
});
test('背景篇数额度独立，阅读不分类、不自动重跑未阅；重启仍保存背景',async t=>{
 let reads=0, analyses=0;const engine=await fixture(t,{readBackground:async()=>{reads++;return structuredClone(reading)},analyze:async()=>{analyses++;return normal}});
 const notes=[];for(let n=1;n<=3;n++)notes.push(await engine.store.upsert(note(n)));
 const texts=notes.map(n=>n.text);const rules=engine.store.data.settings.rules;
 await engine.startBackground({count:2,ids:notes.map(n=>n.id),refreshSources:false});await engine.active.promise;
 assert.equal(reads,2);assert.equal(analyses,0);assert.equal(engine.store.data.jobs.at(-1).backgroundCalls,3);
 assert.equal(engine.background().active.readings.length,2);assert.deepEqual(notes.map(n=>n.text),texts);assert.equal(engine.store.data.settings.rules,rules);
 assert.equal(engine.background().active.readings[0].parts,undefined);assert.ok(engine.store.data.background.active.readings[0].parts.length);
 const restarted=await new Store(engine.store.root).init();assert.equal(restarted.data.background.active.hash,engine.store.data.background.active.hash);
});
test('背景修改/开关影响缓存与统计；定向补读保留已阅且只调用目标',async t=>{
 const observed=[];const engine=await fixture(t,{analyze:async(i,s)=>{observed.push({id:i.id,b:s.backgroundContext,expanded:i.backgroundExpanded});return normal}});
 const n=await engine.store.upsert(note(1));const c=await engine.store.upsert({kind:'comment',sourceKey:'manual:test',text:'谢谢',title:'测试',context:'',coverage:{}});
 await engine.retry({id:c.id});await engine.active.promise;assert.equal(engine.isStale(c),false);
 await engine.startBackground({ids:[n.id],count:1,refreshSources:false});await engine.active.promise;assert.equal(engine.isStale(c),true);
 await engine.markRead({id:c.id});await engine.retry({id:c.id,backgroundExpanded:true});await engine.active.promise;
 assert.ok(c.readAt);assert.equal(engine.isStale(c),false);assert.equal(observed.at(-1).expanded,true);assert.ok(observed.at(-1).b.memo);
 const prev=engine.background().active.hash;
 await engine.updateBackground({memo:'用户纠正：小鲸鱼为用户形象，来源的其它说法尚待核对。[B1]'});
 assert.notEqual(engine.background().active.hash,prev);assert.equal(engine.isStale(c),true);assert.equal(engine.store.data.background.history.length,1);
 await engine.updateBackground({enabled:false});assert.equal(engine.analysisSettings(engine.store.data.settings).backgroundContext,null);assert.equal(observed.length,2);
});
test('背景全部失败或取消时旧背景不被替换；失败也计次数且不无限重试',async t=>{
 const engine=await fixture(t);const n=await engine.store.upsert(note(1));await engine.startBackground({ids:[n.id],count:1,refreshSources:false});await engine.active.promise;
 const original=engine.background().active.id;engine.model.readBackground=async()=>{throw new Error('服务失败')};
 await engine.startBackground({ids:[n.id],count:1,refreshSources:false});await engine.active.promise;
 assert.equal(engine.background().active.id,original);assert.equal(engine.background().draft.status,'failed');assert.equal(engine.store.data.jobs.at(-1).backgroundCalls,1);
 let entered;const started=new Promise(r=>entered=r);engine.model.readBackground=async(m,s,signal)=>{entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
 await engine.startBackground({ids:[n.id],count:1,refreshSources:false});await started;await engine.stop();
 assert.equal(engine.background().active.id,original);assert.equal(engine.background().draft.status,'cancelled');
});
test('背景确实进入每次模型及证据核对，原文选择受额度约束，无法冒充目标证据',async()=>{
 const readings=Array.from({length:8},(_,i)=>({...reading,ref:'B'+(i+1),itemId:String(i),sourceKey:'note:'+String(i).padStart(24,'0'),title:'背景'+i,contentHash:String(i),parts:[{label:'正文',text:'甲'.repeat(20000)}]}));
 const profile={id:'profile',memo:'该背景材料解释小鲸鱼等称呼。[B1]',readings};profile.hash=backgroundHash(profile);
 const item={kind:'comment',text:'谢谢',title:'目标',context:'',coverage:{},contentHash:'target'};const inputs=[];
 const model=new DshModel({agentDefaultModel:{currentSelection:()=>({provider:'fixture',model:'text'})},llm:{stream:o=>{inputs.push(JSON.parse(o.messages[0].content[0].text));return stream(normal)}}});
 const settings={...defaultSettings(),backgroundContext:profile};const out=await model.analyze(item,settings);
 assert.equal(inputs[0].background.environment.id,'profile');assert.equal(out.backgroundUsed.articlesRead,8);assert.equal(out.backgroundUsed.sourceRefs.length,3);
 const basic=backgroundInput(item,profile);const expanded=backgroundInput({...item,backgroundExpanded:true},profile,true);
 assert.equal(basic.references.length,3);assert.equal(expanded.references.length,6);assert.ok(expanded.references.flatMap(r=>r.parts).reduce((n,p)=>n+p.text.length,0)<=48000);
 const proposal={...normal,decision:'review',categories:['人身攻击'],evidence:['谢谢'],findings:[{category:'人身攻击',quote:'谢谢',target:'假设对象',behavior:'错误推测'}]};
 model.ctx.llm.stream=o=>{const input=JSON.parse(o.messages[0].content[0].text);inputs.push(input);return stream(input.proposedFindings ? {verdict:'unsupported',reason:'感谢不是侮辱',findings:[]} : proposal)};
 const checked=await model.analyze(item,settings);assert.equal(checked.decision,'normal');assert.equal(inputs.at(-1).background.environment.hash,profile.hash);
 assert.notEqual(model.cacheKey(item,settings),model.cacheKey(item,defaultSettings()));assert.notEqual(model.cacheKey({...item,backgroundExpanded:true},settings),model.cacheKey(item,settings));
});
test('背景阅读使用独立回复额度，截断即使带完整JSON也不进入背景',async()=>{
 const configs=[];
 const model=new DshModel({agentDefaultModel:{currentSelection:()=>({provider:'fixture',model:'text'})},llm:{stream:async function*(o){configs.push(o);yield {type:'text-delta',index:0,text:JSON.stringify(reading)};yield {type:'finish',reason:{kind:'max-tokens'}};}}});
 await assert.rejects(model.readBackground(readingMaterial(note(1)),defaultSettings()),/max-tokens/);
 assert.equal(configs.length,1);assert.equal(configs[0].maxTokens,16384);
});
test('背景要点附带分类兼容别名，来源及逐字引文校验不放宽',()=>{
 const material=readingMaterial(note(1));
 const value={...reading,observations:[{...reading.observations[0],kind:'claim'}]};
 assert.equal(parseReading(JSON.stringify(value),material).observations[0].kind,'reference');
 assert.throws(()=>parseReading(JSON.stringify({...value,observations:[{...value.observations[0],quote:'原文没有的话'}]}),material),/引文/);
});
test('内容和模型未变复用背景阅读，改正文或模型需新读；保留原文引文核对',async t=>{
 let calls=0;let route={provider:'fixture',model:'text'};
 const engine=await fixture(t,{selection:()=>route,readBackground:async()=>{calls++;return {...structuredClone(reading),route}}});
 const n=await engine.store.upsert(note(1));const plan={ids:[n.id],count:1,refreshSources:false};
 await engine.startBackground(plan);await engine.active.promise;
 await engine.startBackground(plan);await engine.active.promise;
 assert.equal(calls,1);assert.equal(engine.store.data.jobs.at(-1).backgroundCached,1);assert.equal(engine.store.data.jobs.at(-1).backgroundCalls,1);
 n.text+='新的背景内容。';await engine.startBackground(plan);await engine.active.promise;assert.equal(calls,2);
 route={provider:'fixture',model:'new'};await engine.startBackground(plan);await engine.active.promise;assert.equal(calls,3);
 engine.store.data.background.active.readings[0].observations[0].quote='不在原文里的引文';
 engine.store.data.background.history=[];engine.store.data.background.draft=null;
 await engine.startBackground(plan);await engine.active.promise;assert.equal(calls,4);
});
