import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeCollectorSource,bindCollectorProducerEvidence} from '../src/services/collectorProducerEvidence';
import {digest} from '../src/services/marketRowPriceQuality';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const t0='2026-10-29T14:00:00.000Z',t1='2026-10-29T14:08:00.000Z',run='auto_runner_market_refresh_rotating_20261029_230000';
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'zmi-producer-test-')));roots.push(root);
 const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 git('init');for(const p of ['src','scripts']){mkdirSync(join(root,p));writeFileSync(join(root,p,'entry.ts'),'export {};\n');}
 for(const p of ['package.json','package-lock.json','tsconfig.json'])writeFileSync(join(root,p),'{}\n');
 const commit=()=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture');};commit();
 return {root,git,commit,start:()=>observeCollectorSource(root,()=>new Date(t0)),end:()=>observeCollectorSource(root,()=>new Date(t1))};
}
it('records clean source pins without changing HEAD, code, history or git configuration',()=>{
 const f=fixture(),head=f.git('rev-parse','HEAD'),config=readFileSync(join(f.root,'.git/config'),'utf8'),src=readFileSync(join(f.root,'src/entry.ts'),'utf8'),index=readFileSync(join(f.root,'.git/index'));
 const before=f.start(),out=bindCollectorProducerEvidence(run,before,f.end());expect(out.status).toBe('STABLE_CODE_PINS_OBSERVED');expect(out.priceAuthority).toBe(false);
 expect(out.evidenceScope).toBe('GIT_SOURCE_OBSERVATION_NOT_INDEPENDENT_RUNTIME_ATTESTATION');expect(before.status).toBe('RECORDED');
 if(before.status==='RECORDED'){expect(before.releaseGitSha).toBe(head);expect(before.producerCodeSha256).toBe(digest(before.codePins));}
 const {observationSha256,...body}=out;expect(observationSha256).toBe(digest(body));expect(JSON.stringify(out)).not.toContain(f.root);
 expect(readFileSync(join(f.root,'.git/index'))).toEqual(index);expect(f.git('rev-parse','HEAD')).toBe(head);expect(f.git('status','--porcelain')).toBe('');expect(readFileSync(join(f.root,'.git/config'),'utf8')).toBe(config);expect(readFileSync(join(f.root,'src/entry.ts'),'utf8')).toBe(src);
});
it('permits data-only auto-commits but keeps both actual HEAD observations',()=>{
 const f=fixture(),a=f.start();mkdirSync(join(f.root,'.data'));writeFileSync(join(f.root,'.data/history.csv'),'synthetic\n');f.commit();const b=f.end();
 expect(bindCollectorProducerEvidence(run,a,b).status).toBe('STABLE_CODE_PINS_OBSERVED');if(a.status==='RECORDED'&&b.status==='RECORDED')expect(a.releaseGitSha).not.toBe(b.releaseGitSha);
});
it('refuses a committed source change during the run',()=>{const f=fixture(),a=f.start();writeFileSync(join(f.root,'src/entry.ts'),'export const changed=true;\n');f.commit();expect(bindCollectorProducerEvidence(run,a,f.end()).status).toBe('UNVERIFIED');});
it('refuses dirty tracked code and untracked code',()=>{const f=fixture();writeFileSync(join(f.root,'src/entry.ts'),'changed');expect(f.start().status).toBe('UNVERIFIED');f.git('checkout','--','src/entry.ts');writeFileSync(join(f.root,'scripts/new.ts'),'untracked');expect(f.end().status).toBe('UNVERIFIED');});
it('does not mistake unrelated dirty BI output for code changes',()=>{const f=fixture();mkdirSync(join(f.root,'apps'));writeFileSync(join(f.root,'apps/BI.json'),'{}');expect(f.start().status).toBe('RECORDED');});
it('does not expose Git errors, absolute paths or exception text',()=>{const bad='/no-such-path/password-secret';expect(observeCollectorSource(bad,()=>new Date(t0))).toEqual({status:'UNVERIFIED',reason:'SOURCE_UNREADABLE_OR_DIRTY',observedAt:t0});});
it('refuses a subdirectory masquerading as the source repository',()=>{const f=fixture();expect(observeCollectorSource(join(f.root,'src'),()=>new Date(t0)).status).toBe('UNVERIFIED');});
it('refuses reversed timestamps and invalid run IDs without granting price authority',()=>{const f=fixture(),a=f.start(),b=f.end();expect(bindCollectorProducerEvidence(run,b,a).status).toBe('UNVERIFIED');const out=bindCollectorProducerEvidence('password-secret',a,b);expect(out.status).toBe('UNVERIFIED');expect(out.runId).toBeNull();expect(JSON.stringify(out)).not.toContain('password-secret');expect(out.priceAuthority).toBe(false);});
it('records an unavailable clock as unverified rather than using an invented timestamp',()=>{expect(observeCollectorSource('/no-such-path',()=>new Date(NaN))).toEqual({status:'UNVERIFIED',reason:'SOURCE_UNREADABLE_OR_DIRTY',observedAt:null});});
it('cannot retrofit current source observations onto an earlier run or an overlong run',()=>{const f=fixture(),a=f.start(),b=f.end();
 expect(bindCollectorProducerEvidence('auto_runner_market_refresh_rotating_20261028_230000',a,b).status).toBe('UNVERIFIED');
 expect(bindCollectorProducerEvidence(run,a,{...b,observedAt:'2026-10-29T17:00:00.000Z'}).status).toBe('UNVERIFIED');
});
it('refuses a claimed producer digest that does not match the observed code pins',()=>{const f=fixture(),a=f.start(),b=f.end();
 if(a.status!=='RECORDED'||b.status!=='RECORDED')throw Error('FIXTURE_SOURCE');
 expect(bindCollectorProducerEvidence(run,{...a,producerCodeSha256:'0'.repeat(64)},{...b,producerCodeSha256:'0'.repeat(64)}).status).toBe('UNVERIFIED');
});
