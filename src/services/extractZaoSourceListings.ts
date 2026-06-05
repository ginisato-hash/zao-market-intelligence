import { normalizePropertyName } from "./propertyAliasResolver";

/**
 * Phase 46.6X — faithful extraction of the Zao Onsen lodging universe from the
 * two source listing pages the work order pins as the market baseline:
 *
 *   - Jalan keyword search:  https://www.jalan.net/uw/uwp2011/uww2011init.do?keyword=蔵王温泉&distCd=06&rootCd=7701
 *   - Rakuten onsen page:    https://travel.rakuten.co.jp/onsen/yamagata/OK00161.html
 *
 * This module ONLY parses already-fetched HTML/text. It performs no network
 * access, no price/availability collection, and no paid-API calls. Geographic
 * filtering (Zao-Onsen vs broad-keyword noise) is intentionally NOT done here —
 * extraction is faithful to the page; the universe builder decides membership.
 */

export type SourceListingSource = "jalan" | "rakuten";

export type ListingExtractionStatus = "extracted" | "needs_review" | "not_found";

export interface ExtractedSourceListing {
  source: SourceListingSource;
  sourceListUrl: string;
  propertyNameRaw: string;
  propertyNameNormalized: string;
  propertyUrl: string | null;
  sourcePropertyId: string | null;
  extractionStatus: ListingExtractionStatus;
  evidenceNote: string;
}

/** Re-exported so callers share one normalization implementation. */
export { normalizePropertyName };

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " "
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/** Strip tags, decode entities, collapse whitespace (incl. full-width space). */
function cleanText(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/[\s　]+/g, " ")
    .trim();
}

/**
 * Extract the numeric Jalan yad id from any of: a bare id ("327282"), a detail
 * URL ("https://www.jalan.net/yad327282/"), or an openYadoSyosai('327282', ...)
 * call. Returns null when no id is present.
 */
export function extractJalanYadId(input: string): string | null {
  if (!input) {
    return null;
  }
  const fromCall = input.match(/openYadoSyosai\(\s*'(\d+)'/u);
  if (fromCall?.[1]) {
    return fromCall[1];
  }
  const fromUrl = input.match(/yad(\d+)/u);
  if (fromUrl?.[1]) {
    return fromUrl[1];
  }
  const bare = input.match(/^\s*(\d+)\s*$/u);
  return bare?.[1] ?? null;
}

/**
 * Extract the numeric Rakuten hotel number from a bare id, a HOTEL/NNNN/ URL,
 * or a hotelinfo/plan/NNNN URL. Returns null when no number is present.
 */
export function extractRakutenHotelNo(input: string): string | null {
  if (!input) {
    return null;
  }
  const fromHotelPath = input.match(/HOTEL\/(\d+)/u);
  if (fromHotelPath?.[1]) {
    return fromHotelPath[1];
  }
  const fromPlan = input.match(/hotelinfo\/plan\/(\d+)/u);
  if (fromPlan?.[1]) {
    return fromPlan[1];
  }
  const bare = input.match(/^\s*(\d+)\s*$/u);
  return bare?.[1] ?? null;
}

export function jalanPropertyUrl(yadId: string): string {
  return `https://www.jalan.net/yad${yadId}/`;
}

export function rakutenPropertyUrl(hotelNo: string): string {
  return `https://travel.rakuten.co.jp/HOTEL/${hotelNo}/`;
}

function makeListing(
  source: SourceListingSource,
  sourceListUrl: string,
  rawName: string,
  id: string | null,
  url: string | null,
  status: ListingExtractionStatus,
  evidenceNote: string
): ExtractedSourceListing {
  return {
    source,
    sourceListUrl,
    propertyNameRaw: rawName,
    propertyNameNormalized: normalizePropertyName(rawName),
    propertyUrl: url,
    sourcePropertyId: id,
    extractionStatus: status,
    evidenceNote
  };
}

/**
 * Parse the Jalan search-results HTML. Each result cassette exposes its yad id
 * through an `openYadoSyosai('<id>', '<total>_<page>_<index>', ...)` call and its
 * display name through `<h2 class="...facilityName...">NAME</h2>`. We pair the
 * two by the ordered index token so duplicate href/data-href ids do not double
 * count. Works on raw or UTF-8-decoded HTML; tolerant of text fragments.
 */
export function extractJalanListingsFromHtmlOrText(
  html: string,
  sourceListUrl: string
): ExtractedSourceListing[] {
  const idRe = /openYadoSyosai\(\s*'(\d+)'\s*,\s*'(\d+_\d+_\d+)'/gu;
  const orderedIds: string[] = [];
  const seenIndexTokens = new Set<string>();
  for (let m = idRe.exec(html); m !== null; m = idRe.exec(html)) {
    const id = m[1]!;
    const indexToken = m[2]!;
    if (seenIndexTokens.has(indexToken)) {
      continue;
    }
    seenIndexTokens.add(indexToken);
    orderedIds.push(id);
  }

  const nameRe = /facilityName[^>]*>([\s\S]*?)<\/h2>/gu;
  const names: string[] = [];
  for (let m = nameRe.exec(html); m !== null; m = nameRe.exec(html)) {
    names.push(cleanText(m[1]!));
  }

  const listings: ExtractedSourceListing[] = [];
  const count = Math.max(orderedIds.length, names.length);
  for (let i = 0; i < count; i++) {
    const id = orderedIds[i] ?? null;
    const rawName = names[i] ?? "";
    if (id && rawName) {
      listings.push(
        makeListing(
          "jalan",
          sourceListUrl,
          rawName,
          id,
          jalanPropertyUrl(id),
          "extracted",
          `Extracted from Jalan search results: yad${id} paired with facilityName "${rawName}".`
        )
      );
    } else if (rawName) {
      listings.push(
        makeListing(
          "jalan",
          sourceListUrl,
          rawName,
          null,
          null,
          "needs_review",
          `Jalan facilityName "${rawName}" found but no yad id could be paired — verify manually.`
        )
      );
    } else if (id) {
      listings.push(
        makeListing(
          "jalan",
          sourceListUrl,
          "",
          id,
          jalanPropertyUrl(id),
          "needs_review",
          `Jalan yad${id} found but no facility name could be paired — verify manually.`
        )
      );
    }
  }
  return listings;
}

/**
 * Parse the Rakuten onsen listing HTML. Each property lives in a
 * `<div class="hotelBox" ...>` block whose `<h3>` contains an
 * `<a href="//travel.rakuten.co.jp/HOTEL/<no>/<no>.html">NAME</a>` link. The
 * faithful display name is the anchor text (the sibling `<span>蔵王温泉</span>`
 * is an onsen-area label and is ignored). Works on raw or decoded HTML.
 */
export function extractRakutenListingsFromHtmlOrText(
  html: string,
  sourceListUrl: string
): ExtractedSourceListing[] {
  const blocks = html.split(/<div class="hotelBox"/u).slice(1);
  const listings: ExtractedSourceListing[] = [];
  const seenIds = new Set<string>();

  for (const block of blocks) {
    const id = extractRakutenHotelNo(block);
    const h3 = block.match(/<h3>([\s\S]*?)<\/h3>/u);
    let rawName = "";
    if (h3?.[1]) {
      const anchor = h3[1].match(/<a[^>]*HOTEL\/\d+[^>]*>([\s\S]*?)<\/a>/u);
      rawName = cleanText(anchor?.[1] ?? h3[1]);
    }
    if (!id && !rawName) {
      continue;
    }
    if (id && seenIds.has(id)) {
      continue;
    }
    if (id) {
      seenIds.add(id);
    }
    if (id && rawName) {
      listings.push(
        makeListing(
          "rakuten",
          sourceListUrl,
          rawName,
          id,
          rakutenPropertyUrl(id),
          "extracted",
          `Extracted from Rakuten onsen listing: HOTEL/${id} with anchor name "${rawName}".`
        )
      );
    } else {
      listings.push(
        makeListing(
          "rakuten",
          sourceListUrl,
          rawName,
          id,
          id ? rakutenPropertyUrl(id) : null,
          "needs_review",
          `Rakuten hotelBox parsed with incomplete data (id=${id ?? "none"}, name="${rawName}") — verify manually.`
        )
      );
    }
  }
  return listings;
}
