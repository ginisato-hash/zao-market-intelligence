import {it,expect} from 'vitest';
import {parseExplicitBookingStayLabels as parse,parseExplicitBookingDateFields as fields} from '../src/services/bookingProductObservability';
const jp='2027年1月15日(金) — 2027年1月16日(土)',expected={checkin:'2027-01-15',checkout:'2027-01-16'};
for(const [text,aria]of [['Dates',jp],[jp,null],['1月15日(金) — 1月16日(土)',jp],['2027-01-15 — 2027-01-16',jp],['２０２７年１月１５日（金）〜２０２７年１月１６日（土）',jp]] as Array<[string,string|null]>)it('proves an explicit year-bearing same-control range: '+text,()=>expect(parse(text,aria)).toEqual(expected));
for(const [name,text,aria]of [
 ['no year','1月15日(金) — 1月16日(土)',null],
 ['one year only','2027年1月15日(金) — 1月16日(土)',null],
 ['contradictory dates','2027年1月14日(木) — 2027年1月15日(金)',jp],
 ['contradictory partial date','1月14日(木) — 1月15日(金)',jp],
 ['contradictory year','2028年1月15日 — 2028年1月16日',jp],
 ['wrong weekday','2027年1月15日(月) — 2027年1月16日(火)',null],
 ['invalid calendar date','2027年2月30日 — 2027年3月1日',null],
 ['reversed dates','2027年1月16日 — 2027年1月15日',null],
 ['multiple nights','2027年1月15日 — 2027年1月17日',null],
 ['extra ambiguous text',jp+' または 2027年1月17日',null],
 ['sensitive label','Dates',jp+' password=test'],
 ['URL label','Dates','https://synthetic.invalid/?checkin=2027-01-15&checkout=2027-01-16'],
 ['conflicting unparsed label','明日から',jp]
] as Array<[string,string,string|null]>)it('refuses '+name+' without URL or current-year inference',()=>expect(parse(text,aria)).toBeNull());
it('accepts explicit full Japanese weekday labels and still checks the weekday',()=>{
 expect(parse('2027年1月15日金曜日 — 2027年1月16日土曜日',null)).toEqual(expected);
 expect(parse('2027年1月15日月曜日 — 2027年1月16日火曜日',null)).toBeNull();
});
it('accepts a completely labelled comma-separated accessible stay range',()=>expect(parse('チェックイン日：2027年1月15日金曜日、チェックアウト日：2027年1月16日土曜日',null)).toEqual(expected));
it('does not interpret an unlabelled comma-separated date list as a stay range',()=>expect(parse('2027年1月15日、2027年1月16日',null)).toBeNull());
const typed=()=>[{id:'date-display-field-start',count:1,visible:true,text:'1月15日(金)',aria:'チェックイン日：2027年1月15日金曜日'},{id:'date-display-field-end',count:1,visible:true,text:'1月16日(土)',aria:'チェックアウト日：2027年1月16日土曜日'}];
it('proves both years from two typed visible descendants of the same date control',()=>expect(fields('1月15日(金) — 1月16日(土)',null,typed())).toEqual(expected));
for(const mode of ['missing-year','hidden','duplicate','wrong-id','wrong-date','wrong-weekday','ambiguous','sensitive','reversed']as const)it('refuses typed date field '+mode,()=>{
 const f=typed();if(mode==='missing-year')f[1]!.aria='1月16日(土)';if(mode==='hidden')f[1]!.visible=false;if(mode==='duplicate')f[0]!.count=2;if(mode==='wrong-id')f[0]!.id='unrelated';
 if(mode==='wrong-date')f[1]!.aria='2027年1月17日日曜日';if(mode==='wrong-weekday')f[1]!.aria='2027年1月16日月曜日';if(mode==='ambiguous')f[0]!.aria+=' または2028年1月15日';if(mode==='sensitive')f[0]!.aria+=' password=synthetic';if(mode==='reversed')f.reverse();
 expect(fields('1月15日(金) — 1月16日(土)',null,f)).toBeNull();
});
it('refuses contradictory outer date labels despite valid inner fields',()=>{
 expect(fields('1月14日(木) — 1月15日(金)',null,typed())).toBeNull();expect(fields('1月15日(金) — 1月16日(土)','2028年1月15日 — 2028年1月16日',typed())).toBeNull();
});
const noYears=()=>typed().map(f=>({...f,aria:null as string|null,title:null as string|null,times:[] as {value:string;text:string}[]}));
it('proves each year from the title of its exact visible typed field',()=>{
 const f=noYears();f[0]!.title='2027年1月15日金曜日';f[1]!.title='2027年1月16日土曜日';expect(fields('1月15日(金) — 1月16日(土)',null,f)).toEqual(expected);
});
it('proves each year from one semantic time in each exact visible typed field',()=>{
 const f=noYears();f[0]!.times=[{value:'2027-01-15',text:'1月15日(金)'}];f[1]!.times=[{value:'2027-01-16',text:'1月16日(土)'}];expect(fields('1月15日(金) — 1月16日(土)',null,f)).toEqual(expected);
});
for(const mode of ['only-start','duplicate-time','timestamp','timezone','impossible-date','wrong-role','time-text-conflict','title-conflict','aria-conflict','unknown-title'] as const)it('refuses additional year witness '+mode,()=>{
 const f=noYears();f[0]!.times=[{value:'2027-01-15',text:'1月15日(金)'}];f[1]!.times=[{value:'2027-01-16',text:'1月16日(土)'}];
 if(mode==='only-start')f[1]!.times=[];if(mode==='duplicate-time')f[0]!.times.push({...f[0]!.times[0]!});if(mode==='timestamp')f[0]!.times[0]!.value='2027-01-15T00:00:00';if(mode==='timezone')f[0]!.times[0]!.value='2027-01-14T15:00:00Z';if(mode==='impossible-date')f[0]!.times[0]!.value='2027-02-30';if(mode==='wrong-role')f.reverse();if(mode==='time-text-conflict')f[0]!.times[0]!.text='1月14日(木)';if(mode==='title-conflict')f[0]!.title='2028年1月15日';if(mode==='aria-conflict')f[0]!.aria='2028年1月15日';if(mode==='unknown-title')f[0]!.title='別の日を選択';
 expect(fields('1月15日(金) — 1月16日(土)',null,f)).toBeNull();
});
