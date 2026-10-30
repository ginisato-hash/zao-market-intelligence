// Actual Git repositories and actual source imports in temporary synthetic fixtures.
// Copies source/package files only; canonical market data and credentials are never read.
import {it,expect} from 'vitest';
import {cpSync,copyFileSync,mkdirSync,mkdtempSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const repository=fileURLToPath(new URL('../',import.meta.url)),loader=join(repository,'node_modules/tsx/dist/loader.mjs');
type Mode='history-data'|'source-commit'|'test-commit'|'dependency-commit'|'unknown-commit'|'dirty-source'|'dirty-unknown'|'ancestor'|'non-descendant'|'module-replaced'|'module-alias'|'source-root-alias'|'dependency-alias'|'same-checkout'|'mid-transaction';
function run(mode:Mode){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mirror-execution-'))),code=join(root,'code'),data=join(root,'data');mkdirSync(code);mkdirSync(data);
 cpSync(join(repository,'src'),join(code,'src'),{recursive:true});for(const name of ['package.json','package-lock.json','tsconfig.json'])copyFileSync(join(repository,name),join(code,name));
 symlinkSync(realpathSync(join(repository,'node_modules')),join(code,'node_modules'));writeFileSync(join(code,'.gitignore'),'node_modules\n');mkdirSync(join(code,'tests'));writeFileSync(join(code,'tests/guard-marker.txt'),'original\n');
 const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@local.invalid','-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 for(const repo of [code,data])git(repo,'init','-q');git(code,'add','.');git(code,'commit','-qm','fixture source');git(code,'commit','--allow-empty','-qm','stable execution pin');
 const script=String.raw`
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,renameSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};
const code=${JSON.stringify(code)},data=${JSON.stringify(data)},mode=${JSON.stringify(mode)};
const git=(root,...a)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@local.invalid','-C',root,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const {default:Database}=await import(pathToFileURL(join(code,'node_modules/better-sqlite3/lib/index.js')).href);
const {prepareMirrorRecovery,extendPreparedMirrorRecoveryAppendOnly}=await import(pathToFileURL(join(code,'src/services/marketMirrorRecoveryPlan.ts')).href);
const {ensureMirrorSchema}=await import(pathToFileURL(join(code,'src/services/historyToDbSyncRealRun.ts')).href);
const {parseCsvTable}=await import(pathToFileURL(join(code,'src/services/historyToDbSyncDryRun.ts')).href);
const {HISTORY_CSV_HEADERS,renderHistoryCsv,buildRowId,buildRowHash}=await import(pathToFileURL(join(code,'src/services/localHistorySchemaDesign.ts')).href);
const {parseShardRows}=await import(pathToFileURL(join(code,'src/services/localHistoryRealAppend.ts')).href);
const row=day=>{const r=Object.fromEntries(HISTORY_CSV_HEADERS.map(k=>[k,'']));Object.assign(r,{shard_month:'2027_01',source:'booking',source_phase:'fixture',collector_stage:'fixture',canonical_property_name:'Fixture',source_property_name:'Fixture',source_slug_or_code:'fixture',source_property_id:'fixture',property_identity_match:'true',collected_date_jst:'2026-10-24',collected_at_jst:'2026-10-24T12:00:00+09:00',normalized_at_jst:'2026-10-24T12:00:00+09:00',checkin:'2027-01-0'+day,checkout:'2027-01-0'+(day+1),stay_nights:'1',group_adults:'2',group_children:'0',no_rooms:'1',currency:'JPY',language:'ja',stay_scope:'one_night',availability_status:'available',sold_out_status:'not_sold_out',normalized_total_price:'20000',basis_confidence:'A',source_classification:'fixture',is_price_usable_for_dp_direct:'true',is_price_usable_for_dp_directional:'false',is_price_excluded_from_dp:'false',schema_version:'fixture'});const p=parseShardRows(HISTORY_CSV_HEADERS.join(',')+'\n'+HISTORY_CSV_HEADERS.map(k=>r[k]).join(',')+'\n')[0];p.rowId=buildRowId(p);p.rowHash=buildRowHash(p);return p;};
const history=join(mode==='same-checkout'?code:data,'.data/history');mkdirSync(history,{recursive:true});const file=join(history,'zao_signals_2027_01.csv');writeFileSync(file,renderHistoryCsv([row(1),row(2)]));
const historyRepo=mode==='same-checkout'?code:data;git(historyRepo,'add','.');git(historyRepo,'commit','-qm','fixture history');
const pins=()=>{const bytes=readFileSync(file);return [{name:'zao_signals_2027_01.csv',sha256:createHash('sha256').update(bytes).digest('hex'),rows:parseCsvTable(bytes.toString()).rows.length}]};
const db=new Database(':memory:');ensureMirrorSchema(db);let p,q,reason=null;
try{
 p=prepareMirrorRecovery(db,history,pins());const initialCode=git(code,'rev-parse','HEAD'),oldData=git(historyRepo,'rev-parse','HEAD');writeFileSync(file,Buffer.concat([readFileSync(file),Buffer.from(renderHistoryCsv([row(3)]).split('\n').slice(1).join('\n'))]));
 if(mode==='history-data'){git(data,'add','.');git(data,'commit','-qm','natural history append');}
 if(mode==='source-commit'||mode==='dirty-source')writeFileSync(join(code,'src/guard-marker.txt'),'changed');
 if(mode==='test-commit')writeFileSync(join(code,'tests/guard-marker.txt'),'changed');
 if(mode==='dependency-commit')writeFileSync(join(code,'package-lock.json'),readFileSync(join(code,'package-lock.json'),'utf8')+'\n');
 if(mode==='unknown-commit'||mode==='dirty-unknown')writeFileSync(join(code,'unknown.txt'),'changed');
 if(['source-commit','test-commit','dependency-commit','unknown-commit'].includes(mode)){git(code,'add','.');git(code,'commit','-qm','unaccepted execution change');}
 if(mode==='ancestor')git(code,'checkout','--detach','HEAD^');
 if(mode==='non-descendant'){git(code,'checkout','--orphan','other');git(code,'add','.');git(code,'commit','-qm','unrelated source');}
 if(mode==='module-replaced'){const path=join(code,'src/services/marketMirrorRecoveryPlan.ts'),bytes=readFileSync(path);renameSync(path,path+'.old');writeFileSync(path,bytes);unlinkSync(path+'.old');}
 if(mode==='module-alias'){const path=join(code,'src/services/marketMirrorRecoveryPlan.ts');renameSync(path,path+'.old');symlinkSync(path+'.old',path);}
 if(mode==='source-root-alias'){renameSync(code,code+'.old');symlinkSync(code+'.old',code);}
 if(mode==='dependency-alias'){const other=code+'-other-dependencies';mkdirSync(other);unlinkSync(join(code,'node_modules'));symlinkSync(other,join(code,'node_modules'));}
 if(mode==='mid-transaction'){
   const original=db.prepare.bind(db);let calls=0;
   db.prepare=function(sql){if(sql.includes('FROM market_signal_history LIMIT 200001')&&++calls===2)writeFileSync(join(code,'unknown.txt'),'changed');return original(sql);};
   try{extendPreparedMirrorRecoveryAppendOnly(p,pins());throw Error('EXPECTED_GUARD_REFUSAL')}catch(e){if(!e.message.includes('EXECUTION_SOURCE_DIRTY'))throw e;reason=e.message;}
   unlinkSync(join(code,'unknown.txt'));db.prepare=original;q=extendPreparedMirrorRecoveryAppendOnly(p,pins()).prepared;console.log(JSON.stringify({passed:true,historyRows:q.plan.historyRows,oldHandleSurvivedRefusal:true,reason}));
 }else{
   const r=extendPreparedMirrorRecoveryAppendOnly(p,pins());q=r.prepared;if(mode!=='history-data')throw Error('UNEXPECTED_PASS');console.log(JSON.stringify({passed:true,historyRows:q.plan.historyRows,dataHeadChanged:git(data,'rev-parse','HEAD')!==oldData,codeHeadUnchanged:git(code,'rev-parse','HEAD')===initialCode,releaseUnchanged:q.plan.releaseGitSha===p.plan.releaseGitSha}));
 }
}catch(e){if(mode==='history-data'||mode==='mid-transaction')throw e;console.log(JSON.stringify({refused:true,reason:String(e.message).replaceAll(code,'[fixture]').replaceAll(data,'[fixture]')}));}finally{q?.close();p?.close();db.close();}
`;
 const path=join(root,'child.mjs');writeFileSync(path,script.replaceAll('\\n','\n'));
 return JSON.parse(execFileSync(process.execPath,['--import',loader,path],{cwd:root,encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'/usr/bin:/bin',TZ:'Asia/Tokyo'}}).trim());
}
it('separate execution survives canonical history append and real data-only Git commit',()=>expect(run('history-data')).toMatchObject({passed:true,historyRows:3,dataHeadChanged:true,codeHeadUnchanged:true,releaseUnchanged:true}));
for(const mode of ['source-commit','test-commit','dependency-commit','unknown-commit','dirty-source','dirty-unknown','ancestor','non-descendant','module-replaced','module-alias','source-root-alias','dependency-alias','same-checkout']as Mode[])it('refuses execution '+mode,()=>{const r=run(mode);expect(r.refused).toBe(true);expect(r.reason).toMatch(/EXECUTION_SOURCE|APPEND_RELEASE_CHANGED|ISOLATED_EXECUTION/);});
it('execution refusal inside the RAM transaction rolls back and preserves the old handle',()=>expect(run('mid-transaction')).toMatchObject({passed:true,historyRows:3,oldHandleSurvivedRefusal:true}));
