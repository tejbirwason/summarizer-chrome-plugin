#!/usr/bin/env node
/**
 * Backfill ~/yt-transcripts into the cloud store.
 *
 * The library's naming is <unix-ts>-<slug>-<videoId>.md, with a sibling .summary.md and
 * .png where those exist, and YAML front matter carrying title/channel/url/fetched.
 *
 * Posters go straight to R2 via `wrangler r2 object put` rather than through the Worker:
 * they run 7.8-14.1 MB each (1.5 GB across 143 files), and there is no reason to stream
 * that through a request body when wrangler can put them directly.
 *
 * Idempotent — /api/import upserts by id, so re-running is safe.
 *
 * Usage: node scripts/backfill.mjs [--limit N] [--no-posters] [--dry]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), 'yt-transcripts');
const BASE = process.env.WORKER_URL || 'https://summarizer.goldenoreo.workers.dev';
const TOKEN = process.env.APP_TOKEN;
const BUCKET = 'summarizer-posters';
const WRANGLER = join(import.meta.dirname, '..', 'node_modules', '.bin', 'wrangler');

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const skipPosters = args.includes('--no-posters');
const dry = args.includes('--dry');

if (!TOKEN) { console.error('APP_TOKEN not set'); process.exit(1); }

/** Parse the YAML front matter block. Only flat scalars — no need for a YAML dep. */
function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(end + 4).trim() };
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.md') && !f.endsWith('.summary.md'))
  .sort();

let ok = 0, skipped = 0, failed = 0, posted = 0;
const errors = [];

for (const f of files.slice(0, limit)) {
  const stem = f.slice(0, -3);
  const m = /^(\d+)-(.*)-([A-Za-z0-9_-]{11})$/.exec(stem);

  const raw = readFileSync(join(DIR, f), 'utf8');
  const { meta, body } = parseFrontMatter(raw);

  // The url in front matter is authoritative; fall back to the id parsed from the filename.
  const videoId = m?.[3] ?? null;
  const url = meta.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
  if (!url || !body.trim()) {
    // No id and no url means nothing can key this row — the "untitled" captures fall here.
    skipped++;
    continue;
  }

  let summary = '';
  try { summary = readFileSync(join(DIR, `${stem}.summary.md`), 'utf8').trim(); } catch {}
  const { body: summaryBody } = summary ? parseFrontMatter(summary) : { body: '' };

  // ts in the filename is a unix seconds stamp; front matter `fetched` is date-only.
  const createdAt = m ? Number(m[1]) * 1000 : statSync(join(DIR, f)).mtimeMs;

  let posterKey = null;
  const png = join(DIR, `${stem}.png`);
  if (!skipPosters) {
    try {
      statSync(png);
      posterKey = `imported/${stem}.png`;
      if (!dry) {
        execFileSync(WRANGLER, ['r2', 'object', 'put', `${BUCKET}/${posterKey}`,
          '--file', png, '--content-type', 'image/png', '--remote'],
          { stdio: 'pipe', env: process.env });
        posted++;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') { errors.push(`${stem}: poster ${String(e.message).slice(0, 90)}`); }
      posterKey = null;
    }
  }

  const payload = {
    url, title: meta.title || stem, channel: meta.channel || '', videoId,
    transcript: body, summary: summaryBody || '', createdAt, posterKey,
  };

  if (dry) {
    console.log(`DRY ${videoId} | poster=${!!posterKey} | sum=${!!summaryBody} | ${(meta.title || stem).slice(0, 55)}`);
    ok++;
    continue;
  }

  try {
    const r = await fetch(`${BASE}/api/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    ok++;
    if (ok % 25 === 0) console.log(`  ${ok}/${files.length} imported (${posted} posters)`);
  } catch (e) {
    failed++;
    errors.push(`${stem}: ${String(e.message).slice(0, 120)}`);
  }
}

console.log(`\nimported=${ok} posters=${posted} skipped=${skipped} failed=${failed}`);
if (errors.length) {
  console.log('\nfirst errors:');
  errors.slice(0, 8).forEach((e) => console.log('  ' + e));
}
