import type {BookingRenderedDomSignals,BookingPriceCandidate} from './bookingRenderedDomProbe';
import {deriveBookingRateCell,type BookingRateCellCapture} from './bookingRateCellEvidence';
import type {PanelProduct} from './marketTwoPersonCurve';
/** Uses only the already captured exact public row. No click/select/booking, no changing products to obtain a price. */
export function selectFixedTwoPersonSignals(original:BookingRenderedDomSignals,capture:BookingRateCellCapture|null,product:PanelProduct,finalBlock:string|null,finalVerified:boolean){
 const absent=(reason:string)=>({signals:{...original,primaryPriceCandidate:null,priceCandidates:[],originalPriceNumeric:null,priceDiscountDetected:false},status:reason});
 if(!capture||finalBlock!==null||!finalVerified||capture.propertySlug!==product.sourcePropertyId||product.source!=='booking'||product.standardProduct.maxAdults!==2)return absent('FIXED_PRODUCT_CAPTURE_UNVERIFIED');
 const cells=capture.cells.filter(c=>{const s=c.blockId.split('_');return s[0]===product.productId&&s[1]===product.ratePlanId;});
 if(cells.length!==1)return absent('FIXED_PRODUCT_NOT_OBSERVED');
 const cell=cells[0]!,d=deriveBookingRateCell(capture,cell);
 if(capture.problems.length||!d.tupleAndProductBound||d.currentDisplayedJpy===null)return absent('FIXED_PRODUCT_PRICE_UNVERIFIED');
 const price:BookingPriceCandidate={rawText:'￥'+d.currentDisplayedJpy,numericValue:d.currentDisplayedJpy,contextBeforeAfter:cell.priceText,
  candidateTypeGuess:'total_tax_included',roleGuess:'effective_price',blockGuess:'main_room_card'};
 return {signals:{...original,primaryPriceCandidate:price,priceCandidates:[price],originalPriceNumeric:d.prePromotionPlanJpy,priceDiscountDetected:d.prePromotionPlanJpy!==null,
  primaryRoomName:cell.roomName,primaryRoomCardText:cell.roomText,primaryOccupancyHint:cell.occupancyText,primaryBedHint:cell.roomText,noUsableRoomPriceReason:null},status:'FIXED_PRODUCT_PRICE_SELECTED'};
}
