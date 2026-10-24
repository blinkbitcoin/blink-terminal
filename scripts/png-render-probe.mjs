/**
 * PNG render probe (blink-wip#1664) — spawned by
 * tests/unit/paycode-png-guard.spec.ts.
 *
 * The production renderer (@react-pdf/renderer -> @react-pdf/image -> png-js
 * / pdfkit) is ESM and cannot load inside jest, so the spec runs this plain
 * Node script with a small heap. Reads { dataUrl, guard } as JSON on stdin:
 *   guard=true:  run lib/pdf/png-guard.js first; print {"guard":"rejected"}
 *                and stop if it refuses the image;
 *   then render a one-page PDF with <Image src={dataUrl}> exactly as
 *   lib/pdf/PaycodePDF.tsx does and print {"rendered":<bytes>}.
 * A heap exhaustion kills the process (non-zero exit / signal).
 */
import { createRequire } from "node:module"

import { Document, Image, Page, renderToBuffer } from "@react-pdf/renderer"
import { createElement } from "react"

const require = createRequire(import.meta.url)
const { checkPngDataUrl } = require("../lib/pdf/png-guard.js")

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const { dataUrl, guard } = JSON.parse(Buffer.concat(chunks).toString("utf8"))

if (guard) {
  const check = checkPngDataUrl(dataUrl)
  if (!check.ok) {
    console.log(JSON.stringify({ guard: "rejected", reason: check.reason }))
    process.exit(0)
  }
}

const h = createElement
const doc = h(
  Document,
  null,
  h(Page, { size: "A4" }, h(Image, { src: dataUrl, style: { width: 200, height: 200 } })),
)
try {
  const pdf = await renderToBuffer(doc)
  console.log(JSON.stringify({ rendered: pdf.length }))
} catch (error) {
  // A clean renderer error is not a crash; report it.
  console.log(JSON.stringify({ renderError: String(error && error.message) }))
}
