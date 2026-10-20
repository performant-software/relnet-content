#!/usr/bin/env node
// Keeps path stops pointing at the right places after a FairData project is
// cleared and reloaded. Path files name each stop by FairData place UUID; a
// reload gives every place a new UUID. Each place keeps its nodegoat Object ID
// (the "Nodegoat ID" user-defined field), so this script:
//
//   capture  reads the UUIDs used in content/paths/*.mdx, looks up each place's
//            nodegoat ID, and writes a JSON snapshot (run BEFORE the reload).
//   apply    reads the snapshot, finds each nodegoat ID's new UUID in the
//            reloaded project, and rewrites the path files (run AFTER).
//
// The script only reads from FairData. Requires Node 18 or later; no packages.
// See scripts/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://fairdata.staging.performant.studio';
const KEY_LABEL = 'Nodegoat ID';
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// A path stop's place UUID: a "uuid:" line (optionally quoted).
const STOP_RE = new RegExp(`^(\\s*uuid:\\s*['"]?)(${UUID_RE})(['"]?\\s*)$`, 'gmi');
const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node scripts/remap-path-places.mjs capture --project <id> [--out snapshot.json]
  node scripts/remap-path-places.mjs apply   --project <id> --snapshot snapshot.json [--dry-run]

Options:
  --project <id>        FairData project id (required)
  --api <url>           FairData base URL (default ${DEFAULT_API})
  --paths <dir>         Folder of path files (default content/paths in this repo)
  --out <file>          capture: snapshot file to write (default path-places-snapshot.json)
  --snapshot <file>     apply: snapshot written by capture
  --new-mapping <file>  apply: JSON of { "<nodegoat id>": "<uuid>" } to use instead of
                        reading the project (for testing)
  --dry-run             apply: report what would change; write nothing`;

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode, flags: {} };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error(`Unexpected argument: ${rest[i]}`);
    const name = rest[i].slice(2);
    if (name === 'dry-run') opts.flags[name] = true;
    else opts.flags[name] = rest[++i];
  }
  return opts;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

const keyOf = (place) =>
  Object.values(place.user_defined || {}).find((f) => f.label === KEY_LABEL)?.value || null;

function pathFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.mdx')).sort().map((f) => path.join(dir, f));
}

function stopsIn(text) {
  return [...text.matchAll(STOP_RE)].map((m) => m[2].toLowerCase());
}

async function capture({ api, project, dir, out }) {
  const places = {};
  const problems = [];
  for (const file of pathFiles(dir)) {
    for (const uuid of stopsIn(fs.readFileSync(file, 'utf8'))) {
      if (places[uuid]) continue;
      try {
        const { place } = await getJson(`${api}/core_data/public/v1/places/${uuid}?project_ids=${project}`);
        const key = keyOf(place);
        if (!key) problems.push(`${path.basename(file)}: ${uuid} (${place.name}) has no ${KEY_LABEL}`);
        places[uuid] = { key, name: place.name };
      } catch (e) {
        places[uuid] = { key: null, name: null };
        problems.push(`${path.basename(file)}: ${uuid} could not be read (${e.message})`);
      }
    }
  }
  const snapshot = { capturedAt: new Date().toISOString(), api, project: Number(project), keyField: KEY_LABEL, places };
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Captured ${Object.keys(places).length} places from ${pathFiles(dir).length} path files -> ${out}`);
  problems.forEach((p) => console.log(`  PROBLEM ${p}`));
  process.exitCode = problems.length ? 1 : 0;
}

async function loadKeyToUuid(api, project) {
  const map = {};
  const duplicates = new Set();
  for (let page = 1, pages = 1; page <= pages; page++) {
    const data = await getJson(`${api}/core_data/public/v1/places?project_ids=${project}&per_page=50&page=${page}`);
    pages = data.list.pages;
    for (const place of data.places) {
      const key = keyOf(place);
      if (!key) continue;
      if (map[key] && map[key] !== place.uuid) duplicates.add(key);
      map[key] = place.uuid;
    }
  }
  return { map, duplicates };
}

async function apply({ api, project, dir, snapshotFile, dryRun, newMappingFile }) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  let keyToUuid, duplicates = new Set();
  if (newMappingFile) keyToUuid = JSON.parse(fs.readFileSync(newMappingFile, 'utf8'));
  else ({ map: keyToUuid, duplicates } = await loadKeyToUuid(api, project));

  const problems = [];
  let changed = 0, same = 0, filesChanged = 0;
  for (const file of pathFiles(dir)) {
    const name = path.basename(file);
    const text = fs.readFileSync(file, 'utf8');
    const next = text.replace(STOP_RE, (line, pre, uuid, post) => {
      const old = snapshot.places[uuid.toLowerCase()];
      if (!old || !old.key) { problems.push(`${name}: ${uuid} is not in the snapshot or has no key`); return line; }
      if (duplicates.has(old.key)) { problems.push(`${name}: ${old.name} (${old.key}) matches more than one place in the project`); return line; }
      const fresh = keyToUuid[old.key];
      if (!fresh) { problems.push(`${name}: ${old.name} (${old.key}) not found in the project`); return line; }
      if (fresh.toLowerCase() === uuid.toLowerCase()) { same++; return line; }
      changed++;
      console.log(`  ${name}: ${old.name}  ${uuid} -> ${fresh}`);
      return pre + fresh + post;
    });
    if (next !== text) {
      filesChanged++;
      if (!dryRun) fs.writeFileSync(file, next);
    }
  }
  console.log(`${dryRun ? '[dry run] ' : ''}${changed} stops remapped in ${filesChanged} files, ${same} already correct, ${problems.length} unmapped.`);
  problems.forEach((p) => console.log(`  UNMAPPED ${p}`));
  process.exitCode = problems.length ? 1 : 0;
}

async function main() {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  if (!['capture', 'apply'].includes(mode) || !flags.project) { console.error(USAGE); process.exit(2); }
  const base = {
    api: (flags.api || DEFAULT_API).replace(/\/$/, ''),
    project: flags.project,
    dir: path.resolve(flags.paths || path.join(here, '..', 'content', 'paths')),
  };
  if (mode === 'capture') return capture({ ...base, out: flags.out || 'path-places-snapshot.json' });
  if (!flags.snapshot) { console.error(USAGE); process.exit(2); }
  return apply({ ...base, snapshotFile: flags.snapshot, dryRun: !!flags['dry-run'], newMappingFile: flags['new-mapping'] });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
