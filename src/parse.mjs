// Phase 1 data spike: table parser + Ulice cell splitter/classifier.
//
// IMPORTANT — this is NOT the SPEC §4 street resolution ladder. That needs a
// seeded OSM gazetteer (§3) which doesn't exist yet. This module only extracts
// rows faithfully and classifies each Ulice *segment* by rough shape, so we can
// measure how heterogeneous the real corpus is before designing the ladder.
//
// Finding so far (see fixtures/Nis/2026-08-10_Dan{0,1}.htm, captured live):
// the real Ulice format does NOT match SPEC.md §1's assumed
// "STREET NAME: <ranges>" / "Насеље <NAME>: ..." shape. Observed shapes instead:
//   - "Naziv (brojevi)"              e.g. "Деспота Ђурђа (20б,22,22а,27а,42,44)"
//   - "део/делови улица X, Y и Z"    free prose, usually NO house numbers at all
//   - "Село/Села X, Y и Z"           village lists, no street detail
//   - "у <City> , улица X - ..."     city-qualified free text
//   - "од бр. N до бр. M" / "бр. N и M"  prose house-number ranges, no parens
//   - "Општина, улице: X, Y, Z"      colon-delimited list under a municipality
// SPEC.md §1 and §9 should be updated to reflect this before Phase 2 design.

import * as cheerio from "cheerio";

/**
 * Extract the outage date from the page header.
 * Observed: "НИШ - Планирана искључења за датум: 10.08.2026." (DD.MM.YYYY.)
 * SPEC §1 warns Belgrade may use ISO (YYYY-MM-DD) — handle both defensively.
 */
export function parseOutageDate(html) {
  const $ = cheerio.load(html);
  const headerText = $("table").first().text().trim();

  const dmy = /(\d{2})\.(\d{2})\.(\d{4})\.?/.exec(headerText);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return { raw: headerText, iso: `${yyyy}-${mm}-${dd}` };
  }

  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(headerText);
  if (iso) {
    return { raw: headerText, iso: iso[0] };
  }

  return { raw: headerText, iso: null };
}

/**
 * Extract data rows from the second table (first table is just the date header).
 * Belgrade pages omit the Ogranak column (SPEC §1), so detect column count per row.
 */
export function parseRows(html) {
  const $ = cheerio.load(html);
  const tables = $("table");
  if (tables.length < 2) return [];

  const dataTable = tables.eq(1);
  const trs = dataTable.find("tr");
  if (trs.length < 2) return []; // header only = empty day, valid per SPEC §1

  const rows = [];
  trs.slice(1).each((_, tr) => {
    const tds = $(tr).find("td");
    const cells = tds.toArray().map((td) => $(td).text().trim());
    if (cells.length === 4) {
      const [ogranak, opstina, vreme, ulice] = cells;
      rows.push({ ogranak, opstina, vremeRaw: vreme, uliceRaw: ulice, ...parseVreme(vreme) });
    } else if (cells.length === 3) {
      // Belgrade: no Ogranak column
      const [opstina, vreme, ulice] = cells;
      rows.push({ ogranak: null, opstina, vremeRaw: vreme, uliceRaw: ulice, ...parseVreme(vreme) });
    }
    // else: unexpected shape — silently skipped rows would hide real breakage,
    // so callers should compare rows.length against trs.length - 1 if they care.
  });
  return rows;
}

/** "08:30 - 10:30" -> { timeStart: "08:30", timeEnd: "10:30" } */
function parseVreme(raw) {
  const m = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(raw);
  return m ? { timeStart: m[1], timeEnd: m[2] } : { timeStart: null, timeEnd: null };
}

/**
 * Split a raw Ulice cell into top-level segments on `,`/`;`, respecting
 * parenthesis depth (so "Naziv (1-16, 25)" doesn't get cut at the inner comma).
 * Trailing sentence punctuation ('.', ';') is trimmed from the whole cell first.
 */
export function splitUliceCell(raw) {
  const cleaned = raw.trim().replace(/[;.]+\s*$/, "");
  const segments = [];
  let depth = 0;
  let current = "";

  for (const ch of cleaned) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);

    if ((ch === "," || ch === ";") && depth === 0) {
      segments.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) segments.push(current.trim());

  return segments.filter(Boolean);
}

// NOTE: JS's \b is ASCII-only — \w is [A-Za-z0-9_], so \b never fires at a
// Cyrillic word edge (neither side counts as "word", so there's no boundary
// to detect). Use \p{L} lookaround with the /u flag instead for real
// Unicode-aware boundaries. Caught by a failing test against real data —
// worth remembering for any other regex added to this file later.
const SELO_RE = /^(део\s+)?(сел[ао]|насељ[ае])(?![\p{L}])/iu;
const DEO_ULICE_RE = /^(дел(о|ови|ове)\s+)?.*улиц/i;
const TRAILING_PAREN_RE = /\(([^()]*)\)\s*$/;
const PROSE_RANGE_RE = /(?<![\p{L}])бр\.?(?![\p{L}])|(?<![\p{L}])од(?![\p{L}]).*(?<![\p{L}])до(?![\p{L}])/iu;
const COLON_LIST_RE = /:/;

/**
 * Does the content of a trailing "(...)" look like a house-number list
 * ("20б,22,22а", "непарни бр. 1-19,бб") rather than a text alias
 * ("Ђокићи")? Heuristic only — for Phase 1 shape reconnaissance.
 */
function looksNumeric(parenContent) {
  const stripped = parenContent
    .replace(/непарн\w*|парн\w*|бр\.?|бб|и/gi, "")
    .replace(/[\s,.-]/g, "");
  if (!stripped) return true; // e.g. "(бб)" alone
  const digits = (stripped.match(/\d/g) || []).length;
  return digits / stripped.length >= 0.5;
}

/**
 * Classify one top-level segment by rough shape. Always keeps the raw text —
 * per SPEC's own principle for `outage.raw_streets`, never lose the original.
 */
export function classifySegment(raw) {
  const seg = raw.trim();

  if (SELO_RE.test(seg)) {
    return { raw: seg, type: "selo_naselje", note: "village/settlement-level, likely no street detail" };
  }

  const parenMatch = TRAILING_PAREN_RE.exec(seg);
  if (parenMatch) {
    const streetGuess = seg.slice(0, parenMatch.index).trim();
    const numeric = looksNumeric(parenMatch[1]);
    return {
      raw: seg,
      type: numeric ? "parenthetical_numbers" : "parenthetical_alias",
      streetGuess,
      parenContent: parenMatch[1],
    };
  }

  if (COLON_LIST_RE.test(seg)) {
    return { raw: seg, type: "colon_list", note: "municipality-qualified list, needs sub-splitting on the list after ':'" };
  }

  if (DEO_ULICE_RE.test(seg)) {
    return { raw: seg, type: "deo_ulice_prose", note: "partial street, free prose, usually no house numbers" };
  }

  if (PROSE_RANGE_RE.test(seg)) {
    return { raw: seg, type: "prose_range", note: "house-number range expressed as prose, not parens" };
  }

  return { raw: seg, type: "bare", note: "bare name (street or area), whole-street/whole-area scope" };
}

/** Parse a full page: date + rows, each row's Ulice cell split and classified. */
export function parsePage(html) {
  const date = parseOutageDate(html);
  const rows = parseRows(html).map((row) => ({
    ...row,
    segments: splitUliceCell(row.uliceRaw).map(classifySegment),
  }));
  return { date, rows };
}
