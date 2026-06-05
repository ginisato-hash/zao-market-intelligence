import type { Page } from "playwright";

export interface RakutenButtonCandidate {
  text?: string;
  tagName?: string;
  role?: string;
  type?: string;
  id?: string;
  className?: string;
}

export interface RakutenDateFieldCandidate {
  labelText?: string;
  tagName?: string;
  type?: string;
  name?: string;
  id?: string;
  className?: string;
  value?: string;
  placeholder?: string;
}

export interface RakutenGuestFieldCandidate {
  labelText?: string;
  tagName?: string;
  type?: string;
  name?: string;
  id?: string;
  className?: string;
  value?: string;
}

export interface RakutenFormInspectionResult {
  inspected: boolean;
  searchButtonCandidates: RakutenButtonCandidate[];
  dateFieldCandidates: RakutenDateFieldCandidate[];
  guestFieldCandidates: RakutenGuestFieldCandidate[];
  visibleSignals: string[];
}

export const FORM_INSPECTOR_MAX_CANDIDATES = 10;

/** Captures limited DOM metadata from the Rakuten hotel search form area.
 *  Does NOT modify the DOM — read-only inspection only. */
export async function inspectRakutenForm(page: Page): Promise<RakutenFormInspectionResult> {
  try {
    const raw = await page.evaluate(({ maxC }: { maxC: number }) => {
      // Avoid named helper assignments — use direct inline operations only.
      // tsx/esbuild injects __name() for named const arrow assignments in some
      // configurations, and __name is not defined in the browser evaluate context.

      type RawButton = { text: string; tagName: string; role: string; type: string; id: string; className: string };
      type RawDate   = { labelText: string; tagName: string; type: string; name: string; id: string; className: string; value: string; placeholder: string };
      type RawGuest  = { labelText: string; tagName: string; type: string; name: string; id: string; className: string; value: string };

      const searchButtonCandidates: RawButton[] = [];
      const dateFieldCandidates:   RawDate[]    = [];
      const guestFieldCandidates:  RawGuest[]   = [];

      // ── Search buttons ────────────────────────────────────────────────────
      const btnEls = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button']"));
      for (let bi = 0; bi < btnEls.length && searchButtonCandidates.length < maxC; bi++) {
        const el = btnEls[bi] as HTMLButtonElement;
        const txt = (el.textContent ?? "").trim().slice(0, 100);
        const aria = el.getAttribute("aria-label") ?? "";
        if (txt.length === 0 && !el.id && aria.length === 0) continue;
        searchButtonCandidates.push({
          text: txt,
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute("role") ?? "",
          type: el.type ?? "",
          id: el.id ?? "",
          className: (el.className ?? "").slice(0, 100)
        });
      }

      // ── Date-related inputs ───────────────────────────────────────────────
      const dateRx = /checkin|checkout|check_in|check_out|arrival|departure|date/i;
      const inputEls = Array.from(document.querySelectorAll("input"));
      for (let ii = 0; ii < inputEls.length && dateFieldCandidates.length < maxC; ii++) {
        const inp = inputEls[ii] as HTMLInputElement;
        if (!dateRx.test(inp.name) && !dateRx.test(inp.id) &&
            !dateRx.test(inp.placeholder) && !dateRx.test(inp.className) &&
            inp.type !== "date" && inp.type !== "text" && inp.type !== "hidden") continue;
        // nearby label: look for sibling or parent label text
        const parent = inp.parentElement;
        const lblEl = parent ? (inp.closest("label") ?? parent.querySelector("label")) : null;
        const prevEl = inp.previousElementSibling;
        const labelText = lblEl
          ? (lblEl.textContent ?? "").trim().slice(0, 80)
          : prevEl
            ? (prevEl.textContent ?? "").trim().slice(0, 80)
            : (parent ? (parent.textContent ?? "").trim().slice(0, 40) : "");
        dateFieldCandidates.push({
          labelText,
          tagName: "input",
          type: inp.type ?? "",
          name: inp.name ?? "",
          id: inp.id ?? "",
          className: (inp.className ?? "").slice(0, 100),
          value: (inp.value ?? "").slice(0, 80),
          placeholder: inp.placeholder ?? ""
        });
      }

      // Custom date-picker elements with data attributes
      const dateDivEls = Array.from(document.querySelectorAll("[data-checkin],[data-checkout],[data-date]"));
      for (let di = 0; di < dateDivEls.length && dateFieldCandidates.length < maxC; di++) {
        const el = dateDivEls[di] as HTMLElement;
        const parent = el.parentElement;
        const lblEl = parent ? (el.closest("label") ?? parent.querySelector("label")) : null;
        const prevEl = el.previousElementSibling;
        const labelText = lblEl
          ? (lblEl.textContent ?? "").trim().slice(0, 80)
          : prevEl
            ? (prevEl.textContent ?? "").trim().slice(0, 80)
            : "";
        dateFieldCandidates.push({
          labelText,
          tagName: el.tagName.toLowerCase(),
          type: "",
          name: el.getAttribute("name") ?? "",
          id: el.id ?? "",
          className: (el.className ?? "").slice(0, 100),
          value: (el.textContent ?? "").trim().slice(0, 80),
          placeholder: ""
        });
      }

      // ── Guest / room fields ───────────────────────────────────────────────
      // All <select> elements (most likely adult/room dropdowns)
      const selectEls2 = Array.from(document.querySelectorAll("select"));
      for (let si = 0; si < selectEls2.length && guestFieldCandidates.length < maxC; si++) {
        const sel = selectEls2[si] as HTMLSelectElement;
        const parent = sel.parentElement;
        const lblEl = parent ? (sel.closest("label") ?? parent.querySelector("label")) : null;
        const prevEl = sel.previousElementSibling;
        const labelText = lblEl
          ? (lblEl.textContent ?? "").trim().slice(0, 80)
          : prevEl
            ? (prevEl.textContent ?? "").trim().slice(0, 80)
            : (parent ? (parent.textContent ?? "").trim().slice(0, 40) : "");
        guestFieldCandidates.push({
          labelText,
          tagName: "select",
          type: "",
          name: sel.name ?? "",
          id: sel.id ?? "",
          className: (sel.className ?? "").slice(0, 100),
          value: sel.value ?? ""
        });
      }

      // Number inputs and named adult/room/guest inputs
      const guestInputEls = Array.from(document.querySelectorAll(
        "input[type='number'],input[name*='adult'],input[name*='room'],input[name*='guest']"
      ));
      for (let gi = 0; gi < guestInputEls.length && guestFieldCandidates.length < maxC; gi++) {
        const inp = guestInputEls[gi] as HTMLInputElement;
        const parent = inp.parentElement;
        const lblEl = parent ? (inp.closest("label") ?? parent.querySelector("label")) : null;
        const prevEl = inp.previousElementSibling;
        const labelText = lblEl
          ? (lblEl.textContent ?? "").trim().slice(0, 80)
          : prevEl
            ? (prevEl.textContent ?? "").trim().slice(0, 80)
            : "";
        guestFieldCandidates.push({
          labelText,
          tagName: "input",
          type: inp.type ?? "",
          name: inp.name ?? "",
          id: inp.id ?? "",
          className: (inp.className ?? "").slice(0, 100),
          value: inp.value ?? ""
        });
      }

      // ── Visible signals ───────────────────────────────────────────────────
      const bodyText = document.body.textContent ?? "";
      const visibleSignals: string[] = [];
      if (/日付指定なし/.test(bodyText)) visibleSignals.push("date_not_set");
      if (/大人\s*[0-9]/.test(bodyText)) visibleSignals.push("adult_count_visible");
      if (/子供\s*[0-9]/.test(bodyText)) visibleSignals.push("child_count_visible");

      const allSelectEls = document.querySelectorAll("select");
      visibleSignals.push("select_count:" + allSelectEls.length);

      const allInputEls = document.querySelectorAll("input");
      visibleSignals.push("input_count:" + allInputEls.length);

      const namedInputNames = Array.from(document.querySelectorAll("input[name]"))
        .map(i => (i as HTMLInputElement).name).join(",").slice(0, 200);
      if (namedInputNames.length > 0) visibleSignals.push("named_inputs:" + namedInputNames);

      const namedSelectNames = Array.from(document.querySelectorAll("select[name]"))
        .map(s => (s as HTMLSelectElement).name).join(",").slice(0, 200);
      if (namedSelectNames.length > 0) visibleSignals.push("named_selects:" + namedSelectNames);

      return { searchButtonCandidates, dateFieldCandidates, guestFieldCandidates, visibleSignals };
    }, { maxC: FORM_INSPECTOR_MAX_CANDIDATES });

    // Map raw strings → properly-optional interface fields (strip empty strings)
    return {
      inspected: true,
      searchButtonCandidates: raw.searchButtonCandidates.map(b => ({
        ...(b.text     ? { text:      b.text      } : {}),
        ...(b.tagName  ? { tagName:   b.tagName   } : {}),
        ...(b.role     ? { role:      b.role      } : {}),
        ...(b.type     ? { type:      b.type      } : {}),
        ...(b.id       ? { id:        b.id        } : {}),
        ...(b.className? { className: b.className } : {})
      })),
      dateFieldCandidates: raw.dateFieldCandidates.map(d => ({
        ...(d.labelText  ? { labelText:   d.labelText   } : {}),
        ...(d.tagName    ? { tagName:     d.tagName     } : {}),
        ...(d.type       ? { type:        d.type        } : {}),
        ...(d.name       ? { name:        d.name        } : {}),
        ...(d.id         ? { id:          d.id          } : {}),
        ...(d.className  ? { className:   d.className   } : {}),
        ...(d.value      ? { value:       d.value       } : {}),
        ...(d.placeholder? { placeholder: d.placeholder } : {})
      })),
      guestFieldCandidates: raw.guestFieldCandidates.map(g => ({
        ...(g.labelText ? { labelText: g.labelText } : {}),
        ...(g.tagName   ? { tagName:   g.tagName   } : {}),
        ...(g.type      ? { type:      g.type      } : {}),
        ...(g.name      ? { name:      g.name      } : {}),
        ...(g.id        ? { id:        g.id        } : {}),
        ...(g.className ? { className: g.className } : {}),
        ...(g.value     ? { value:     g.value     } : {})
      })),
      visibleSignals: raw.visibleSignals
    };
  } catch (error) {
    return {
      inspected: false,
      searchButtonCandidates: [],
      dateFieldCandidates: [],
      guestFieldCandidates: [],
      visibleSignals: [
        "inspection_failed:" + (error instanceof Error ? error.message.slice(0, 120) : "unknown")
      ]
    };
  }
}
