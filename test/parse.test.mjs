// Regression tests against the real corpus captured in fixtures/.
// Per SPEC §8: "the fixtures are what tell you what broke" when EDS changes markup.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseOutageDate, parseRows, splitUliceCell, classifySegment, parsePage } from "../src/parse.mjs";

const DAN0 = await readFile(new URL("./fixtures/Nis/2026-08-10_Dan0.htm", import.meta.url), "utf8");
const DAN1 = await readFile(new URL("./fixtures/Nis/2026-08-10_Dan1.htm", import.meta.url), "utf8");
const DAN2_EMPTY = await readFile(new URL("./fixtures/Nis/2026-08-10_Dan2.htm", import.meta.url), "utf8");

describe("parseOutageDate", () => {
  it("parses the DD.MM.YYYY. header format", () => {
    expect(parseOutageDate(DAN0)).toEqual({
      raw: "НИШ - Планирана искључења за датум: 10.08.2026.",
      iso: "2026-08-10",
    });
  });

  it("falls back to null iso on unrecognized formats without throwing", () => {
    expect(parseOutageDate("<TABLE><TR><TD>no date here</TD></TR></TABLE>").iso).toBeNull();
  });
});

describe("parseRows", () => {
  it("extracts all 17 rows from the real Dan_0 page", () => {
    const rows = parseRows(DAN0);
    expect(rows.length).toBe(17);
    expect(rows[0]).toMatchObject({
      ogranak: "Ниш",
      opstina: "Пантелеј",
      timeStart: "08:00",
      timeEnd: "10:00",
      uliceRaw: "део Книнске улице;", // raw is kept untouched, incl. trailing ';' — see SPEC's raw_streets note
    });
  });

  it("returns an empty array for a header-only (no-outage) day", () => {
    expect(parseRows(DAN2_EMPTY)).toEqual([]);
  });

  it("parses time windows into start/end", () => {
    const rows = parseRows(DAN1);
    expect(rows[0].timeStart).toBe("07:30");
    expect(rows[0].timeEnd).toBe("14:00");
  });
});

describe("splitUliceCell", () => {
  it("does not split inside parentheses", () => {
    const segs = splitUliceCell(
      "Деспота Ђурђа (20б,22,22а,27а,42,44), Грчка (4, непарни бр. 1-19,бб)",
    );
    expect(segs).toEqual([
      "Деспота Ђурђа (20б,22,22а,27а,42,44)",
      "Грчка (4, непарни бр. 1-19,бб)",
    ]);
  });

  it("strips trailing sentence punctuation from the whole cell", () => {
    expect(splitUliceCell("део Книнске улице;")).toEqual(["део Книнске улице"]);
    expect(splitUliceCell("Власи.")).toEqual(["Власи"]);
  });

  it("KNOWN LIMITATION: loses a shared list-header prefix across items", () => {
    // "Села Секирача,Влахиња,Власово" — only the first item keeps "Села".
    // Real finding from the live corpus (see src/parse.mjs header comment).
    // This test documents current behavior, not the desired end state.
    const segs = splitUliceCell("Села Секирача,Влахиња,Власово");
    expect(segs).toEqual(["Села Секирача", "Влахиња", "Власово"]);
  });
});

describe("classifySegment", () => {
  it("tags a trailing numeric parenthetical as parenthetical_numbers", () => {
    expect(classifySegment("Деспота Ђурђа (20б,22,22а,27а,42,44)").type).toBe("parenthetical_numbers");
  });

  it("tags a trailing text parenthetical as parenthetical_alias", () => {
    expect(classifySegment("Данковиће (Ђокићи)").type).toBe("parenthetical_alias");
  });

  it("tags 'део .../делови ... улица' prose", () => {
    expect(classifySegment("део Книнске улице").type).toBe("deo_ulice_prose");
    expect(classifySegment("делови улица Нишке и Пастерова").type).toBe("deo_ulice_prose");
  });

  it("tags 'Село'/'Села'/'Насеље' as selo_naselje", () => {
    expect(classifySegment("Село Смрдан").type).toBe("selo_naselje");
    expect(classifySegment("Део села Ћуковац правац према Губетину").type).toBe("selo_naselje");
    expect(classifySegment("део Насеља Просек").type).toBe("selo_naselje");
  });

  it("tags a bare name with none of the above markers as bare", () => {
    expect(classifySegment("Власи").type).toBe("bare");
  });

  it("tags 'бр.' / 'од ... до' prose ranges as prose_range (regression: \\b is ASCII-only, breaks on Cyrillic)", () => {
    expect(classifySegment("Ђорђа Лешњака бр. 7 и 13").type).toBe("prose_range");
    expect(classifySegment("Булевар ослобођења од бр. 94 до бр. 143").type).toBe("prose_range");
  });

  it("tags a municipality-qualified list as colon_list", () => {
    expect(classifySegment("Књажевац, улице: Шпанских Бораца, Цара Лазара").type).toBe("colon_list");
  });

  it("always preserves the raw text verbatim", () => {
    const raw = "Неготинска (13,15,17,18-35)";
    expect(classifySegment(raw).raw).toBe(raw);
  });
});

describe("parsePage integration", () => {
  it("attaches classified segments to every row", () => {
    const { rows } = parsePage(DAN1);
    expect(rows.length).toBe(22);
    for (const row of rows) {
      expect(Array.isArray(row.segments)).toBe(true);
      expect(row.segments.length).toBeGreaterThan(0);
    }
  });
});
