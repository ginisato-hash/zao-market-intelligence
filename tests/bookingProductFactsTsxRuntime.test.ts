import {it,expect} from 'vitest';import {execFileSync} from 'node:child_process';
it('actual node/tsx serializes the complete v4 browser path without Node-only callback helpers',()=>{
 const raw=execFileSync(process.execPath,['--import','tsx','tests/fixtures/bookingProductFactsTsxHarness.mjs'],{cwd:process.cwd(),encoding:'utf8',timeout:20000});
 expect(JSON.parse(raw)).toEqual({parserVersion:'booking-rate-cell-v4',cells:1,primitiveBound:true,maximumAdults:2,publicPriceProved:true,taxInformationCaptured:true,pageFinalStateVerified:true,localRequests:1,providerRequests:0,pricePosts:0});
},25000);
