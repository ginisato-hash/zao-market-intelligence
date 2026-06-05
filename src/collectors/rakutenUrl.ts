import type { CollectorInput } from "../domain/types";

const RAKUTEN_HOTEL_URL_PATTERN = /^https:\/\/travel\.rakuten\.co\.jp\/HOTEL\/\d+\/?/u;

export function buildRakutenAttemptUrl(input: CollectorInput): string {
  if (input.propertyUrl === undefined || input.propertyUrl === null || !RAKUTEN_HOTEL_URL_PATTERN.test(input.propertyUrl)) {
    throw new Error("Rakuten property_url must match https://travel.rakuten.co.jp/HOTEL/[hotelNo]/");
  }

  const url = new URL(input.propertyUrl);
  const checkin = parseStayDate(input.stayDate);
  const checkout = new Date(checkin);
  checkout.setUTCDate(checkout.getUTCDate() + input.nights);

  url.searchParams.set("f_checkin_date", formatRakutenDate(checkin));
  url.searchParams.set("f_checkout_date", formatRakutenDate(checkout));
  url.searchParams.set("f_adult_num", String(input.adults ?? input.guests));
  url.searchParams.set("f_room_num", String(input.rooms ?? 1));
  url.searchParams.set("f_stay", String(input.nights));
  return url.toString();
}

function parseStayDate(stayDate: string): Date {
  const date = new Date(`${stayDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(stayDate)) {
    throw new Error("stayDate must be a valid YYYY-MM-DD date");
  }
  return date;
}

function formatRakutenDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}
