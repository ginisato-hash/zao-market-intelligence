// Synthetic only: no OTA request, credentials, booking operation or production file.
import {it,expect} from 'vitest';
import {bookingInformationTextSafe,explicitMaximumAdults,roomKindFromName,rankBookingDiscoveryRows,readBookingProductFacts,type BookingProductFacts} from '../src/services/bookingProductObservability';
import {readCaptureTwoPersonPanel,readAcceptedTwoPersonPanel,recordTwoPersonMarketAdmission} from '../src/services/twoPersonMarketAdmissionLane';
import {sealPanel} from '../src/services/marketTwoPersonCurve';
import {digest} from '../src/services/marketRowPriceQuality';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
it('observes explicit maximum only; party count, bed count, ranges, conflicts or qualifications stay unknown',()=>{
 expect(explicitMaximumAdults('最大宿泊人数：2名')).toBe(2);expect(explicitMaximumAdults('Maximum adults: 2')).toBe(2);
 for(const s of ['人数: 2','シングルベッド2台','大人2名 子供0名 1部屋','定員: 1～3名','最大宿泊人数：2名（追加可）','最大宿泊人数：2名\n定員：3名','最大宿泊人数：2名ではありません'])expect(explicitMaximumAdults(s)).toBeNull();
});
it('discovery prefers comparable public evidence without selecting a cheaper replacement or changing fixed product identity',()=>{
 const row=(id:string,roomName:string,priceText:string)=>({blockId:id,roomName,priceText,conditionsText:'返金不可',oneRoomOptionText:'1 (￥20,000)'}),member=row('1_1_2_0_0','ツイン','￥10,000 Genius 会員限定 税・手数料込'),suite=row('2_1_2_0_0','スイート ツイン','￥5,000 税・手数料込'),publicTwin=row('3_1_2_0_0','ツイン','￥20,000 税・手数料込');
 expect(rankBookingDiscoveryRows([member,suite,publicTwin])).toEqual([publicTwin,member,suite]);expect(roomKindFromName('トリプルルーム')).toBeNull();expect(roomKindFromName('Double/Twin')).toBeNull();
});
it('capture panel targeting works with QUALITY0 while price admission remains disabled',()=>{
 const root=mkdtempSync(join(tmpdir(),'capture-panel-'));try{const panel=sealPanel({version:'synthetic',region:'synthetic',category:'standard-two',ownPropertyIds:['own'],products:[{propertyId:'external',sourcePropertyId:'external',source:'booking',productId:'123',ratePlanId:'456',conditionKey:digest('conditions'),groupId:null,weight:1,standardProduct:{kind:'TWIN',maxAdults:2,evidenceSha256:digest('proof')}}]}),raw=Buffer.from(JSON.stringify(panel)),path=join(root,'panel.json');writeFileSync(path,raw);
  const env={ZMI_RATE_CELL_EVIDENCE_ENABLED:'1',ZMI_2P_QUALITY_ENABLED:'0',ZMI_2P_PANEL_PATH:path,ZMI_2P_PANEL_SHA256:createHash('sha256').update(raw).digest('hex')};expect(readCaptureTwoPersonPanel(env)).toEqual(panel);expect(readAcceptedTwoPersonPanel(env)).toBeNull();expect(readCaptureTwoPersonPanel({})).toBeNull();expect(readCaptureTwoPersonPanel({...env,ZMI_2P_PANEL_SHA256:'0'.repeat(64)})).toBeNull();expect(recordTwoPersonMarketAdmission(env,{runId:'invalid',now:'invalid',root:'/absent',captureDir:'/absent',dbPath:'/absent',mirrorExact:false,rows:[],captures:[]})).toEqual({status:'DISABLED',eligibleRows:0});
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('v4 facts bind the room and row; older captures cannot acquire anonymous or tax proof retroactively',()=>{
 const f:BookingProductFacts={schema:'BOOKING_SELECTED_PRODUCT_FACTS_V1',blockId:'123_456_2_0_0',anonymousPublicContext:{freshUnauthenticatedContext:true,signedOutControlVisible:true},roomCapacity:{controlId:'RD123',containerId:'RD123',roomId:'123',roomName:'ツイン',maximumAdults:2,explicitText:'定員：2名'},taxTotal:{controlId:'tax123',containerId:'tax123',explicitText:'すべての税金と料金が含まれています。'}};
 const row={blockId:f.blockId,roomName:'ツイン',productFacts:f},d={tupleAndProductBound:true,currentDisplayedJpy:20000,memberConditional:false};expect(readBookingProductFacts({parserVersion:'booking-rate-cell-v4'},row,d)).toMatchObject({maximumAdults:2,publicPriceProved:true});
 expect(readBookingProductFacts({parserVersion:'booking-rate-cell-v3'},row,d)).toEqual({maximumAdults:null,roomCapacityProved:false,publicPriceProved:false,allMandatoryText:null});expect(readBookingProductFacts({parserVersion:'booking-rate-cell-v4'},row,{...d,memberConditional:true}).publicPriceProved).toBe(false);expect(readBookingProductFacts({parserVersion:'booking-rate-cell-v4'},{...row,blockId:'999_456_2_0_0'},d).publicPriceProved).toBe(false);
});

it('new information facts reject unlabeled contacts and credentials before copying, including Unicode separators',()=>{
 for(const s of ['09012345678','+819012345678','０９０（１２３４）５６７８','+1 415 555 2671','name@example.test','https://example.test/private','api_key=synthetic','Bearer synthetic','token: synthetic','cookie=synthetic'])expect(bookingInformationTextSafe('すべての税金と料金が含まれています。'+s,1000)).toBe(false);
 expect(bookingInformationTextSafe('すべての税金と料金が含まれています。1名/1泊につき150円の入湯税',1000)).toBe(true);
});
