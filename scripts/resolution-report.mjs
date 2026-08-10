// Phase 1 deliverable (SPEC §7): "how many distinct street segments, what %
// resolve exactly [against OSM], what the weird cases look like."
//
// The OSM-resolution part isn't here yet — that needs the gazetteer seeded
// per SPEC §3, which is a separate step (Overpass fetch + street table).
// This report covers the part we *can* measure today: how the raw Ulice
// cells break down by shape, across every page fetched into fixtures/.
// Run after `npm run fetch` has built up a few days of corpus.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parsePage } from "../src/parse.mjs";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function loadAllPages() {
  const cities = await readdir(FIXTURES_ROOT, { withFileTypes: true }).catch(() => []);
  const pages = [];
  for (const cityDir of cities) {
    if (!cityDir.isDirectory()) continue;
    const dir = path.join(FIXTURES_ROOT, cityDir.name);
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".htm")) continue;
      const html = await readFile(path.join(dir, f), "utf8");
      pages.push({ city: cityDir.name, file: f, html });
    }
  }
  return pages;
}

function main() {
  return loadAllPages().then((pages) => {
    if (pages.length === 0) {
      console.error("No fixtures found. Run `npm run fetch` first.");
      process.exitCode = 1;
      return;
    }

    const byType = new Map();
    const examples = new Map();
    let totalRows = 0;
    let totalSegments = 0;
    let emptyPages = 0;

    for (const { city, file, html } of pages) {
      const { rows } = parsePage(html);
      if (rows.length === 0) emptyPages++;
      totalRows += rows.length;

      for (const row of rows) {
        for (const seg of row.segments) {
          totalSegments++;
          byType.set(seg.type, (byType.get(seg.type) ?? 0) + 1);
          if (!examples.has(seg.type)) examples.set(seg.type, []);
          const list = examples.get(seg.type);
          if (list.length < 4) list.push(`${city}/${file}: "${seg.raw}"`);
        }
      }
    }

    console.log(`Pages parsed:    ${pages.length} (${emptyPages} empty)`);
    console.log(`Rows total:      ${totalRows}`);
    console.log(`Segments total:  ${totalSegments}\n`);

    console.log("Segment shape breakdown:");
    const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      const pct = ((count / totalSegments) * 100).toFixed(1);
      console.log(`  ${type.padEnd(22)} ${String(count).padStart(4)}  (${pct}%)`);
    }

    console.log("\nExamples per shape:");
    for (const [type, list] of examples) {
      console.log(`\n  [${type}]`);
      for (const ex of list) console.log(`    ${ex}`);
    }

    console.log(`
NOTE: this is shape reconnaissance, not the SPEC §4 resolution ladder — no OSM
gazetteer lookups happen here yet. "parenthetical_numbers" is the only shape
that already looks directly matchable to house-number ranges as SPEC.md
assumed; the rest ("deo_ulice_prose", "selo_naselje", "prose_range",
"colon_list", and even much of "bare") need real design work before Phase 2:
most carry no house numbers at all, several need cross-referencing the
municipality/village against a settlement gazetteer rather than a street
gazetteer, and comma-joined list items can lose a shared prefix (see the
"KNOWN LIMITATION" test in test/parse.test.mjs). Recommend updating SPEC.md
§1 and §9 with these findings before designing the resolution ladder.`);
  });
}

main();
