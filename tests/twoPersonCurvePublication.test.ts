import {expect,it,afterEach} from 'vitest';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {digest} from '../src/services/marketRowPriceQuality';
import {startCurvePublication,guardCurveAttempt,finishCurvePublication,closeCurvePublication,type CurvePublicationSession} from '../src/services/twoPersonCurvePublication';
import {beginNormalCurvePublication,closeNormalCurvePublication} from '../src/services/twoPersonCurvePublicationLane';
import {publicationFixture,fixtureT1,fixtureDates} from './fixtures/twoPersonPublicationFixture';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'2p-curve-publisher-')));dirs.push(root);const f=publicationFixture(root);let now=fixtureT1;
 const directory=join(root,'.data/market-2p',f.configSha);const start=(runId='auto_runner_market_refresh_rotating_20261029_000006',assertSource=()=>{})=>startCurvePublication({runId,root,configBytes:f.configBytes,expectedConfigSha256:f.configSha,producerCodeSha256:f.producer,request:f.request(now),assertSource,clock:()=>new Date(now)});
 const pointer=()=>JSON.parse(readFileSync(join(directory,'current.json'),'utf8'));
 return {...f,directory,start,pointer,setNow:(at:string)=>{now=at;}};
}
function published(){const f=fixture(),s=f.start(),a=f.admission('auto_runner_market_refresh_rotating_20261029_000006',fixtureT1,f.facts(fixtureT1,1.1));expect(guardCurveAttempt(s,fixtureDates[0]!)).toBe(true);const r=finishCurvePublication(s,a.pin.admissionSha256);closeCurvePublication(s);return {...f,result:r};}
it('default-OFF wrapper returns without git or filesystem access',()=>{expect(beginNormalCurvePublication({}, {runId:'bad',root:'/no-such-fixture'})).toEqual({status:'DISABLED',session:null});});
it('publishes genuine-route fixture receipts as a nonflat immutable curve and sealed canonical pointer',()=>{
 const f=published(),p=f.pointer(),curve=JSON.parse(readFileSync(join(f.directory,p.artifactBasename),'utf8'));
 expect(f.result.priceEligibleDates).toBe(2);expect(curve.curves.every((c:any)=>c.eligible&&Math.abs(c.curveIndex-1.1)<1e-9)).toBe(true);
 expect(p.guard.blockedStayDates).toEqual([]);expect(existsSync(join(f.directory,'publisher.lock'))).toBe(false);expect(curve.priceAuthority).toBe(false);
});
it('blocks only a requested date in the prior publication while other dates remain available',()=>{
 const f=published();f.setNow('2026-10-29T02:00:00.000Z');const s=f.start('auto_runner_market_refresh_rotating_20261029_020006');
 const before=f.pointer();expect(guardCurveAttempt(s,fixtureDates[0]!)).toBe(true);const after=f.pointer();expect(after.artifactBasename).toBe(before.artifactBasename);
 expect(after.generatedAt).toBe(before.generatedAt);expect(after.guard.blockedStayDates).toEqual([fixtureDates[0]]);closeCurvePublication(s);
});
it('retains a guarded unknown attempt across a stopped run and a later run that only proves another date',()=>{
 const f=published(),at2='2026-10-29T02:00:00.000Z',at3='2026-10-29T04:00:00.000Z';f.setNow(at2);let s=f.start('auto_runner_market_refresh_rotating_20261029_020006');
 expect(guardCurveAttempt(s,fixtureDates[0]!)).toBe(true);closeCurvePublication(s);f.setNow(at3);s=f.start('auto_runner_market_refresh_rotating_20261029_040006');
 expect(guardCurveAttempt(s,fixtureDates[1]!)).toBe(true);const a=f.admission('auto_runner_market_refresh_rotating_20261029_040006',at3,f.facts(at3,1.1).filter(r=>r.stayDate===fixtureDates[1]));
 finishCurvePublication(s,a.pin.admissionSha256);expect(f.pointer().guard.blockedStayDates).toEqual([fixtureDates[0]]);closeCurvePublication(s);
});
it('a failed product becomes ineligible through the normal denial receipt, without fabricating sold out or zero',()=>{
 const f=published(),at='2026-10-29T02:00:00.000Z';f.setNow(at);const s=f.start('auto_runner_market_refresh_rotating_20261029_020006');guardCurveAttempt(s,fixtureDates[0]!);
 const p=f.panel.products[0]!,invalid={propertyId:p.propertyId,sourcePropertyId:p.sourcePropertyId,source:p.source,productId:p.productId,ratePlanId:p.ratePlanId,conditionKey:p.conditionKey,stayDate:fixtureDates[0]!,observedAt:at,ingestedAt:at,reason:'FETCH_FAILED',sourceEvidenceSha256:digest('synthetic-failed-source')};
 const a=f.admission('auto_runner_market_refresh_rotating_20261029_020006',at,f.facts(at,1.1).filter(r=>!(r.propertyId===p.propertyId&&r.stayDate===fixtureDates[0])),[invalid]);finishCurvePublication(s,a.pin.admissionSha256);
 const ptr=f.pointer(),curve=JSON.parse(readFileSync(join(f.directory,ptr.artifactBasename),'utf8'));expect(curve.curves[0].eligible).toBe(false);expect(curve.curves[1].eligible).toBe(true);expect(curve.curves[0].productAvailability.hotelOccupancyRate).toBeNull();closeCurvePublication(s);
});
it('unknown/forged sessions, out-of-scope dates and corrupt source receipt cannot publish a price',()=>{
 const f=published();expect(guardCurveAttempt({kind:'ZMI_2P_PUBLICATION_SESSION_V1'} as CurvePublicationSession,fixtureDates[0]!)).toBe(false);
 f.setNow('2026-10-29T02:00:00.000Z');const s=f.start('auto_runner_market_refresh_rotating_20261029_020006');expect(guardCurveAttempt(s,'2029-12-31')).toBe(false);
 expect(()=>finishCurvePublication(s,'0'.repeat(64))).toThrow();closeCurvePublication(s);
});
it('an orphan lock, foreign pointer and symlink are retained rather than overwritten or auto-repaired',()=>{
 const f=published(),lock=join(f.directory,'publisher.lock');writeFileSync(lock,'unknown-owner');expect(()=>f.start()).toThrow();expect(readFileSync(lock,'utf8')).toBe('unknown-owner');rmSync(lock);
 f.setNow('2026-10-29T02:00:00.000Z');const s=f.start('auto_runner_market_refresh_rotating_20261029_020006');writeFileSync(join(f.directory,'current.json'),'foreign-writer');expect(guardCurveAttempt(s,fixtureDates[0]!)).toBe(false);expect(readFileSync(join(f.directory,'current.json'),'utf8')).toBe('foreign-writer');closeCurvePublication(s);
 rmSync(join(f.directory,'current.json'));symlinkSync(join(f.root,'unrelated'),join(f.directory,'current.json'));expect(()=>f.start()).toThrow();
});
it('source failure is detected before creating the publication directory',()=>{const f=fixture();expect(()=>f.start(undefined,()=>{throw Error('UNACCEPTED_SOURCE');})).toThrow('UNACCEPTED_SOURCE');expect(existsSync(f.directory)).toBe(false);});
it('expiry during a run refuses subsequent publication without extending quote freshness',()=>{const f=published();f.setNow('2026-10-29T02:00:00.000Z');const s=f.start('auto_runner_market_refresh_rotating_20261029_020006');f.setNow('2026-10-29T05:00:00.000Z');expect(guardCurveAttempt(s,fixtureDates[0]!)).toBe(false);closeCurvePublication(s);expect(f.pointer().generatedAt).toBe(fixtureT1);});

it('the normal wrapper starts only with clean accepted source, a pinned config and a fresh canonical RMS request',()=>{
 const f=fixture(),pins=Object.fromEntries(['src','scripts','package.json','package-lock.json','tsconfig.json'].map(name=>[name,execFileSync('git',['rev-parse','HEAD:'+name],{encoding:'utf8'}).trim()]));
 const producer=digest(pins);f.config.acceptedProducerCodes.push(producer);
 const configPath=join(f.root,'accepted-config.json'),configBytes=Buffer.from(JSON.stringify(f.config)),requestPath=join(f.root,'canonical-RMS-request.json');
 writeFileSync(configPath,configBytes);const request=f.request(new Date().toISOString());writeFileSync(requestPath,JSON.stringify(request));
 const env={ZMI_2P_CURVE_PUBLICATION_ENABLED:'1',ZMI_2P_QUALITY_ENABLED:'1',ZMI_USEFUL_QUOTES_ENABLED:'1',ZMI_2P_ACCEPTED_PRODUCER_DIGEST:producer,
  ZMI_RMS_QUOTE_REQUEST_PATH:requestPath,ZMI_RMS_QUOTE_SOURCE_RELEASE:request.source.releaseGitSha,ZMI_RMS_QUOTE_BUNDLE_SHA256:request.source.bundleSha256,ZMI_RMS_QUOTE_GRAPH_SHA256:request.source.graphSha256,
  ZMI_2P_CURVE_CONFIG_PATH:configPath,ZMI_2P_CURVE_CONFIG_SHA256:createHash('sha256').update(configBytes).digest('hex')};
 const s=beginNormalCurvePublication(env,{runId:'auto_runner_market_refresh_rotating_20261029_070006',root:f.root});
 try{expect(s.status).toBe('READY');expect(s.session).not.toBeNull();}finally{closeNormalCurvePublication(s.session);}
 expect(beginNormalCurvePublication({...env,ZMI_2P_ACCEPTED_PRODUCER_DIGEST:'0'.repeat(64)},{runId:'auto_runner_market_refresh_rotating_20261029_070006',root:f.root}).status).toBe('HELD_SOURCE_OR_PUBLICATION_UNVERIFIED');
});
