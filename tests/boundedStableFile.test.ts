import {expect,it,vi,afterEach} from 'vitest';
const control=vi.hoisted(()=>({afterStat:null as null|(()=>void),bytes:0}));
vi.mock('node:fs',async()=>{
 const fs=await vi.importActual<typeof import('node:fs')>('node:fs');
 return {...fs,fstatSync:(...args:any[])=>{const r=(fs.fstatSync as any)(...args);const f=control.afterStat;control.afterStat=null;f?.();return r;},
  readSync:(...args:any[])=>{const n=(fs.readSync as any)(...args);control.bytes+=n;return n;}};
});
import {mkdtempSync,writeFileSync,appendFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readBoundedStableFile} from '../src/services/boundedStableFile';
const dirs:string[]=[];afterEach(()=>{control.afterStat=null;control.bytes=0;for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'bounded-file-'));dirs.push(dir);const path=join(dir,'original');writeFileSync(path,'known bytes');return {path,dir};}
it('returns a stable exact byte sequence and refuses an initially oversized file before reading',()=>{const {path}=fixture();expect(readBoundedStableFile(path,100).toString()).toBe('known bytes');control.bytes=0;expect(()=>readBoundedStableFile(path,3)).toThrow('SIZE');expect(control.bytes).toBe(0);});
it('stops actual reads at max+1 when a file grows after the initial stat',()=>{const {path}=fixture();control.afterStat=()=>appendFileSync(path,Buffer.alloc(10000));expect(()=>readBoundedStableFile(path,1024)).toThrow('GREW_PAST_BUDGET');expect(control.bytes).toBe(1025);});
it('rejects symlinks and same-size changes observed after the read',()=>{const {path,dir}=fixture(),link=join(dir,'link');symlinkSync(path,link);expect(()=>readBoundedStableFile(link,100)).toThrow();control.afterStat=()=>writeFileSync(path,'other bytes');expect(()=>readBoundedStableFile(path,100)).toThrow('CHANGED');});
