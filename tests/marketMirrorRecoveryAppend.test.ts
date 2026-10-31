// Temporary synthetic CSV/SQLite fixtures only. No production paths or APIs.
import {describe,it,expect,vi} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,unlinkSync,renameSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareMirrorRecovery,extendPreparedMirrorRecoveryAppendOnly,applyMirrorDatabaseRecovery,persistMirrorRecoveryPlan,publishRecoveredLegacyHistory,withMirrorRecoveryLock,type PreparedMirrorRecovery,type MirrorRecoveryAcceptance} from '../src/services/marketMirrorRecoveryPlan';
import {ensureMirrorSchema,applyRealSync} from '../src/services/historyToDbSyncRealRun';
import {mapHistoryRowToMarketSignalHistoryRow,parseCsvTable} from '../src/services/historyToDbSyncDryRun';
import {HISTORY_CSV_HEADERS,buildRowId,buildRowHash,renderHistoryCsv,type HistoryRow} from '../src/services/localHistorySchemaDesign';
import {parseShardRows,APPEND_LOCK_FILENAME} from '../src/services/localHistoryRealAppend';
import * as historyPolicy from '../src/services/localHistoryAppendValidationPolicy';
const AT='2026-10-31T00:00:00+09:00',REF='https://github.com/ginisato-hash/zao-market-intelligence-private/issues/13#issuecomment-9999999999';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function row(day:number,month='01'):HistoryRow{
 const raw:Record<string,string>=Object.fromEntries(HISTORY_CSV_HEADERS.map(k=>[k,'']));
 Object.assign(raw,{shard_month:'2027_'+month,source:'booking',source_phase:'fixture',collector_stage:'fixture',canonical_property_name:'Fixture',source_property_name:'Fixture',source_slug_or_code:'fixture',source_property_id:'fixture',property_identity_match:'true',collected_date_jst:'2026-10-24',collected_at_jst:'2026-10-24T12:00:00+09:00',normalized_at_jst:'2026-10-24T12:00:00+09:00',checkin:`2027-${month}-${String(day).padStart(2,'0')}`,checkout:`2027-${month}-${String(day+1).padStart(2,'0')}`,stay_nights:'1',group_adults:'2',group_children:'0',no_rooms:'1',currency:'JPY',language:'ja',stay_scope:'one_night',availability_status:'available',sold_out_status:'not_sold_out',normalized_total_price:'20000',basis_confidence:'A',source_classification:'fixture',is_price_usable_for_dp_direct:'true',is_price_usable_for_dp_directional:'false',is_price_excluded_from_dp:'false',schema_version:'fixture'});
 const parsed=parseShardRows(HISTORY_CSV_HEADERS.join(',')+'\n'+HISTORY_CSV_HEADERS.map(k=>raw[k]).join(',')+'\n')[0]!;parsed.rowId=buildRowId(parsed);parsed.rowHash=buildRowHash(parsed);return parsed;
}
const accept=(p:PreparedMirrorRecovery):MirrorRecoveryAcceptance=>({purpose:'MIRROR_RECONCILIATION',planSha256:p.plan.planSha256,releaseGitSha:p.plan.releaseGitSha,tdAcceptanceRef:REF,ownerApprovalRef:REF});
function fixture(existing:HistoryRow[]=[row(1)],fileDb=false,aliasDb=false){
 const dir=mkdtempSync(join(tmpdir(),'mirror-append-')),path=join(dir,'zao_signals_2027_01.csv');writeFileSync(path,renderHistoryCsv([row(1),row(2)]));
 if(aliasDb){new Database(join(dir,'market.sqlite')).close();symlinkSync(join(dir,'market.sqlite'),join(dir,'alias.sqlite'));}
 const db=new Database(fileDb?join(dir,aliasDb?'alias.sqlite':'market.sqlite'):':memory:');ensureMirrorSchema(db);db.exec("CREATE TABLE protected_state(v TEXT); INSERT INTO protected_state VALUES('KEEP')");
 if(existing.length)applyRealSync({db,runId:'fixture',generatedAtJst:AT,reportPath:'fixture',sourceHistoryFiles:[],rows:parseCsvTable(renderHistoryCsv(existing)).rows.map(r=>mapHistoryRowToMarketSignalHistoryRow(r,AT))});
 const pins=()=>readdirSync(dir).filter(n=>/^zao_signals_\d{4}_\d{2}\.csv$/u.test(n)).sort().map(name=>{const b=readFileSync(join(dir,name));return {name,sha256:hash(b),rows:parseCsvTable(b.toString()).rows.length};});
 const handles:PreparedMirrorRecovery[]=[],prepare=()=>{const p=prepareMirrorRecovery(db,dir,pins());handles.push(p);return p;};
 const extend=(p:PreparedMirrorRecovery,newNames:string[]=[])=>{const r=extendPreparedMirrorRecoveryAppendOnly(p,pins(),newNames);handles.push(r.prepared);return r;};
 return {dir,path,db,pins,prepare,extend,append:(rows:HistoryRow[])=>writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from(renderHistoryCsv(rows).split('\n').slice(1).join('\n'))])),close:()=>{for(const p of handles)p.close();db.close();}};
}
describe('genuine prepared append-only advance',()=>{
 it('refuses an absent legacy-only month before any backup or publication',()=>{
  const x=fixture([row(1),row(5,'02')]),before=readFileSync(x.path),backup=join(x.dir,'backup');
  try{expect(()=>x.prepare()).toThrow('LEGACY_TARGET_SHARD_NOT_PINNED');expect(readFileSync(x.path)).toEqual(before);expect(existsSync(backup)).toBe(false);expect(existsSync(join(x.dir,'zao_signals_2027_02.csv'))).toBe(false);}finally{x.close();}
 });
 it('does not partially publish an existing legacy month when a later month is unpinned',()=>{
  const x=fixture([row(1),row(4),row(5,'02')]),before=readFileSync(x.path);
  try{expect(()=>x.prepare()).toThrow('LEGACY_TARGET_SHARD_NOT_PINNED');expect(readFileSync(x.path)).toEqual(before);expect(existsSync(join(x.dir,'backup'))).toBe(false);}finally{x.close();}
 });
 it('supports multiple legacy months only when every physical target was pinned before extension',()=>{
  const x=fixture([row(1),row(4),row(5,'02')]);writeFileSync(join(x.dir,'zao_signals_2027_02.csv'),renderHistoryCsv([]));const p=x.prepare();
  try{x.append([row(3)]);const q=x.extend(p).prepared;
   withMirrorRecoveryLock(x.dir,l=>{expect(publishRecoveredLegacyHistory(q,accept(q),join(x.dir,'backup'),Buffer.alloc(32,7),l)).toEqual({appended:2,touchedShards:2});expect(applyMirrorDatabaseRecovery(x.db,q,accept(q),AT,l)).toMatchObject({inserted:2,mirrorExact:true});});
   expect(parseCsvTable(readFileSync(x.path,'utf8')).rows).toHaveLength(4);expect(parseCsvTable(readFileSync(join(x.dir,'zao_signals_2027_02.csv'),'utf8')).rows).toHaveLength(1);
  }finally{x.close();}
 });
 it('checks all targets again before backup when one pinned legacy destination disappears',()=>{
  const x=fixture([row(1),row(4),row(5,'02')]),second=join(x.dir,'zao_signals_2027_02.csv');writeFileSync(second,renderHistoryCsv([]));const p=x.prepare();
  try{x.append([row(3)]);const q=x.extend(p).prepared,before=readFileSync(x.path);unlinkSync(second);
   expect(()=>withMirrorRecoveryLock(x.dir,l=>publishRecoveredLegacyHistory(q,accept(q),join(x.dir,'backup'),Buffer.alloc(32,7),l))).toThrow();expect(readFileSync(x.path)).toEqual(before);expect(existsSync(join(x.dir,'backup'))).toBe(false);
  }finally{x.close();}
 });
 it('parses only the tail, matches a full preparation and invalidates only the old handle',()=>{
  const x=fixture(),p=x.prepare();let spy:{mockRestore():void}|undefined;
  try{x.append([row(3)]);const before=readFileSync(x.path);spy=vi.spyOn(historyPolicy,'historyRowFromCsvRecord');const r=x.extend(p);expect(spy).toHaveBeenCalledTimes(1);spy.mockRestore();spy=undefined;
   expect(r).toMatchObject({appendedRows:1,oldRowsSemanticallyRevalidated:0});const fresh=x.prepare();expect(r.prepared.plan).toEqual(fresh.plan);
   expect(readFileSync(x.path)).toEqual(before);expect(x.db.prepare('SELECT COUNT(*) n FROM market_signal_history').get()).toEqual({n:1});
   expect(()=>withMirrorRecoveryLock(x.dir,l=>applyMirrorDatabaseRecovery(x.db,p,accept(p),AT,l))).toThrow('EXPLICIT_ACCEPTANCE_REQUIRED');p.close();
   expect(withMirrorRecoveryLock(x.dir,l=>applyMirrorDatabaseRecovery(x.db,r.prepared,accept(r.prepared),AT,l)).inserted).toBe(2);
   expect(x.db.prepare('SELECT v FROM protected_state').get()).toEqual({v:'KEEP'});
  }finally{spy?.mockRestore();x.close();}
 });
 it('does not convert serialized MODEL or copied prepared objects into genuine handles',()=>{
  const x=fixture(),p=x.prepare();try{x.append([row(3)]);for(const fake of [{...p},JSON.parse(JSON.stringify({plan:p.plan})),{kind:'R2_INCREMENTAL_FINALIZATION_MODEL_V1'}])expect(()=>extendPreparedMirrorRecoveryAppendOnly(fake as PreparedMirrorRecovery,x.pins())).toThrow('LIVE_UNACCEPTED_PREPARATION_REQUIRED');}finally{x.close();}
 });
 it('refuses a closed preparation',()=>{const x=fixture(),p=x.prepare();try{p.close();x.append([row(3)]);expect(()=>x.extend(p)).toThrow('LIVE_UNACCEPTED_PREPARATION_REQUIRED');}finally{x.close();}});
 it('requires a new exact acceptance for the new plan',()=>{const x=fixture(),p=x.prepare();try{x.append([row(3)]);const q=x.extend(p).prepared;expect(q.plan.planSha256).not.toBe(p.plan.planSha256);expect(()=>withMirrorRecoveryLock(x.dir,l=>applyMirrorDatabaseRecovery(x.db,q,accept(p),AT,l))).toThrow('EXPLICIT_ACCEPTANCE_REQUIRED');}finally{x.close();}});
 it('cannot extend a preparation after a recovery phase has been accepted',()=>{const x=fixture(),p=x.prepare();try{withMirrorRecoveryLock(x.dir,l=>persistMirrorRecoveryPlan(p,accept(p),join(x.dir,'backup'),l));x.append([row(3)]);expect(()=>x.extend(p)).toThrow('LIVE_UNACCEPTED_PREPARATION_REQUIRED');}finally{x.close();}});
 it('advances repeatedly without rereading old rows semantically',()=>{const x=fixture(),p=x.prepare();try{x.append([row(3)]);const q=x.extend(p).prepared;x.append([row(4)]);const r=x.extend(q);expect(r.prepared.plan.historyRows).toBe(4);expect(r.appendedRows).toBe(1);expect(()=>x.extend(q)).toThrow('LIVE_UNACCEPTED_PREPARATION_REQUIRED');q.close();expect(r.prepared.plan.originalSourceAuthenticity).toBe('NOT_ESTABLISHED');}finally{x.close();}});
 it('unchanged inputs keep the same genuine handle',()=>{const x=fixture(),p=x.prepare();try{const r=x.extend(p);expect(r.prepared).toBe(p);expect(r.appendedRows).toBe(0);expect(withMirrorRecoveryLock(x.dir,l=>applyMirrorDatabaseRecovery(x.db,p,accept(p),AT,l)).inserted).toBe(1);}finally{x.close();}});
 for(const mode of ['rewrite','truncate']as const)it('rejects prefix '+mode,()=>{const x=fixture(),p=x.prepare();try{writeFileSync(x.path,renderHistoryCsv(mode==='rewrite'?[row(1),row(4),row(3)]:[row(1)]));expect(()=>x.extend(p)).toThrow('APPEND_OLD_PREFIX_CHANGED');}finally{x.close();}});
 it('rejects duplicate tail IDs and rolls back earlier valid RAM inserts',()=>{const x=fixture(),p=x.prepare(),before=readFileSync(x.path);try{x.append([row(3),row(1)]);expect(()=>x.extend(p)).toThrow('APPEND_DUPLICATE_OR_LEGACY_COLLISION');writeFileSync(x.path,before);x.append([row(3)]);const q=x.extend(p).prepared;expect(q.plan.historyRows).toBe(3);expect(q.plan.historyOnly).toBe(2);}finally{x.close();}});
 it('rejects changed tail content rather than trusting its stored row hash',()=>{const x=fixture(),p=x.prepare();try{const tail=renderHistoryCsv([row(3)]).split('\n').slice(1).join('\n').replace('20000','21000');writeFileSync(x.path,Buffer.concat([readFileSync(x.path),Buffer.from(tail)]));expect(()=>x.extend(p)).toThrow('APPEND_CONTENT_HASH_OR_SHARD');}finally{x.close();}});
 it('preserves DB-only identity and refuses to adopt it through a canonical tail',()=>{const x=fixture([row(1),row(4)]),p=x.prepare();try{x.append([row(4)]);expect(()=>x.extend(p)).toThrow('APPEND_DUPLICATE_OR_LEGACY_COLLISION');expect(p.plan.dbOnly).toBe(1);}finally{x.close();}});
 it('keeps legacy publication and exact database reconciliation available for the new plan',()=>{const x=fixture([row(1),row(4)]),p=x.prepare();try{x.append([row(3)]);const q=x.extend(p).prepared;expect(q.plan.legacyIdentitySha256).toBe(p.plan.legacyIdentitySha256);expect(q.plan.legacySavedJsonSha256).toBe(p.plan.legacySavedJsonSha256);
  withMirrorRecoveryLock(x.dir,l=>{expect(publishRecoveredLegacyHistory(q,accept(q),join(x.dir,'backup'),Buffer.alloc(32,7),l).appended).toBe(1);expect(applyMirrorDatabaseRecovery(x.db,q,accept(q),AT,l)).toMatchObject({inserted:2,mirrorExact:true});});
 }finally{x.close();}});
 it('requires explicit new shard names and validates all their rows',()=>{const x=fixture(),p=x.prepare();try{writeFileSync(join(x.dir,'zao_signals_2027_02.csv'),renderHistoryCsv([row(3,'02')]));expect(()=>x.extend(p)).toThrow('APPEND_PIN_UNIVERSE');const q=x.extend(p,['zao_signals_2027_02.csv']).prepared;expect(q.plan.historyRows).toBe(3);expect(q.plan.pins).toHaveLength(2);expect(q.plan).toEqual(x.prepare().plan);}finally{x.close();}});
 it('refuses an unknown physical shard even when omitted from the supplied pins',()=>{const x=fixture(),p=x.prepare();try{const pins=x.pins();writeFileSync(join(x.dir,'zao_signals_2027_02.csv'),renderHistoryCsv([]));expect(()=>extendPreparedMirrorRecoveryAppendOnly(p,pins)).toThrow('APPEND_WRITER_OR_UNIVERSE');}finally{x.close();}});
 it('refuses missing old shards',()=>{const x=fixture(),p=x.prepare();try{unlinkSync(x.path);expect(()=>x.extend(p)).toThrow('APPEND_PIN_SCOPE');}finally{x.close();}});
 it('refuses concurrent canonical append lock',()=>{const x=fixture(),p=x.prepare();try{x.append([row(3)]);writeFileSync(join(x.dir,APPEND_LOCK_FILENAME),'synthetic');expect(()=>x.extend(p)).toThrow('APPEND_WRITER_OR_UNIVERSE');}finally{x.close();}});
 it('refuses DB identity changes',()=>{const x=fixture(),p=x.prepare();try{x.append([row(3)]);x.db.prepare('UPDATE market_signal_history SET row_hash=?').run('f'.repeat(64));expect(()=>x.extend(p)).toThrow('APPEND_DB_CHANGED');}finally{x.close();}});
 it('refuses changed saved legacy JSON even when row identity hashes stay the same',()=>{const x=fixture([row(1),row(4)]),p=x.prepare();try{x.append([row(3)]);x.db.prepare('UPDATE market_signal_history SET raw_json=? WHERE row_id=?').run('{}',row(4).rowId);expect(()=>x.extend(p)).toThrow('LEGACY_SAVED_JSON_CHANGED');}finally{x.close();}});
 it('refuses even an empty sidecar on a file database',()=>{const x=fixture([row(1)],true),p=x.prepare();try{x.append([row(3)]);writeFileSync(x.db.name+'-wal','');expect(()=>x.extend(p)).toThrow('APPEND_DB_SIDECAR');unlinkSync(x.db.name+'-wal');}finally{x.close();}});
 it('refuses a symlink replacing a pinned file',()=>{const x=fixture(),p=x.prepare();try{x.append([row(3)]);const pins=x.pins();renameSync(x.path,x.path+'.original');symlinkSync(x.path+'.original',x.path);expect(()=>extendPreparedMirrorRecoveryAppendOnly(p,pins)).toThrow('APPEND_CANONICAL_FILE');}finally{x.close();}});
 it('does not trust a supplied new row count',()=>{const x=fixture(),p=x.prepare();try{x.append([row(3)]);const pins=x.pins();pins[0]!.rows++;expect(()=>extendPreparedMirrorRecoveryAppendOnly(p,pins)).toThrow('APPEND_SCHEMA_OR_COUNT');}finally{x.close();}});
 it('refuses a duplicated pin instead of hiding a shard',()=>{const x=fixture(),p=x.prepare();try{const pins=x.pins();expect(()=>extendPreparedMirrorRecoveryAppendOnly(p,[...pins,...pins])).toThrow('APPEND_PIN_SCOPE');}finally{x.close();}});
 it('does not accept new opaque legacy-style IDs on an appended row',()=>{const x=fixture(),p=x.prepare();try{const r=row(3);r.rowId+='-legacy';x.append([r]);expect(()=>x.extend(p)).toThrow('APPEND_CONTENT_HASH_OR_SHARD');}finally{x.close();}});
 it('checks real-target sidecars when SQLite was opened through an alias',()=>{const x=fixture([row(1)],true,true),p=x.prepare();try{x.append([row(3)]);const sidecar=join(x.dir,'market.sqlite-wal');writeFileSync(sidecar,'');expect(()=>x.extend(p)).toThrow('APPEND_DB_SIDECAR');unlinkSync(sidecar);}finally{x.close();}});
 it('refuses alias retargeting after preparation',()=>{const x=fixture([row(1)],true,true),p=x.prepare();try{x.append([row(3)]);const other=join(x.dir,'other.sqlite');new Database(other).close();unlinkSync(x.db.name);symlinkSync(other,x.db.name);expect(()=>x.extend(p)).toThrow('SOURCE_DATABASE_BINDING');}finally{x.close();}});
 it('refuses alias retargeting between SQLite open and preparation',()=>{const x=fixture([row(1)],true,true);try{const other=join(x.dir,'other.sqlite');new Database(other).close();unlinkSync(x.db.name);symlinkSync(other,x.db.name);expect(()=>x.prepare()).toThrow('SOURCE_DATABASE_BINDING');}finally{x.close();}});
 it('refuses replacement of the same canonical DB path with another inode',()=>{const x=fixture([row(1)],true),p=x.prepare();try{x.append([row(3)]);const name=x.db.name;renameSync(name,name+'.opened');new Database(name).close();expect(()=>x.extend(p)).toThrow('SOURCE_DATABASE_BINDING');}finally{x.close();}});
 it('creates a new raw-bound plan for a byte-only CSV append',()=>{const x=fixture(),p=x.prepare();try{writeFileSync(x.path,Buffer.concat([readFileSync(x.path),Buffer.from('\n')]));const r=x.extend(p);expect(r.prepared).not.toBe(p);expect(r.appendedRows).toBe(0);expect(r.prepared.plan.planSha256).not.toBe(p.plan.planSha256);expect(r.prepared.plan).toEqual(x.prepare().plan);}finally{x.close();}});
 it('keeps canonical inode binding at the recovery acceptance boundary',()=>{const x=fixture([row(1)],true),p=x.prepare();try{x.append([row(3)]);const q=x.extend(p).prepared,name=x.db.name;renameSync(name,name+'.opened');new Database(name).close();expect(()=>withMirrorRecoveryLock(x.dir,l=>applyMirrorDatabaseRecovery(x.db,q,accept(q),AT,l))).toThrow('SOURCE_DATABASE_BINDING');}finally{x.close();}});
 it('refuses relative DB aliases after cwd changes in an isolated child process',()=>{const x=fixture([row(1)],true);try{
  const source=fileURLToPath(new URL('../src/services/marketMirrorRecoveryPlan.ts',import.meta.url)),loader=fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url));
  const database=fileURLToPath(new URL('../node_modules/better-sqlite3/lib/index.js',import.meta.url));
  const script=`import Database from ${JSON.stringify(pathToFileURL(database).href)};import {prepareMirrorRecovery,extendPreparedMirrorRecoveryAppendOnly} from ${JSON.stringify(pathToFileURL(source).href)};const db=new Database('market.sqlite',{readonly:true,fileMustExist:true});const p=prepareMirrorRecovery(db,${JSON.stringify(x.dir)},${JSON.stringify(x.pins())});process.chdir('..');try{extendPreparedMirrorRecoveryAppendOnly(p,${JSON.stringify(x.pins())});throw Error('UNEXPECTED_PASS')}catch(e){if(!e.message.includes('SOURCE_DATABASE_BINDING'))throw e;console.log('REFUSED_SOURCE_DATABASE_BINDING')}finally{p.close();db.close()}`;
  expect(execFileSync(process.execPath,['--import',loader,'--input-type=module','-e',script],{cwd:x.dir,encoding:'utf8',timeout:10000})).toContain('REFUSED_SOURCE_DATABASE_BINDING');
 }finally{x.close();}});
});
