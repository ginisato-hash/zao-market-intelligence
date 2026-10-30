import {it,expect} from 'vitest';
import {parseExplicitBookingStayLabels as parse} from '../src/services/bookingProductObservability';
const jp='2027年1月15日(金) — 2027年1月16日(土)',expected={checkin:'2027-01-15',checkout:'2027-01-16'};
for(const [text,aria]of [['Dates',jp],[jp,null],['1月15日(金) — 1月16日(土)',jp],['2027-01-15 — 2027-01-16',jp],['２０２７年１月１５日（金）〜２０２７年１月１６日（土）',jp]])it('proves an explicit year-bearing same-control range: '+text,()=>expect(parse(text,aria)).toEqual(expected));
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
])it('refuses '+name+' without URL or current-year inference',()=>expect(parse(text,aria)).toBeNull());
