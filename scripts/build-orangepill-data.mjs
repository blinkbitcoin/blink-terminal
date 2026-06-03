#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * build-orangepill-data.mjs
 *
 * Converts the `bitcoinCalendar` repo (https://github.com/pretyflaco/bitcoinCalendar)
 * into two bundled JSON datasets used by the receipt "orange-pill" footer:
 *
 *   lib/orangepill/data/quotes.json    - [{ text, author }]
 *   lib/orangepill/data/calendar.json  - { "MM-DD": { events: string[], links: Link[] } }
 *
 * Source files in the calendar repo:
 *   - bitcoinQuotes / satoshiQuotes : lines of  "<quote>"\t- <Author>  (delimiter varies)
 *   - 01-January .. 12-December     : per-day entries.
 *        A day starts with a "M/D" token (optionally followed by event text).
 *        Indented continuation lines that start with a 4-digit year are events.
 *        Lines starting with "QR" are curated links:
 *            QR <year> - <Author> - <Title> <url>      (author optional)
 *
 * Usage:
 *   node scripts/build-orangepill-data.mjs [path-to-bitcoinCalendar]
 *
 * Defaults to ~/Documents/BLINK/bitcoinCalendar. Output is committed to the repo,
 * so this script only needs to run when the source data changes.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const OUT_DIR = path.join(REPO_ROOT, "lib", "orangepill", "data")

const DEFAULT_SOURCE = path.join(os.homedir(), "Documents", "BLINK", "bitcoinCalendar")
const SOURCE = process.argv[2] || DEFAULT_SOURCE

// Month file names in the repo (note the original typos are preserved).
const MONTH_FILES = [
  "01-January",
  "02-Feburary",
  "03-March",
  "04-April",
  "05-May",
  "06-June",
  "07-July",
  "08-August",
  "09-September",
  "10-October",
  "11-November",
  "12-December",
]

const QUOTE_FILES = ["bitcoinQuotes", "satoshiQuotes"]

/** Collapse internal whitespace and trim. */
function normalize(s) {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * Max length for a quote/body to remain in rotation. Mirrors MAX_BODY_LEN in
 * lib/orangepill/selectContent.ts and FOOTER_TEXT_MAX in CompanionAdapter, so
 * no committed quote can be truncated downstream.
 */
const MAX_QUOTE_LEN = 420

/** Explicit transliteration overrides (mirrors lib/escpos/asciiize.ts). */
const ASCII_OVERRIDES = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u2032": "'",
  "\u00B4": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  "\u2033": '"',
  "\u00AB": '"',
  "\u00BB": '"',
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2026": "...",
  "\u00A0": " ",
  "\u2009": " ",
  "\u202F": " ",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\u0153": "oe",
  "\u0152": "OE",
  "\u00E6": "ae",
  "\u00C6": "AE",
  "\u00DF": "ss",
  "\u0142": "l",
  "\u0141": "L",
  "\u00F8": "o",
  "\u00D8": "O",
  "\u0111": "d",
  "\u0110": "D",
  "\u2022": "*",
  "\u20AC": "EUR",
  "\u00A3": "GBP",
  "\u00A5": "JPY",
}

/**
 * Transliterate text to printer-safe 7-bit ASCII (mirrors lib/escpos/asciiize).
 * Receipts print on CP437 thermal printers, so bake ASCII into the dataset.
 */
function asciiize(input) {
  if (!input) return input
  let out = ""
  for (const ch of input) out += ASCII_OVERRIDES[ch] ?? ch
  out = out.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  // eslint-disable-next-line no-control-regex
  return out.replace(/[^\x09\x0a\x20-\x7e]/g, "")
}

/**
 * Parse a quotes file into { text, author }[].
 * Lines look like:  "<quote text>"\t- <Author>  or  "<quote>" - <Author>
 * or (unwrapped)    <quote text>\t<Author>
 *
 * Quote-wrapped lines are matched GREEDILY to the LAST quote char so that
 * quotes containing inner quote marks (e.g. `"The state "plans" ..."`) keep
 * their full text — the author always follows the final closing quote and
 * never itself contains a quote char. Unwrapped lines fall back to a tab split.
 */
function parseQuotes(raw) {
  const out = []
  for (const lineRaw of raw.split("\n")) {
    const line = lineRaw.trim()
    if (!line) continue

    let text = ""
    let author = ""

    // Preferred: quote wrapped in straight or curly quotes. Greedy (.+) so the
    // closing quote is the LAST one on the line, not the first inner quote.
    const m = line.match(/^["“](.+)["”]\s*(.*)$/s)
    if (m) {
      text = m[1]
      author = m[2]
    } else {
      // Fallback: split on the last tab.
      const tab = line.lastIndexOf("\t")
      if (tab !== -1) {
        text = line.slice(0, tab)
        author = line.slice(tab + 1)
      } else {
        text = line
      }
    }

    // Strip leading separator punctuation: hyphen, en/em dash, horizontal bar
    // (U+2015), and whitespace/tabs.
    author = author.replace(/^[-–—―\s]+/, "").trim()
    text = normalize(text).replace(/^["“]|["”]$/g, "")
    // Transliterate to printer-safe ASCII (CP437 thermal printers).
    text = asciiize(text)
    author = asciiize(author)
    // Drop empty or implausibly short fragments (source data has stray junk like
    // a lone "su"). Shortest legitimate quote is ~17 chars, so 10 is safe.
    if (text.length < 10) continue
    // Filter quotes too long to fit on a receipt without truncation, so every
    // quote in rotation prints in full (<= MAX_QUOTE_LEN).
    if (text.length > MAX_QUOTE_LEN) continue
    out.push({ text, author })
  }
  return out
}

/** Parse a "QR ..." link line into { year, author, title, url } or null. */
function parseLink(rest) {
  // rest is everything after the leading "QR".
  const urlMatch = rest.match(/(https?:\/\/\S+)\s*$/)
  if (!urlMatch) return null
  const url = urlMatch[1]
  const meta = rest.slice(0, urlMatch.index).trim()

  // meta:  <year> - <Author> - <Title>   |   <year> - <Title>
  const yearMatch = meta.match(/^(\d{4})\s*-\s*(.*)$/)
  let year = null
  let body = meta
  if (yearMatch) {
    year = Number(yearMatch[1])
    body = yearMatch[2]
  }

  const parts = body.split(/\s+-\s+/)
  let author = ""
  let title = ""
  if (parts.length >= 2) {
    author = parts[0].trim()
    title = parts.slice(1).join(" - ").trim()
  } else {
    title = body.trim()
  }

  // Transliterate display fields to printer-safe ASCII (URL kept verbatim).
  return { year, author: asciiize(author), title: asciiize(title), url }
}

/** Detect a "M/D" day marker at the start of a line; returns {key, restText} or null. */
function parseDayMarker(line) {
  const m = line.match(/^(\d{1,2})\/(\d{1,2})\b\s*(.*)$/)
  if (!m) return null
  const month = String(Number(m[1])).padStart(2, "0")
  const day = String(Number(m[2])).padStart(2, "0")
  return { key: `${month}-${day}`, restText: m[3].trim() }
}

/** Parse a single month file, mutating the shared calendar map. */
function parseMonthFile(raw, calendar) {
  let currentKey = null

  for (const lineRaw of raw.split("\n")) {
    const line = lineRaw.replace(/\s+$/, "")
    if (!line.trim()) continue

    const trimmed = line.trim()

    // QR link line (belongs to the current day).
    if (/^QR\b/.test(trimmed)) {
      if (!currentKey) continue
      const link = parseLink(trimmed.replace(/^QR\b/, "").trim())
      if (link) calendar[currentKey].links.push(link)
      continue
    }

    // New day marker.
    const marker = parseDayMarker(trimmed)
    if (marker) {
      currentKey = marker.key
      if (!calendar[currentKey]) calendar[currentKey] = { events: [], links: [] }
      if (marker.restText) {
        calendar[currentKey].events.push(asciiize(normalize(marker.restText)))
      }
      continue
    }

    // Indented continuation event line (starts with a year).
    if (currentKey && /^\d{4}\b/.test(trimmed)) {
      calendar[currentKey].events.push(asciiize(normalize(trimmed)))
    }
  }
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source not found: ${SOURCE}`)
    console.error("Clone it first:")
    console.error(
      `  git clone https://github.com/pretyflaco/bitcoinCalendar.git ${SOURCE}`,
    )
    process.exit(1)
  }

  // ---- Quotes ----
  const quotes = []
  for (const f of QUOTE_FILES) {
    const raw = readIfExists(path.join(SOURCE, f))
    if (raw) quotes.push(...parseQuotes(raw))
  }

  // Deduplicate quotes by text.
  const seen = new Set()
  const uniqueQuotes = []
  for (const q of quotes) {
    const k = q.text.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    uniqueQuotes.push(q)
  }

  // ---- Calendar ----
  const calendar = {}
  for (const f of MONTH_FILES) {
    const raw = readIfExists(path.join(SOURCE, f))
    if (raw) parseMonthFile(raw, calendar)
  }

  // Sort calendar keys for stable, diff-friendly output.
  const sortedCalendar = {}
  for (const key of Object.keys(calendar).sort()) {
    sortedCalendar[key] = calendar[key]
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUT_DIR, "quotes.json"),
    JSON.stringify(uniqueQuotes, null, 2) + "\n",
  )
  fs.writeFileSync(
    path.join(OUT_DIR, "calendar.json"),
    JSON.stringify(sortedCalendar, null, 2) + "\n",
  )

  const dayCount = Object.keys(sortedCalendar).length
  const linkCount = Object.values(sortedCalendar).reduce((n, d) => n + d.links.length, 0)
  const eventCount = Object.values(sortedCalendar).reduce(
    (n, d) => n + d.events.length,
    0,
  )

  console.log(`Wrote ${uniqueQuotes.length} quotes -> quotes.json`)
  console.log(
    `Wrote ${dayCount} days (${eventCount} events, ${linkCount} links) -> calendar.json`,
  )
}

main()
