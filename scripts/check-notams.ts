/**
 * update-notams.ts
 *
 * Fetches UK NOTAM data and identifies NOTAMs that may be
 * relevant to temporary / tactical landing activity.
 *
 * Intended to be run periodically by GitHub Actions.
 *
 * TODO:
 * - Improve XML parsing based on the exact NATS schema
 * - Add AI classification
 * - Add Postgres/PostGIS persistence
 * - Add notifications
 */

import { writeFile, readFile } from "node:fs/promises";
import AdmZip from "adm-zip";
import { existsSync } from "node:fs";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const UAS_INDEX_URL =
  process.env.UAS_INDEX_URL ??
  "https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/";

const NOTAM_URL = process.env.NOTAM_URL ?? "";

const OUTPUT_FILE = process.env.OUTPUT_FILE ?? "./data/notams.json";

// Keywords are deliberately broad at this stage.
// The AI classifier can make the final determination later.
const INTERESTING_TERMS = [
  "TACTICAL",
  "TACTICAL LANDING",
  "LANDING SITE",
  "TEMPORARY LANDING",
  "TEMPORARY LANDING SITE",
  "LANDING AREA",
  "HELICOPTER LANDING",
  "HELICOPTER ACTIVITY",
  "MILITARY EXERCISE",
  "MILITARY ACTIVITY",
  "MILITARY AIRCRAFT",
  "ARMY AIR",
  "EXERCISE",
  "ASSAULT",
  "ROTARY WING",
  "MANOEUVRES",
  "FAST JET",
];

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface Notam {
  id: string;

  rawText: string;

  effectiveFrom?: string;
  effectiveTo?: string;

  location?: string;

  lowerLimit?: string;
  upperLimit?: string;

  qCode?: string;

  matchedTerms: string[];

  geometries?: any[];

  fetchedAt: string;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  let latest: { url: string; date: string } | null = null;
  let xml: string;

  if (NOTAM_URL && NOTAM_URL.length > 0) {
    // Use provided XML path (local file or remote XML URL).
    console.log(`Using NOTAM_URL provided: ${NOTAM_URL}`);

    // Attempt to extract a date from the filename if present
    const m = NOTAM_URL.match(/EG_UAS_FR_DS_AREA1_FULL_(\d{8})/);
    const date = m ? m[1] : undefined;

    latest = { url: NOTAM_URL, date: date ?? "" };

    xml = await fetchNotamFeed();
    console.log(
      `Loaded ${xml.length.toLocaleString()} characters from NOTAM_URL`,
    );
  } else {
    console.log("Discovering latest UAS dataset...");

    // Find latest UAS ZIP on the index page
    const indexHtml = await fetch(UAS_INDEX_URL).then((r) => r.text());

    latest = findLatestUasZipUrl(indexHtml);

    if (!latest) {
      throw new Error("Could not find a UAS XML ZIP link on the index page");
    }

    console.log(`Latest dataset found: ${latest.url} (date ${latest.date})`);

    // If already processed, skip
    const existingDate = await readExistingOutputDate();

    if (existingDate && existingDate === latest.date) {
      console.log(`Dataset ${latest.date} already processed — exiting.`);
      return;
    }

    console.log("Downloading and extracting XML...");

    xml = await downloadAndExtractXml(latest.url);

    console.log(`Downloaded ${xml.length.toLocaleString()} characters`);
  }

  const notams = parseNotams(xml);

  console.log(`Parsed ${notams.length} NOTAMs`);

  const candidates = notams
    .map((notam) => ({
      notam,
      matchedTerms: findInterestingTerms(notam.rawText),
    }))
    .filter((x) => x.matchedTerms.length > 0)
    .map(({ notam, matchedTerms }) => ({
      ...notam,
      matchedTerms,
    }));

  console.log(`Found ${candidates.length} potentially interesting NOTAMs`);

  await writeOutput(candidates, latest.date, latest.url);

  console.log(`Written results to ${OUTPUT_FILE}`);
}

// -----------------------------------------------------------------------------
// Fetch
// -----------------------------------------------------------------------------

async function fetchNotamFeed(): Promise<string> {
  // If NOTAM_URL looks like a local file path, read it directly.
  try {
    if (
      NOTAM_URL.startsWith("./") ||
      NOTAM_URL.startsWith("../") ||
      NOTAM_URL.endsWith(".xml") ||
      NOTAM_URL.startsWith("file:")
    ) {
      const path = NOTAM_URL.startsWith("file:")
        ? new URL(NOTAM_URL).pathname
        : NOTAM_URL;

      return await readFile(path, "utf8");
    }
  } catch (err) {
    // fall through to network fetch if local read fails
    console.warn("Local file read failed, falling back to network fetch:", err);
  }

  const response = await fetch(NOTAM_URL, {
    headers: {
      "User-Agent": "UK-NOTAM-Intelligence/0.1",
      Accept: "application/xml,text/xml,text/plain,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download NOTAM feed: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

function findLatestUasZipUrl(
  html: string,
): { url: string; date: string } | null {
  // Match links to the UAS AREA_1 XML ZIPs and capture the date
  const regex = /href="([^"]*EG_UAS_FR_DS_AREA1_FULL_(\d{8})_XML\.zip)"/gi;

  let match: RegExpExecArray | null;

  let best: { href: string; date: string } | null = null;

  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const date = match[2];

    if (!best || date > best.date) {
      best = { href, date };
    }
  }

  if (!best) return null;

  // Make absolute URL if needed
  const url = best.href.startsWith("http")
    ? best.href
    : `https://nats-uk.ead-it.com${best.href}`;

  return { url, date: best.date };
}

async function downloadAndExtractXml(zipUrl: string): Promise<string> {
  const res = await fetch(zipUrl);

  if (!res.ok) throw new Error(`Failed to download ZIP: ${res.status}`);

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  const zip = new AdmZip(buf);

  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.entryName.toLowerCase().endsWith(".xml")) {
      return entry.getData().toString("utf8");
    }
  }

  throw new Error("No XML file found inside ZIP");
}

async function readExistingOutputDate(): Promise<string | undefined> {
  try {
    if (!existsSync(OUTPUT_FILE)) return undefined;

    const content = await readFile(OUTPUT_FILE, "utf8");
    const parsed = JSON.parse(content);
    return parsed.datasetDate as string | undefined;
  } catch (err) {
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

function parseNotams(xml: string): Notam[] {
  /**
   * IMPORTANT:
   *
   * This is intentionally a lightweight parser.
   *
   * Once you've inspected the exact NATS XML structure, replace this
   * with proper XML parsing using something like fast-xml-parser.
   *
   * For now we try a few common NOTAM element structures.
   */

  const blocks = extractNotamBlocks(xml);

  return blocks.map((block, index) => {
    // Prefer human-readable note text when available
    const noteText =
      extractTag(block, "note") ?? extractTag(block, "translatedNote");

    const rawText = cleanXmlText(noteText ?? block);

    const geometries = parseGeometriesFromBlock(block);

    return {
      id:
        extractTag(block, "gml:identifier") ??
        extractTag(block, "id") ??
        extractTag(block, "notamNumber") ??
        `unknown-${index}`,

      rawText,

      effectiveFrom:
        extractTag(block, "gml:beginPosition") ??
        extractTag(block, "gml:timePosition") ??
        extractTag(block, "effectiveFrom") ??
        extractTag(block, "startDate") ??
        undefined,

      effectiveTo: getEffectiveTo(block),

      location:
        extractTag(block, "aixm:name") ??
        extractTag(block, "name") ??
        extractTag(block, "location") ??
        extractTag(block, "aerodrome") ??
        undefined,

      lowerLimit: extractTag(block, "lowerLimit") ?? undefined,

      upperLimit: extractTag(block, "upperLimit") ?? undefined,

      qCode: extractTag(block, "qCode") ?? undefined,

      matchedTerms: [],

      geometries: geometries,

      fetchedAt: new Date().toISOString(),
    };
  });
}

/**
 * Attempts to identify NOTAM blocks.
 *
 * Replace this once you've confirmed the exact NATS XML schema.
 */
function extractNotamBlocks(xml: string): string[] {
  const patterns = [
    /<NOTAM[\s\S]*?<\/NOTAM>/gi,
    /<notam[\s\S]*?<\/notam>/gi,
    /<notamItem[\s\S]*?<\/notamItem>/gi,
    /<Notam[\s\S]*?<\/Notam>/gi,
    /<aixm:Airspace[\s\S]*?<\/aixm:Airspace>/gi,
    /<Airspace[\s\S]*?<\/Airspace>/gi,
    /<message:hasMember[\s\S]*?<\/message:hasMember>/gi,
  ];

  for (const pattern of patterns) {
    const matches = xml.match(pattern);

    if (matches && matches.length > 0) {
      return matches;
    }
  }

  console.warn(
    "Could not identify NOTAM blocks using the current XML patterns.",
  );

  return [];
}

// -----------------------------------------------------------------------------
// Filtering
// -----------------------------------------------------------------------------

function findInterestingTerms(text: string): string[] {
  const normalised = normaliseText(text);

  return INTERESTING_TERMS.filter((term) =>
    normalised.includes(normaliseText(term)),
  );
}

function normaliseText(text: string): string {
  return text.toUpperCase().replace(/\s+/g, " ").trim();
}

// -----------------------------------------------------------------------------
// XML helpers
// -----------------------------------------------------------------------------

function extractTag(xml: string, tagName: string): string | undefined {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Allow an optional namespace prefix (e.g. aixm:, gml:, message:)
  const regex = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escaped}>`,
    "i",
  );

  const match = xml.match(regex);

  if (!match) {
    return undefined;
  }

  return cleanXmlText(match[1]);
}

function extractTagRaw(
  xml: string,
  tagName: string,
): { attrs: string; content: string } | undefined {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${escaped}([^>]*)>([\s\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escaped}>`,
    "i",
  );

  const match = xml.match(regex);

  if (!match) return undefined;

  return { attrs: match[1], content: match[2] };
}

function getEffectiveTo(xml: string): string | undefined {
  // Check gml:endPosition and similar tags; handle indeterminatePosition attribute
  const raw =
    extractTagRaw(xml, "gml:endPosition") ??
    extractTagRaw(xml, "gml:TimePeriod") ??
    undefined;

  if (!raw) {
    // Try other common names
    const alt =
      extractTagRaw(xml, "endDate") ?? extractTagRaw(xml, "effectiveTo");
    if (!alt) return undefined;

    return cleanXmlText(alt.content) || undefined;
  }

  // If tag has indeterminatePosition or content indicates unknown, treat as undefined
  if (
    /indeterminatePosition\s*=\s*"unknown"/i.test(raw.attrs) ||
    /unknown/i.test(raw.content)
  ) {
    return undefined;
  }

  const text = cleanXmlText(raw.content);
  return text || undefined;
}

function parseGeometriesFromBlock(xml: string): any[] {
  const geometries: any[] = [];

  // Circles (CircleByCenterPoint)
  const circleRegex =
    /<gml:CircleByCenterPoint[\s\S]*?<\/gml:CircleByCenterPoint>/gi;
  let m: RegExpExecArray | null;

  while ((m = circleRegex.exec(xml)) !== null) {
    const chunk = m[0];
    const center = extractTag(chunk, "gml:pos");
    const radius = extractTag(chunk, "gml:radius");

    if (center) {
      const [lat, lon] = center.trim().split(/\s+/).map(Number);
      const radiusVal = radius ? parseFloat(radius) : undefined;
      // try to detect unit attribute
      const unitMatch = chunk.match(/<gml:radius[^>]*uom="([^"]+)"/i);
      const unit = unitMatch ? unitMatch[1] : undefined;
      let radiusMeters: number | undefined = undefined;

      if (radiusVal != null && unit && /nmi/i.test(unit)) {
        radiusMeters = radiusVal * 1852;
      }

      geometries.push({
        type: "Circle",
        center: [lon, lat],
        radius: radiusVal,
        radiusUnit: unit,
        radiusMeters,
      });
    }
  }

  // Arc by center point (treat as circle arc with center and radius)
  const arcRegex = /<gml:ArcByCenterPoint[\s\S]*?<\/gml:ArcByCenterPoint>/gi;

  while ((m = arcRegex.exec(xml)) !== null) {
    const chunk = m[0];
    const center = extractTag(chunk, "gml:pos");
    const radius = extractTag(chunk, "gml:radius");

    if (center) {
      const [lat, lon] = center.trim().split(/\s+/).map(Number);
      const radiusVal = radius ? parseFloat(radius) : undefined;
      const unitMatch = chunk.match(/<gml:radius[^>]*uom="([^"]+)"/i);
      const unit = unitMatch ? unitMatch[1] : undefined;
      let radiusMeters: number | undefined = undefined;

      if (radiusVal != null && unit && /nmi/i.test(unit)) {
        radiusMeters = radiusVal * 1852;
      }

      geometries.push({
        type: "Arc",
        center: [lon, lat],
        radius: radiusVal,
        radiusUnit: unit,
        radiusMeters,
      });
    }
  }

  // GeodesicString or PolygonPatch -> sequences of positions
  const segmentRegex = /<gml:GeodesicString[\s\S]*?<\/gml:GeodesicString>/gi;

  while ((m = segmentRegex.exec(xml)) !== null) {
    const chunk = m[0];
    const posRegex = /<gml:pos[^>]*>([\s\S]*?)<\/gml:pos>/gi;
    const coords: Array<[number, number]> = [];
    let p: RegExpExecArray | null;

    while ((p = posRegex.exec(chunk)) !== null) {
      const pt = p[1].trim().split(/\s+/).map(Number);
      if (pt.length >= 2) coords.push([pt[1], pt[0]]); // [lon, lat]
    }

    if (coords.length) {
      geometries.push({ type: "LineString", coordinates: coords });
    }
  }

  // PolygonPatch -> extract polygon exterior positions
  const polygonRegex = /<gml:PolygonPatch[\s\S]*?<\/gml:PolygonPatch>/gi;

  while ((m = polygonRegex.exec(xml)) !== null) {
    const chunk = m[0];
    const posRegex = /<gml:pos[^>]*>([\s\S]*?)<\/gml:pos>/gi;
    const coords: Array<[number, number]> = [];
    let p: RegExpExecArray | null;

    while ((p = posRegex.exec(chunk)) !== null) {
      const pt = p[1].trim().split(/\s+/).map(Number);
      if (pt.length >= 2) coords.push([pt[1], pt[0]]); // [lon, lat]
    }

    // Only treat as polygon if we have at least 3 distinct points
    const uniqueCoords = coords
      .map((c) => c.join(","))
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((s) => s.split(",").map(Number) as [number, number]);

    if (uniqueCoords.length >= 3) {
      geometries.push({ type: "Polygon", coordinates: [uniqueCoords] });
    }
  }

  return geometries;
}

function cleanXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------

async function writeOutput(
  notams: Notam[],
  datasetDate?: string,
  sourceUrl?: string,
) {
  const output: any = {
    generatedAt: new Date().toISOString(),
    datasetDate: datasetDate,
    source: sourceUrl ?? NOTAM_URL,
    count: notams.length,
    notams,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
