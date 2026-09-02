import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NOTAM_URL =
  process.env.NOTAM_URL ??
  "https://nats-uk.ead-it.com/cms-nats/export/sites/default/en/Publications/digital-datasets/UAS_AREA_1/EG_UAS_FR_DS_AREA1_FULL_20260903_XML.zip";

const STATE_FILE = resolve(
  process.env.STATE_FILE ?? "./data/pembrey-state.json",
);
const OUTPUT_FILE = resolve(
  process.env.OUTPUT_FILE ?? "./data/pembrey-notam.json",
);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const TELEGRAM_MESSAGE_THREAD_ID = process.env.TELEGRAM_MESSAGE_THREAD_ID ?? "";
const TIDE_URL =
  process.env.TIDE_URL ??
  "https://www.tide-forecast.com/locations/Burry-Port/tides/latest";

const PEMBREY_TOKENS = [
  /\bPEMBREY\b/i,
  /\bPEMBREY\s+SANDS\b/i,
  /\bSANDS\b.*\bPEMBREY\b/i,
  /\bPEMBREY\b.*\bSANDS\b/i,
];

const LANDING_TOKENS = [
  /\bTACTICAL\b/i,
  /\bTEMPORARY\s+LANDING\b/i,
  /\bLANDING\b/i,
  /\bHELICOPTER\b/i,
  /\bLOW\s*TIDE\b/i,
  /\bEXERCISE\b/i,
  /\bMILITARY\b/i,
  /\bSANDS\b/i,
];

export interface WatchState {
  version: number;
  lastCheckedAt?: string;
  lastAlertAt?: string;
  processed: Array<{
    id: string;
    checkedAt: string;
    summary: string;
  }>;
  processedValidityDates: string[];
}

export interface ParsedNotam {
  id: string;
  rawText: string;
  location?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  lowerLimit?: string;
  upperLimit?: string;
  qCode?: string;
  fetchedAt: string;
  matchedTerms: string[];
}

export interface TideEstimate {
  source: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  likelyLowTide?: string;
  tides?: TideEvent[];
}

export interface TideEvent {
  date: string;
  type: "low" | "high";
  time: string;
}

async function main() {
  await ensureFileStorage();

  const xml = await fetchNotamFeed();
  const sourceValidityDate = extractFeedValidityDate(xml, NOTAM_URL);
  const state = await loadState();

  if (
    sourceValidityDate &&
    state.processedValidityDates.includes(sourceValidityDate)
  ) {
    state.lastCheckedAt = new Date().toISOString();
    await writeOutput([]);
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    await sendStatusAlert(
      `Pembrey watch ran: no new NOTAM data. Dataset validity date ${sourceValidityDate} was already processed.`,
    );
    console.log(
      `Data validity date ${sourceValidityDate} already processed; skipping further checks.`,
    );
    return;
  }

  const notams = parseNotams(xml);
  const matches = notams.filter(isPembreyRelevant);

  if (matches.length === 0) {
    state.lastCheckedAt = new Date().toISOString();
    await writeOutput([]);
    if (sourceValidityDate) {
      state.processedValidityDates = addUniqueDate(
        state.processedValidityDates,
        sourceValidityDate,
      );
    }
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    await sendStatusAlert(
      `Pembrey watch ran: NOTAM data is new, but nothing of interest was found for validity date ${sourceValidityDate ?? "unknown"}.`,
    );
    console.log(
      `No Pembrey-related NOTAMs found for validity date ${sourceValidityDate ?? "unknown"}; recorded dataset check.`,
    );
    return;
  }

  const newMatches = matches.filter(
    (notam) => !state.processed.some((item) => item.id === notam.id),
  );

  if (newMatches.length === 0) {
    state.lastCheckedAt = new Date().toISOString();
    await writeOutput([]);
    if (sourceValidityDate) {
      state.processedValidityDates = addUniqueDate(
        state.processedValidityDates,
        sourceValidityDate,
      );
    }
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    await sendStatusAlert(
      `Pembrey watch ran: no new NOTAM data. No new Pembrey tactical-landing notices were found for validity date ${sourceValidityDate ?? "unknown"}.`,
    );
    console.log(
      `No new Pembrey NOTAMs for validity date ${sourceValidityDate ?? "unknown"}; recorded dataset check.`,
    );
    return;
  }

  const enriched = await Promise.all(
    newMatches.map(async (notam) => {
      const tideEstimate = await estimateTideWindow(notam);
      const aiSummary = await summariseNotam(notam, tideEstimate);

      return {
        ...notam,
        tideEstimate,
        aiSummary,
        alertReady: true,
      };
    }),
  );

  await writeOutput(enriched);

  for (const item of enriched) {
    await sendAlert(item);
  }

  state.lastCheckedAt = new Date().toISOString();
  state.lastAlertAt = new Date().toISOString();
  state.processed = [
    ...state.processed,
    ...enriched.map((item) => ({
      id: item.id,
      checkedAt: new Date().toISOString(),
      summary: item.aiSummary,
    })),
  ].slice(-250);
  if (sourceValidityDate) {
    state.processedValidityDates = addUniqueDate(
      state.processedValidityDates,
      sourceValidityDate,
    );
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");

  console.log(
    `Processed ${enriched.length} new Pembrey NOTAMs and sent alerts.`,
  );
}

export function isPembreyRelevant(
  notam: Pick<ParsedNotam, "location" | "rawText">,
): boolean {
  const text = `${notam.location ?? ""} ${notam.rawText ?? ""}`;

  const hasPembrey = PEMBREY_TOKENS.some((pattern) => pattern.test(text));
  const hasLandingSignal = LANDING_TOKENS.some((pattern) => pattern.test(text));

  return hasPembrey && hasLandingSignal;
}

export function buildTideHint(
  notam: Pick<ParsedNotam, "rawText" | "effectiveFrom" | "effectiveTo">,
  tideHtml?: string,
): TideEstimate {
  const text = `${notam.rawText ?? ""}`.toUpperCase();
  const tides = tideHtml ? parseTideEvents(tideHtml, notam) : [];
  const lowTides = tides.filter((tide) => tide.type === "low");

  if (lowTides.length > 0) {
    const tideList = lowTides
      .map((tide) => `${tide.date} ${tide.time} BST`)
      .join(", ");
    return {
      source: TIDE_URL,
      summary: `Low tides inside the NOTAM period are ${tideList}.`,
      confidence: "high",
      likelyLowTide: lowTides[0].time,
      tides,
    };
  }

  if (/LOW\s*TIDE/i.test(text) || /TIDE/i.test(text)) {
    return {
      source: TIDE_URL,
      summary:
        "The notice appears to be tide-sensitive; check the nearest low tide window within the NOTAM period.",
      confidence: "medium",
      tides,
    };
  }

  return {
    source: TIDE_URL,
    summary:
      "The NOTAM does not specify an exact daily operating time, so the safest bet is to watch the nearest low-tide period inside the published window.",
    confidence: "low",
    tides,
  };
}

export function parseTideEvents(
  tideHtml: string,
  notam?: Pick<ParsedNotam, "effectiveFrom" | "effectiveTo">,
): TideEvent[] {
  const text = tideHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<\/(?:h[1-6]|tr|p|li|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ");
  const headingPattern =
    /Tide Times for [^:]+:\s*(?:\(tomorrow\):\s*)?([A-Za-z]+ \d{1,2} [A-Za-z]+ \d{4})/gi;
  const headings = Array.from(text.matchAll(headingPattern));
  const startDate = normalizeDate(notam?.effectiveFrom);
  const endDate = normalizeDate(notam?.effectiveTo) ?? startDate;
  const events: TideEvent[] = [];

  for (const [index, heading] of headings.entries()) {
    const date = normalizeDate(heading[1]);
    if (
      !date ||
      (startDate && date < startDate) ||
      (endDate && date > endDate)
    ) {
      continue;
    }

    const sectionEnd = headings[index + 1]?.index ?? text.length;
    const section = text.slice(heading.index! + heading[0].length, sectionEnd);
    const eventPattern =
      /\b(Low|High) Tide\s+(\d{1,2}:\d{2}\s*(?:AM|PM)|\d{1,2}:\d{2})/gi;

    for (const event of section.matchAll(eventPattern)) {
      const tide = {
        date,
        type: event[1].toLowerCase() as TideEvent["type"],
        time: event[2].replace(/\s+/g, " ").toUpperCase(),
      };
      if (
        !events.some(
          (item) =>
            item.date === tide.date &&
            item.type === tide.type &&
            item.time === tide.time,
        )
      ) {
        events.push(tide);
      }
    }
  }

  return events;
}

export function buildEmailText(item: {
  id: string;
  location?: string;
  rawText: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  lowerLimit?: string;
  upperLimit?: string;
  tideEstimate?: TideEstimate;
  aiSummary?: string;
}): string {
  const location = item.location ?? "Pembrey Sands";
  const when = [
    item.effectiveFrom
      ? `from ${formatDate(item.effectiveFrom)}`
      : "from the published start",
    item.effectiveTo
      ? `to ${formatDate(item.effectiveTo)}`
      : "until the published end",
  ].join(" ");

  return [
    "Pembrey Sands tactical landing alert",
    "",
    `Location: ${location}`,
    `Timing: ${when}`,
    `Altitude: ${item.lowerLimit ?? "?"} to ${item.upperLimit ?? "?"} ft`,
    `Tide guidance: ${item.tideEstimate?.summary ?? "Not enough data to estimate a precise tide window."}`,
    "",
    "Summary:",
    item.aiSummary ?? "No AI summary was generated.",
    "",
    "Raw NOTAM:",
    item.rawText,
  ].join("\n");
}

async function fetchNotamFeed(): Promise<string> {
  if (NOTAM_URL.startsWith("http://") || NOTAM_URL.startsWith("https://")) {
    const response = await fetch(NOTAM_URL, {
      headers: {
        "User-Agent": "Pembrey-Spotter-Watcher/0.1",
        Accept: "application/xml,text/xml,text/plain,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch NOTAM feed: ${response.status}`);
    }

    return response.text();
  }

  return readFile(NOTAM_URL, "utf8");
}

function parseNotams(xml: string): ParsedNotam[] {
  const blocks = Array.from(xml.matchAll(/<NOTAM[\s\S]*?<\/NOTAM>/gi)).map(
    (m) => m[0],
  );
  if (blocks.length === 0) return [];

  return blocks.map((block, index) => {
    const rawText = cleanXmlText(
      extractTag(block, "note") ?? extractTag(block, "translatedNote") ?? block,
    );

    return {
      id:
        extractTag(block, "gml:identifier") ??
        extractTag(block, "id") ??
        extractTag(block, "notamNumber") ??
        `notam-${index}`,
      rawText,
      location:
        extractTag(block, "aixm:name") ??
        extractTag(block, "name") ??
        extractTag(block, "location") ??
        extractTag(block, "aerodrome") ??
        undefined,
      effectiveFrom:
        extractTag(block, "gml:beginPosition") ??
        extractTag(block, "gml:timePosition") ??
        extractTag(block, "effectiveFrom") ??
        undefined,
      effectiveTo: getEffectiveTo(block),
      lowerLimit: extractTag(block, "lowerLimit") ?? undefined,
      upperLimit: extractTag(block, "upperLimit") ?? undefined,
      qCode: extractTag(block, "qCode") ?? undefined,
      fetchedAt: new Date().toISOString(),
      matchedTerms: findInterestingTerms(rawText),
    };
  });
}

function findInterestingTerms(text: string): string[] {
  const keywords = [
    "TACTICAL",
    "LANDING",
    "PEMBREY",
    "HELICOPTER",
    "MILITARY",
    "EXERCISE",
    "LOW TIDE",
    "SANDS",
  ];

  const upper = text.toUpperCase();
  return keywords.filter((term) => upper.includes(term));
}

function addUniqueDate(dates: string[], next: string): string[] {
  const normalized = normalizeDate(next);
  if (!normalized) return dates;

  const nextDates = [...new Set([...(dates ?? []), normalized])];
  return nextDates.slice(-250);
}

function normalizeDate(value?: string): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const isoMatch = trimmed.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const compactMatch = trimmed.match(/(\d{8})/);
  if (compactMatch) {
    const digits = compactMatch[1];
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function extractFeedValidityDate(
  xml: string,
  sourceUrl?: string,
): string | undefined {
  const urlDate = normalizeDate(
    sourceUrl?.match(/(\d{4})[-_]?\d{2}[-_]?\d{2}/)?.[0] ??
      sourceUrl?.match(/(\d{8})/)?.[1],
  );

  if (urlDate) return urlDate;

  const tagCandidates = [
    "validity",
    "validFrom",
    "validityStart",
    "datasetValidity",
    "publicationDate",
    "issuedDate",
    "gml:beginPosition",
    "gml:timePosition",
    "effectiveFrom",
    "beginPosition",
  ];

  for (const tag of tagCandidates) {
    const value = extractTag(xml, tag);
    const normalized = normalizeDate(value);
    if (normalized) return normalized;
  }

  return undefined;
}

function extractTag(xml: string, tagName: string): string | undefined {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escaped}>`,
    "i",
  );
  const match = xml.match(regex);
  return match ? cleanXmlText(match[1]) : undefined;
}

function getEffectiveTo(xml: string): string | undefined {
  const raw =
    extractTagRaw(xml, "gml:endPosition") ?? extractTagRaw(xml, "effectiveTo");
  if (!raw) return undefined;
  return cleanXmlText(raw.content) || undefined;
}

function extractTagRaw(
  xml: string,
  tagName: string,
): { attrs: string; content: string } | undefined {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${escaped}([^>]*)>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escaped}>`,
    "i",
  );
  const match = xml.match(regex);
  return match ? { attrs: match[1], content: match[2] } : undefined;
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

async function ensureFileStorage() {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
}

async function writeOutput(notams: unknown[]) {
  await writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        notams,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function estimateTideWindow(notam: ParsedNotam): Promise<TideEstimate> {
  try {
    const response = await fetch(TIDE_URL, {
      headers: { "User-Agent": "Pembrey-Spotter-Watcher/0.1" },
    });
    if (!response.ok) {
      throw new Error(`Tide fetch failed: ${response.status}`);
    }
    const tideHtml = await response.text();

    return buildTideHint(notam, tideHtml);
  } catch {
    return buildTideHint(notam);
  }
}

async function summariseNotam(notam: ParsedNotam, tideEstimate: TideEstimate) {
  const apiKey = process.env.OPENAI_API_KEY;
  const tideData = tideEstimate.tides?.length
    ? tideEstimate.tides
        .map((tide) => `${tide.date} ${tide.type} tide at ${tide.time} BST`)
        .join("\n")
    : "No dated tide observations were parsed.";

  if (!apiKey) {
    return [
      `${notam.location ?? "Pembrey Sands"} looks like tactical landing or beach-based aviation activity.`,
      `The published window is ${formatDate(notam.effectiveFrom ?? "unknown")} to ${formatDate(notam.effectiveTo ?? "unknown")}.`,
      `Tide guidance: ${tideEstimate.summary}`,
    ].join(" ");
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        input: [
          {
            role: "system",
            content:
              "You are a concise aviation-spotting assistant. Read this NOTAM and tell the user whether it looks like a Pembrey Sands tactical landing, what aircraft or activity is likely, and whether the best time is around low tide. Keep it plain, useful, and to the point. Max 2 short paragraphs.",
          },
          {
            role: "user",
            content: `NOTAM:\n${notam.rawText}\n\nApproximate timing window: ${formatDate(notam.effectiveFrom ?? "unknown")} to ${formatDate(notam.effectiveTo ?? "unknown")}\nAltitude band: ${notam.lowerLimit ?? "?"} to ${notam.upperLimit ?? "?"} ft\nTide hint: ${tideEstimate.summary}\n\nDated tide observations from Pembroke Dock (BST):\n${tideData}\n\nUse only tide observations whose dates fall inside the NOTAM window. Do not infer a time from the first row or ignore the dates.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`AI summary failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };

    const text =
      data.output_text ??
      (data.output ?? [])
        .flatMap((entry) => entry.content ?? [])
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();

    return (
      text ||
      `${notam.location ?? "Pembrey Sands"} appears to be a tactical landing or local aviation activity window, so check the nearest low-tide period within the event window.`
    );
  } catch {
    return `${notam.location ?? "Pembrey Sands"} appears to be a tactical landing or local aviation activity window, so check the nearest low-tide period within the event window.`;
  }
}

async function sendAlert(item: {
  id: string;
  location?: string;
  rawText: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  lowerLimit?: string;
  upperLimit?: string;
  tideEstimate?: TideEstimate;
  aiSummary?: string;
}) {
  const subject = `Pembrey Sands tactical landing alert: ${formatDate(item.effectiveFrom ?? "unknown")} to ${formatDate(item.effectiveTo ?? "unknown")}`;
  const message = `${subject}\n\n${buildEmailText(item)}`;

  await sendTelegramMessage(message);
  console.log(`Telegram alert sent for ${item.location ?? "Pembrey Sands"}`);
}

async function sendStatusAlert(message: string): Promise<void> {
  await sendTelegramMessage(message);
}

async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`Would send Telegram message:\n${message}`);
    return;
  }

  const body = new URLSearchParams({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    disable_web_page_preview: "true",
  });

  if (TELEGRAM_MESSAGE_THREAD_ID) {
    body.set("message_thread_id", TELEGRAM_MESSAGE_THREAD_ID);
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );

  const data = (await response.json()) as {
    ok?: boolean;
    description?: string;
  };

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram send failed: ${response.status} ${data.description ?? "unknown error"}`,
    );
  }
}

async function loadState(): Promise<WatchState> {
  if (!existsSync(STATE_FILE)) {
    return { version: 1, processed: [], processedValidityDates: [] };
  }

  try {
    const content = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(content) as Partial<WatchState>;
    return {
      version: parsed.version ?? 1,
      lastCheckedAt: parsed.lastCheckedAt,
      lastAlertAt: parsed.lastAlertAt,
      processed: Array.isArray(parsed.processed) ? parsed.processed : [],
      processedValidityDates: Array.isArray(parsed.processedValidityDates)
        ? parsed.processedValidityDates
            .map((date) => normalizeDate(String(date)))
            .filter((date): date is string => Boolean(date))
        : [],
    };
  } catch {
    return { version: 1, processed: [], processedValidityDates: [] };
  }
}

function formatDate(value: string): string {
  if (!value || value === "unknown") return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch(async (error) => {
    console.error("Pembrey watch failed:", error);
    try {
      await sendStatusAlert(
        `Pembrey watch error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch (notificationError) {
      console.error(
        "Failed to send Telegram error notification:",
        notificationError,
      );
    }
    process.exit(1);
  });
}
