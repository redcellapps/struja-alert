// Phase 1 data spike: fetch raw EDS outage pages and dump them to fixtures/.
// Run daily (see SPEC §7 Phase 1) to build a real corpus before writing the parser
// against anything else. Safe to re-run same day: writes are content-hash keyed,
// so re-running never destroys a prior day's snapshot.
//
// Usage:
//   node scripts/fetch-corpus.mjs                 # MVP city only (Nis)
//   node scripts/fetch-corpus.mjs --all-cities     # every slug in CITY_SLUGS
//   node scripts/fetch-corpus.mjs --city Kraljevo  # one specific city

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import iconv from "iconv-lite";
import {
  URL_SRBIJA,
  DAYS,
  CITY_SLUGS,
  MVP_CITY,
  USER_AGENT,
} from "../src/config.mjs";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REQUEST_DELAY_MS = 500; // politeness: don't hammer the server even in a single run

function todayStamp() {
  // Local date, not UTC, since EDS publishes on Serbian local time.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * EDS pages are declared inconsistently (SPEC §1: "Windows-1251/UTF-8 Cyrillic").
 * Decode defensively: prefer a UTF-8 BOM or Content-Type charset if present,
 * otherwise try UTF-8 and fall back to windows-1251 if the result looks corrupt.
 */
function decodeBody(buf, contentType) {
  const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasUtf8Bom) {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8 (bom)" };
  }

  const charsetMatch = /charset=([\w-]+)/i.exec(contentType || "");
  const declared = charsetMatch?.[1]?.toLowerCase();
  if (declared && declared !== "utf-8" && declared !== "utf8") {
    try {
      return { text: iconv.decode(buf, declared), encoding: `${declared} (declared)` };
    } catch {
      // fall through to sniffing below
    }
  }

  const utf8Text = buf.toString("utf8");
  const looksCorrupt = utf8Text.includes("�");
  if (!looksCorrupt) {
    return { text: utf8Text, encoding: "utf-8 (sniffed)" };
  }

  return { text: iconv.decode(buf, "win1251"), encoding: "windows-1251 (fallback)" };
}

async function fetchOne(city, n) {
  const url = URL_SRBIJA(city, n);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  const buf = Buffer.from(await res.arrayBuffer());

  if (!res.ok) {
    return {
      city, n, url, ok: false,
      status: res.status,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  }

  const { text, encoding } = decodeBody(buf, res.headers.get("content-type"));
  const hash = sha256(Buffer.from(text, "utf8"));

  return {
    city, n, url, ok: true,
    status: res.status,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    encoding,
    byteLength: buf.length,
    hash,
    text,
  };
}

async function previousHash(dir, base) {
  const metaPath = path.join(dir, `${base}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    return meta.hash ?? null;
  } catch {
    return null;
  }
}

async function saveResult(result, stamp) {
  const dir = path.join(FIXTURES_ROOT, result.city);
  await mkdir(dir, { recursive: true });
  const base = `${stamp}_Dan${result.n}`;

  if (!result.ok) {
    await writeFile(
      path.join(dir, `${base}.json`),
      JSON.stringify({ url: result.url, status: result.status, fetchedAt: new Date().toISOString(), error: true }, null, 2),
    );
    return { ...result, changed: null, saved: false };
  }

  const prevHash = await previousHash(dir, base);
  const changed = prevHash !== null ? prevHash !== result.hash : true;

  await writeFile(path.join(dir, `${base}.htm`), result.text, "utf8");
  await writeFile(
    path.join(dir, `${base}.json`),
    JSON.stringify(
      {
        url: result.url,
        status: result.status,
        etag: result.etag,
        lastModified: result.lastModified,
        encoding: result.encoding,
        byteLength: result.byteLength,
        hash: result.hash,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return { ...result, changed, saved: true };
}

async function main() {
  const args = process.argv.slice(2);
  let cities;
  if (args.includes("--all-cities")) {
    cities = CITY_SLUGS;
  } else {
    const cityIdx = args.indexOf("--city");
    cities = cityIdx !== -1 && args[cityIdx + 1] ? [args[cityIdx + 1]] : [MVP_CITY];
  }

  const stamp = todayStamp();
  console.log(`Fetching corpus for ${cities.join(", ")}, days ${DAYS.join(",")} -> fixtures/*/${stamp}_Dan{N}.htm\n`);

  const summary = [];
  for (const city of cities) {
    for (const n of DAYS) {
      const result = await fetchOne(city, n);
      const saved = await saveResult(result, stamp);
      summary.push(saved);

      if (!saved.ok) {
        console.log(`  ✗ ${city} Dan_${n}: HTTP ${saved.status}`);
      } else {
        const changeNote = saved.changed === false ? "unchanged" : "NEW/CHANGED";
        console.log(`  ✓ ${city} Dan_${n}: ${saved.byteLength}B, ${saved.encoding}, ${changeNote}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const failures = summary.filter((s) => !s.ok);
  console.log(`\nDone: ${summary.length} pages, ${failures.length} failures.`);
  if (failures.length === summary.length && summary.length > 0) {
    console.error("WARNING: every fetch failed — site may be down or markup/URL scheme changed. See SPEC §7 Phase 4 monitoring.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error in fetch-corpus:", err);
  process.exitCode = 1;
});
