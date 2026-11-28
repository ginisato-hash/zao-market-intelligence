import {describe,expect,it} from 'vitest';
import {buildAppendPlan,buildBookingPreviewRowPolicyDiagnostics,buildBookingSourceLevelCheck,buildJalanSourceLevelCheck} from '../src/services/autoRunnerMarketRefresh';
import type {PreviewRow} from '../src/services/autoRunnerBookingPreview';
const row=(extra:Partial<PreviewRow>={}):PreviewRow=>({source:'booking',property_slug:'fixture-only',canonical_property_name:'fixture',checkin:'2027-01-03',checkout:'2027-01-04',stay_scope:'2_adults_1_room_1_night',availability_status:'available_price_basis',primary_price_numeric:33660,official_tax_fee_adder_numeric:null,computed_total_with_tax_fee:null,basis_confidence:'directional_candidate_basis',dp_usage:'directional_only',classification:'directional',screenshot_path:'/fixture/screenshot.png',debug_path:'/fixture/debug',warning_flags:[],collected_at_jst:'2026-11-03T08:00:06+09:00',source_phase:'fixture',...extra});
describe('closed RAM preview diagnostics without admission change',()=>{
 it('retains original amount/time and keeps tax and tuple evidence explicitly separate',()=>{
  const d=buildBookingPreviewRowPolicyDiagnostics(row());expect(d.primaryAmountJpy).toBe(33660);expect(d.originalCollectedAtJst).toBe('2026-11-03T08:00:06+09:00');expect(d.taxBasis).toBe('NOT_RECORDED_IN_PREVIEW');expect(d.officialTaxFeeAdderJpy).toBeNull();expect(d.priceAdmissionMeasured).toBe(false);expect(d.tupleEvidence).toBe('PREVIEW_DECLARED_SCOPE_NATIVE_DOCUMENT_PROOF_SEPARATE');expect(d.timestampRole).toBe('ORIGINAL_RUN_COLLECTED_AT_NOT_PER_PAGE_PRICE_TIME');
 });
 it('isolates one empty listing while retaining the ordinary row and refusing an all-empty batch',()=>{
  const empty=row({property_slug:'degraded-fixture',availability_status:'degraded_empty',classification:'excluded',basis_confidence:'insufficient',dp_usage:'audit_only',primary_price_numeric:null});
  const rows=[row(),empty];
  const check=buildBookingSourceLevelCheck(rows,2);
  const diagnostics=rows.map(buildBookingPreviewRowPolicyDiagnostics);
  expect(diagnostics[0]!.individualRowPolicyRejection).toBe('');
  expect(diagnostics[0]!.priceAdmissionMeasured).toBe(false);
  expect(diagnostics[1]!.sourcePropertyId).toBe('degraded-fixture');
  expect(diagnostics[1]!.availabilityStatus).toBe('degraded_empty');
  expect(check.append_allowed).toBe(true);
  const plan=buildAppendPlan({bookingRows:rows,jalanRows:[],existingKeys:[],bookingSourceCheck:check,jalanSourceCheck:buildJalanSourceLevelCheck([]),bookingReportPath:'',bookingCsvPath:''});
  expect(plan.new_row_count).toBe(1);
  expect(plan.approved_rows.map(r=>r.sourceSlugOrCode)).toEqual(['fixture-only']);
  expect(plan.rejected_rows.map(r=>r.reason)).toEqual(['source_degraded_page_detected']);
  expect(buildBookingSourceLevelCheck([empty],1).append_allowed).toBe(false);
 });
 it('retains challenge and individual rejection without persisting raw warning or page data',()=>{
  const r=row({warning_flags:['captcha detected secret_cookie=PRIVATE https://fixture.invalid/path?q=secret'],primary_room_card_text:'PRIVATE_PAGE_TEXT'}),d=buildBookingPreviewRowPolicyDiagnostics(r),text=JSON.stringify(d);expect(d.blockedOrLoginWarning).toBe(true);expect(d.individualRowPolicyRejection).toBe('blocked_or_login_warning');expect(buildBookingSourceLevelCheck([r],1).append_allowed).toBe(false);for(const secret of ['secret_cookie','PRIVATE','fixture.invalid','PRIVATE_PAGE_TEXT'])expect(text).not.toContain(secret);
 });
 it('does not copy malformed identifiers, dates, enums, amounts or collected-at text',()=>{
  const d=buildBookingPreviewRowPolicyDiagnostics(row({property_slug:'https://secret.invalid',checkin:'2027-02-31',checkout:'2027-01-04\nsecret',collected_at_jst:'PRIVATE',primary_price_numeric:Infinity,availability_status:'PRIVATE' as PreviewRow['availability_status']}));expect(d.sourcePropertyId).toBeNull();expect(d.checkin).toBeNull();expect(d.checkout).toBeNull();expect(d.originalCollectedAtJst).toBeNull();expect(d.primaryAmountJpy).toBeNull();expect(d.availabilityStatus).toBe('UNKNOWN');expect(JSON.stringify(d)).not.toContain('PRIVATE');
 });
});
