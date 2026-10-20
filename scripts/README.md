# Path place remapping

Path files in `content/paths/` name each stop by FairData place UUID. If the
FairData project is cleared and reloaded, every place gets a new UUID and the
stops stop resolving. Each place keeps its nodegoat Object ID in the
"Nodegoat ID" field, so `remap-path-places.mjs` uses that ID to find each
place's new UUID and rewrite the path files.

The script only reads from FairData. It needs Node 18 or later and no packages.
These files sit outside `content/`, so the site build and TinaCMS do not read them.

## Steps

1. Before the reload, capture the current UUIDs and their nodegoat IDs:

   ```
   node scripts/remap-path-places.mjs capture --project 245 --out path-places-snapshot.json
   ```

2. Reload the project.

3. Check what would change, then rewrite the path files:

   ```
   node scripts/remap-path-places.mjs apply --project 245 --snapshot path-places-snapshot.json --dry-run
   node scripts/remap-path-places.mjs apply --project 245 --snapshot path-places-snapshot.json
   ```

`apply` lists every stop it could not map (the place is missing from the
reloaded project, or its nodegoat ID matches more than one place) and exits
with a non-zero status. It leaves those stops unchanged.

Other options: `--api <url>` (default is the staging FairData), `--paths <dir>`,
and `--new-mapping <file>` (a JSON file of nodegoat ID to UUID, used instead of
reading the project, for testing). The snapshot file is a working file; do not
commit it.
