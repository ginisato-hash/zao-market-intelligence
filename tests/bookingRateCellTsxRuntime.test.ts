import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
it('serialized rate-table callbacks run under production tsx without a Node-only name helper',()=>{
 const raw=execFileSync(process.execPath,['--import','tsx','tests/fixtures/bookingRateCellTsxHarness.mjs'],{cwd:process.cwd(),encoding:'utf8',timeout:15000});
 expect(JSON.parse(raw)).toEqual({cells:1,problems:[],bound:[true],browserCallbacksHaveNodeHelper:false,browser:0,network:0});
});
