/**
 * import-review-notes.js — load a team's edit notes from a .docx into page_comments.
 *
 * Meg's team reviewed the answer pages in Word and left notes against passages:
 * some directives ("REMOVE", "Cajun not Creole"), some questions ("this doesn't
 * make sense?", "[???]"). This turns each note into a review comment the
 * director resolves in /review/queue, exactly like a hand-typed one.
 *
 * It does NOT edit any page. Nothing here writes to `pages`.
 *
 * The hard part is deciding where a note ends and the quoted passage begins.
 * Rather than guess from punctuation — the notes are appended in half a dozen
 * different styles — the quote is found by matching against the page itself:
 * the longest prefix of the paragraph that actually appears on a page IS the
 * quote, and whatever is left over is the note. A paragraph that matches
 * nothing is never forced onto a page; it goes to the unmatched report for
 * Rob to place by hand.
 *
 * The document is third-party input. It is read as data: the zip is parsed
 * without extracting to disk, and no text in it is ever executed or treated
 * as an instruction.
 *
 *   node src/import-review-notes.js <file.docx> [--apply]
 *
 * Without --apply it reports what it would do and writes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const REVIEWER = "Meg's Team";
const CONTEXT = 40;          // must match anchor.js in the web repo
const MIN_QUOTE = 55;        // normalised chars before a match is trusted
const MARGIN = 25;           // how much better the winner must be than runner-up

/* ------------------------------------------------------------------ *
 * 1. Reading the .docx
 *
 * A .docx is a zip. Node has no zip reader, but it has raw inflate, and the
 * central directory is simple enough to walk. Nothing is written to disk, so
 * a hostile archive has no path to traverse to and no symlink to follow.
 * ------------------------------------------------------------------ */

function readZipMember(buf, wanted) {
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      // Re-read the lengths from the local header; the central copy can differ.
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('corrupt local header');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found in archive`);
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/** Paragraphs, each with its runs and whether they were highlighted. */
function docxParagraphs(file) {
  const xml = readZipMember(fs.readFileSync(file), 'word/document.xml').toString('utf8');
  const body = xml.slice(xml.indexOf('<w:body'), xml.lastIndexOf('</w:body>'));
  const out = [];

  for (const pm of body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const chunk = pm[0];
    const runs = [];
    for (const rm of chunk.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
      const r = rm[0];
      const props = r.slice(0, r.indexOf('</w:rPr>') + 1);
      const hl = /<w:highlight w:val="(?!none)/.test(props);
      const bold = /<w:b\/>|<w:b [^>]*\/>/.test(props);
      const under = /<w:u [^>]*w:val="(?!none)/.test(props);
      let text = '';
      for (const tm of r.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)) text += unescapeXml(tm[1]);
      if (/<w:tab\/>/.test(r)) text += ' ';
      if (text) runs.push({ text, hl, bold, under });
    }
    const text = runs.map((r) => r.text).join('');
    if (text.trim()) out.push({ text, runs, underlined: underlinedSpans(runs) });
  }
  return out;
}

/**
 * Contiguous underlined regions, as offsets into the paragraph text.
 *
 * Several notes say only "Remove underlined". The underline is the whole
 * instruction — without it the comment would point at a paragraph and not say
 * which part to cut — so those spans become the quoted text.
 */
function underlinedSpans(runs) {
  const spans = [];
  let at = 0, open = null;
  for (const r of runs) {
    if (r.under && open === null) open = at;
    if (!r.under && open !== null) { spans.push({ start: open, end: at }); open = null; }
    at += r.text.length;
  }
  if (open !== null) spans.push({ start: open, end: at });
  return spans;
}

/* ------------------------------------------------------------------ *
 * 2. Rendering a page the way the review UI does
 *
 * These mirror toBlocks() and stripCta() in the web repo. The anchors written
 * here have to resolve against what /review renders, so if those change, this
 * has to change with them.
 * ------------------------------------------------------------------ */

const stripCta = (md) => String(md || '').replace(/\{\{CTA_RFP\}\}/g, '').trim();

function toBlocks(md) {
  if (!md) return [];
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ type: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of String(md).replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); out.push({ type: 'h', level: h[1].length, text: h[2] }); continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { flush(); out.push({ type: 'li', text: li[1] }); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}

/** The paragraph texts /review shows, per anchorable field. */
function renderFields(page) {
  return {
    direct_answer: page.direct_answer ? [page.direct_answer] : [],
    body_md: toBlocks(stripCta(page.body_md)).map((b) => b.text)
  };
}

/* ------------------------------------------------------------------ *
 * 3. Normalising for comparison
 *
 * Word rewrites straight quotes as curly ones and hyphens as dashes, so the
 * doc's copy of a sentence is rarely byte-identical to the page's. Compare on
 * a flattened form, but keep an index map so the span can be recovered
 * exactly as the page stores it — the comment must quote the page, not Word.
 * ------------------------------------------------------------------ */

// Citation markers the pages carry and Word's copy sometimes drops: "[e3]", "[e11, e12]".
const CITATION = /^\[e\d+(?:\s*,\s*e?\d+)*\]/;

function normalizeWithMap(s) {
  let out = '';
  const map = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];

    // Emphasis markers and citation tokens are in the stored markdown but not in
    // what the team read. Dropping both from each side keeps them aligned; the
    // index map still points back into the untouched original.
    if (c === '*' || c === '`' || c === '_') continue;
    if (c === '[') {
      const m = s.slice(i).match(CITATION);
      if (m) { i += m[0].length - 1; space = true; continue; }
    }

    if (/\s/.test(c)) { space = true; continue; }
    if (space && out) { out += ' '; map.push(i); }
    space = false;
    if ('‘’‛′'.includes(c)) c = "'";
    else if ('“”‟″'.includes(c)) c = '"';
    else if ('‐‑‒–—―−'.includes(c)) c = '-';
    else if (c === ' ') c = ' ';
    else c = c.toLowerCase();
    out += c;
    map.push(i);
  }
  return { norm: out, map };
}

const normalize = (s) => normalizeWithMap(s).norm;

/**
 * The longest prefix of `needle` that occurs anywhere in `hay`, both already
 * normalised. Monotone, so binary search is safe: if a prefix of length L
 * occurs, every shorter prefix occurs too.
 */
function longestPrefixMatch(hayNorm, needleNorm) {
  if (!hayNorm || !needleNorm) return { len: 0, at: -1 };
  if (hayNorm.indexOf(needleNorm[0]) === -1) return { len: 0, at: -1 };
  let lo = 1, hi = needleNorm.length, best = 0, bestAt = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = hayNorm.indexOf(needleNorm.slice(0, mid));
    if (at !== -1) { best = mid; bestAt = at; lo = mid + 1; } else { hi = mid - 1; }
  }
  return { len: best, at: bestAt };
}

/* ------------------------------------------------------------------ *
 * 4. Placing a paragraph on a page
 * ------------------------------------------------------------------ */

/** Pull a match back to the last word boundary so a quote never ends mid-word. */
function trimToWord(needleNorm, len) {
  if (len >= needleNorm.length) return len;
  while (len > 0 && !/\s/.test(needleNorm[len])) len--;
  return len;
}

function bestPlacement(paraText, pages) {
  const needle = normalizeWithMap(paraText);
  const results = [];

  for (const page of pages) {
    const fields = renderFields(page);
    let bestForPage = null;
    for (const [field, texts] of Object.entries(fields)) {
      texts.forEach((text, paraIndex) => {
        const hay = normalizeWithMap(text);
        const { len, at } = longestPrefixMatch(hay.norm, needle.norm);
        const useLen = trimToWord(needle.norm, len);
        if (useLen < MIN_QUOTE) return;
        if (!bestForPage || useLen > bestForPage.len) {
          bestForPage = { page, field, paraIndex, len: useLen, at, hay, text };
        }
      });
    }
    if (bestForPage) results.push(bestForPage);
  }

  results.sort((a, b) => b.len - a.len);
  if (!results.length) return null;

  const win = results[0];
  const runnerUp = results[1];
  // A near-tie means the sentence is boilerplate shared across pages. Refuse it
  // rather than pin a note to whichever page happened to sort first.
  const ambiguous = runnerUp && win.len - runnerUp.len < MARGIN;

  // Recover the exact span as the PAGE stores it.
  const startNorm = win.at;
  const endNorm = win.at + win.len;
  const start = win.hay.map[startNorm];
  const end = win.hay.map[endNorm - 1] + 1;
  const quote = win.text.slice(start, end);

  // Whatever of the paragraph was not matched is the team's note.
  const leftoverNorm = needle.norm.slice(win.len);
  const leftoverStart = win.len < needle.map.length ? needle.map[win.len] : paraText.length;
  const leftover = leftoverNorm.trim() ? paraText.slice(leftoverStart).trim() : '';

  return {
    page: win.page,
    field: win.field,
    paraIndex: win.paraIndex,
    paragraph: win.text,
    start,
    end,
    quote,
    leftover,
    matchLen: win.len,
    ambiguous,
    runnerUp: runnerUp ? { slug: runnerUp.page.slug, len: runnerUp.len } : null
  };
}

/** Is this sentence somewhere in the page's FAQ? Reported, never anchored. */
function faqHit(paraText, pages) {
  const needle = normalize(paraText);
  if (needle.length < MIN_QUOTE) return null;
  for (const page of pages) {
    for (const item of page.faq || []) {
      const hay = normalize(`${item.q || ''} ${item.a || ''}`);
      const { len } = longestPrefixMatch(hay, needle);
      if (len >= MIN_QUOTE) return { slug: page.slug, len };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 5. Classifying the document
 * ------------------------------------------------------------------ */

const THEMES = ['Excursions', 'Parades & Permits', 'Special Events', 'Teambuilding/CSR', 'Transportation'];

// "Special Events - 37 stories - Lets spilt this one up" — who reviews what.
const ASSIGNMENT = /^[\w\s&/]+ - \d+ [Ss]tor(y|ies) - /;

// Loose structural labels: "Article 3", "Page #22", "Paragraph #1 & 2", "Question #3".
const LABEL = /^(?:#?\d+\s*[-–]\s*)?(?:excursions:\s*)?(?:article|page|paragraph|question)s?\b[\s#]*[\d\s&,#-]*$/i;

/**
 * A quote is often introduced in place: "Paragraph #6- One property's second
 * floor...". The label is structure, not part of the passage, and leaving it on
 * the front stops the passage matching at character one.
 */
const LABEL_PREFIX = /^(?:paragraph|page|question)s?\s*#?\s*\d+(?:\s*[&,]\s*#?\d+)*\s*[-–—:]\s*/i;

// "#10 Under Questions we are asked:" — a pointer to a FAQ entry, not a note.
const FAQ_POINTER = /^#?\d+\s*[-–]?\s*under questions we are asked:?\s*$/i;

const DELETION = [
  /\bremove\b/i, /^not relevant/i, /not true for our industry/i,
  /should probably be removed/i, /^delete\b/i
];

const isDeletion = (note) => DELETION.some((re) => re.test(note));

/**
 * Does this read as the team talking, rather than as more of the page?
 *
 * This is the guard that stops a page heading on the next line, or the tail of
 * a sentence the matcher gave up on, from being imported as if it were a note.
 * A leftover that does not look like commentary is treated as no note at all.
 */
const NOTE_SIGNALS = [
  /\bremove\b/i, /\breword\b/i, /\brevise\b/i, /\brewritten\b/i, /\bdelete\b/i,
  /check accuracy/i, /fact.?check/i, /not true/i, /not relevant/i, /not sure/i,
  /doesn'?t make sense/i, /don'?t think this is correct/i, /\binaccurate\b/i,
  /sounds weird/i, /sounds out of sorts/i, /feels off/i, /should probably/i,
  /what are these/i, /\?\?\?/, /our (industry|business)/i,
  /we (do not|don'?t|want them|are those|will be)/i,
  /maybe change/i, /change to/i, /pricing (is listed|needs to be removed)/i,
  /needs to be/i, /there is no where/i, /only refer/i, /appear at the end/i,
  /all paragraphs end/i, /^none!?$/i
];

/**
 * Is this line the page talking rather than the team?
 *
 * Titles and short headings are not in the anchorable fields, so they never
 * "place" and would otherwise be swept up as notes — a page title that happens
 * to end in a question mark reads exactly like a question to Rob. Checking the
 * title and the raw markdown as well keeps structure out of the comments.
 */
function isPageText(text, pages) {
  const n = normalize(text);
  if (n.length < 16) return false;
  for (const page of pages) {
    const hays = [page.title, page.direct_answer, page.body_md,
      ...(page.faq || []).map((f) => `${f.q || ''} ${f.a || ''}`)];
    for (const hay of hays) {
      if (!hay) continue;
      const { len } = longestPrefixMatch(normalize(hay), n);
      if (len / n.length > 0.85) return true;
    }
  }
  return false;
}

/**
 * Drop any leading page text from a leftover.
 *
 * The matcher stops wherever the two copies diverge, which can leave real page
 * prose sitting in front of the actual note — often because the sentence
 * continues into the FAQ, which is not an anchorable field. Cut whatever still
 * reads as the page, and keep only what does not. Evidence decides where the
 * note starts, not punctuation.
 */
function stripPageTail(leftover, page) {
  const n = normalizeWithMap(leftover);
  if (!n.norm) return leftover;
  const hays = [
    normalize(page.body_md || ''),
    normalize(page.direct_answer || ''),
    ...(page.faq || []).map((f) => normalize(`${f.q || ''} ${f.a || ''}`))
  ];
  let cut = 0;
  for (const hay of hays) {
    const { len } = longestPrefixMatch(hay, n.norm);
    const l = trimToWord(n.norm, len);
    if (l > cut) cut = l;
  }
  if (cut < 25) return leftover;
  return leftover.slice(cut < n.map.length ? n.map[cut] : leftover.length).trim();
}

function looksLikeNote(text) {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  if (/^\(.*\)$/s.test(t)) return true;              // wholly parenthetical
  if (/\?\s*$/.test(t) && t.length < 200) return true; // a question to Rob
  return NOTE_SIGNALS.some((re) => re.test(t));
}

/** Strip a leading separator left over from "... quoted text – note". */
const cleanNote = (s) => s
  .replace(/^[\s–—\-:;,.()\[\]]*/, '')
  .replace(/[\s]*$/, '')
  .replace(/^\)\s*/, '')
  .trim();

/**
 * "Remove underlined" means a specific span, not the paragraph it sits in.
 * Where the note says so and the paragraph carries underlining, emit one note
 * per underlined region so the director sees exactly what to cut. Otherwise
 * the note stands as it is.
 */
function splitByUnderline(note, para) {
  if (!/underlin/i.test(note.note)) return [note];
  const spans = (para.underlined || []).filter((s) => para.text.slice(s.start, s.end).trim().length > 8);
  if (!spans.length) return [note];

  const out = [];
  for (const span of spans) {
    const wanted = para.text.slice(span.start, span.end).trim();
    // Find that span inside the page paragraph, not the Word copy of it.
    const hay = normalizeWithMap(note.paragraph);
    const needle = normalizeWithMap(wanted);
    const at = hay.norm.indexOf(needle.norm);
    if (at === -1 || needle.norm.length < 12) continue;
    const start = hay.map[at];
    const end = hay.map[at + needle.norm.length - 1] + 1;
    out.push({ ...note, start, end, quote: note.paragraph.slice(start, end) });
  }
  return out.length ? out : [note];
}

/**
 * When a passage matches nothing verbatim, say why usefully.
 *
 * A passage whose words are all on one page but whose sentence is not has not
 * gone missing — the page was reworded after the team read it. Telling Rob
 * "not found" would send him hunting for a passage that is really a stale
 * quote, so name the page it drifted from instead.
 */
function closestByWords(text, pages) {
  const words = new Set(normalize(text).split(' ').filter((w) => w.length > 4));
  if (words.size < 6) return null;
  let best = { ratio: 0, slug: '' };
  for (const page of pages) {
    const have = new Set(normalize(`${page.direct_answer || ''} ${page.body_md || ''}`)
      .split(' ').filter((w) => w.length > 4));
    let hit = 0;
    for (const w of words) if (have.has(w)) hit++;
    const ratio = hit / words.size;
    if (ratio > best.ratio) best = { ratio, slug: page.slug };
  }
  return best.ratio >= 0.9 ? best : null;
}

/** A plain-English reason a passage could not be placed. */
function whyUnplaced(text, pages, placed) {
  if (placed?.ambiguous) {
    return `ambiguous — matched ${placed.page.slug} (${placed.matchLen}) and `
      + `${placed.runnerUp.slug} (${placed.runnerUp.len}) too closely`;
  }
  const faq = faqHit(text, pages);
  if (faq) return `passage is in the FAQ of ${faq.slug} — /review cannot anchor FAQ text`;
  const near = closestByWords(text, pages);
  if (near) {
    return `wording no longer matches — every word is on ${near.slug} `
      + `(${Math.round(near.ratio * 100)}%) but the sentence is not, so that page was `
      + 'reworded after the team reviewed it';
  }
  return 'passage not found on any page';
}

function parseDocument(paras, pages) {
  const notes = [];
  const unmatched = [];
  let theme = '';
  let label = '';
  let pendingNote = '';        // a note written on a label line, before its quote
  let lastMatched = null;      // so a note on the following line can attach

  for (let i = 0; i < paras.length; i++) {
    const text = paras[i].text.trim();
    if (!text) continue;

    if (ASSIGNMENT.test(text)) continue;               // the who-reviews-what block

    const themeHit = THEMES.find((t) => text.startsWith(t));
    const looksLikeLabel = LABEL.test(text) || (themeHit && text.length < 60);

    if (looksLikeLabel) {
      if (themeHit) theme = themeHit;
      label = text;
      pendingNote = '';
      lastMatched = null;
      continue;
    }
    if (themeHit && text.length < 90) { theme = themeHit; label = text; continue; }

    // A label line that also carries a note: "#14 - Practical Realities - not sure if..."
    const labelPlusNote = text.match(/^(#\d+\s*[-–]\s*[^-–]{3,60}?)\s*[-–]\s*(.{4,})$/);

    if (FAQ_POINTER.test(text)) { label = text; lastMatched = null; continue; }

    // Strip a leading structural label so the passage can match from its start.
    const bare = text.replace(LABEL_PREFIX, '');
    if (bare !== text) label = text.slice(0, text.length - bare.length).trim();

    const placed = bestPlacement(bare, pages);

    if (placed && !placed.ambiguous) {
      // Only take the leftover as a note if it reads like one. Anything else is
      // the tail of a sentence the matcher stopped short on, not commentary.
      const leftover = cleanNote(stripPageTail(placed.leftover, placed.page));
      const note = looksLikeNote(leftover) ? leftover : (looksLikeNote(pendingNote) ? cleanNote(pendingNote) : '');
      pendingNote = '';
      if (note) {
        for (const one of splitByUnderline({ theme, label, ...placed, note }, paras[i])) notes.push(one);
        lastMatched = null;
      } else {
        // A quote with no note yet — the note may be on the next line.
        lastMatched = { theme, label, ...placed };
      }
      continue;
    }

    // Did not place. Either a note for the quote above, a note waiting for the
    // quote below, or something that needs a human.

    // A label line carrying its own note — "#19 - Practical Realities - pricing
    // is listed again" — belongs to the quote that FOLLOWS it, so it must be
    // tested before the note-for-the-quote-above rule or it attaches backwards.
    if (labelPlusNote && looksLikeNote(labelPlusNote[2])) {
      label = labelPlusNote[1].trim();
      pendingNote = labelPlusNote[2].trim();
      lastMatched = null;
      continue;
    }

    // A title or heading is structure, not commentary.
    if (isPageText(text, pages)) { label = text; lastMatched = null; continue; }

    if (lastMatched && looksLikeNote(text)) {
      notes.push({ ...lastMatched, note: cleanNote(stripPageTail(text, lastMatched.page)) });
      lastMatched = null;
      continue;
    }

    unmatched.push({
      theme,
      label,
      quote: text.slice(0, 200),
      note: placed ? cleanNote(placed.leftover) : '',
      why: whyUnplaced(text, pages, placed),
      index: i
    });
  }
  return { notes, unmatched };
}

/* ------------------------------------------------------------------ *
 * 6. Main
 * ------------------------------------------------------------------ */

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('usage: node src/import-review-notes.js <file.docx> [--apply]');
    process.exit(1);
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: pages, error: pErr } = await db
    .from('pages').select('id, slug, title, direct_answer, body_md, faq');
  if (pErr) { console.error('cannot read pages:', pErr.message); process.exit(1); }

  const paras = docxParagraphs(file);
  const { notes, unmatched } = parseDocument(paras, pages);

  // Idempotency: a note already imported is skipped, not duplicated.
  const { data: existing, error: cErr } = await db
    .from('page_comments').select('slug, selected_text, comment_body');
  if (cErr) { console.error('cannot read page_comments:', cErr.message); process.exit(1); }
  const seen = new Set((existing || []).map(
    (c) => `${c.slug} ${normalize(c.selected_text)} ${normalize(c.comment_body || '')}`
  ));

  const rows = [];
  let duplicates = 0;
  for (const n of notes) {
    const key = `${n.page.slug} ${normalize(n.quote)} ${normalize(n.note)}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    rows.push({
      page_id: n.page.id,
      slug: n.page.slug,
      reviewer_name: REVIEWER,
      selected_text: n.quote,
      anchor: {
        field: n.field,
        paraIndex: n.paraIndex,
        start: n.start,
        end: n.end,
        quote: n.quote,
        prefix: n.paragraph.slice(Math.max(0, n.start - CONTEXT), n.start),
        suffix: n.paragraph.slice(n.end, n.end + CONTEXT)
      },
      comment_body: n.note,
      flag_delete: isDeletion(n.note),
      status: 'open'
    });
  }

  /* ---------- verify every anchor before trusting it ----------
   * The anchor is only useful if /review can re-find it. Check the invariant
   * the UI relies on: the paragraph at that index, sliced by those offsets, is
   * exactly the quoted text. A row that fails this would render as an
   * unanchored comment, so it is dropped rather than shipped broken.
   */
  const verified = [];
  const broken = [];
  for (const r of rows) {
    const page = pages.find((x) => x.id === r.page_id);
    const paras2 = renderFields(page)[r.anchor.field] || [];
    const para = paras2[r.anchor.paraIndex];
    const slice = typeof para === 'string' ? para.slice(r.anchor.start, r.anchor.end) : null;
    if (slice === r.selected_text && r.selected_text.trim()) verified.push(r);
    else broken.push({ slug: r.slug, want: r.selected_text.slice(0, 60), got: (slice || '(no paragraph)').slice(0, 60) });
  }
  if (broken.length) {
    console.log(`ANCHORS THAT DO NOT RESOLVE (${broken.length}) — dropped, not inserted:`);
    for (const b of broken) console.log(`  ${b.slug}
    want ${JSON.stringify(b.want)}
    got  ${JSON.stringify(b.got)}`);
    console.log();
  }
  rows.length = 0;
  rows.push(...verified);

  /* ---------- report ---------- */
  const byPage = {};
  for (const r of rows) (byPage[r.slug] ||= []).push(r);

  console.log(`paragraphs read      ${paras.length}`);
  console.log(`notes parsed         ${notes.length + unmatched.length}`);
  console.log(`matched to a page    ${notes.length}`);
  console.log(`already imported     ${duplicates}`);
  console.log(`to insert            ${rows.length}`);
  console.log(`flagged for deletion ${rows.filter((r) => r.flag_delete).length}`);
  console.log(`anchors verified     ${rows.length}`);
console.log(`unmatched            ${unmatched.length}`);
  console.log();
  console.log('--- by page ---');
  for (const [slug, rs] of Object.entries(byPage).sort()) {
    console.log(`  ${rs.length.toString().padStart(2)}  ${slug}`);
    for (const r of rs) {
      console.log(`      ${r.flag_delete ? '[del] ' : '      '}"${r.selected_text.slice(0, 58)}..."`);
      console.log(`            -> ${r.comment_body.slice(0, 80)}`);
    }
  }

  const reportPath = path.join(process.cwd(), 'import-unmatched.md');
  const lines = ['# Unmatched review notes', '',
    'These could not be placed on a page with confidence. Nothing was inserted for them.', ''];
  for (const u of unmatched) {
    lines.push(`## ${u.theme || '(no theme)'} — ${u.label || '(no label)'} (doc paragraph ${u.index})`);
    lines.push(`- **why:** ${u.why}`);
    if (u.quote) lines.push(`- **passage:** ${u.quote.replace(/\n/g, ' ')}`);
    if (u.note) lines.push(`- **note:** ${u.note.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\nunmatched report written to ${reportPath}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to insert.');
    return;
  }

  if (!rows.length) { console.log('\nNothing to insert.'); return; }
  const { error: iErr } = await db.from('page_comments').insert(rows);
  if (iErr) { console.error('insert failed:', iErr.message); process.exit(1); }
  console.log(`\ninserted ${rows.length} comments as "${REVIEWER}", all status=open.`);
  console.log('No page content was modified.');
}

main().catch((e) => { console.error(e); process.exit(1); });
