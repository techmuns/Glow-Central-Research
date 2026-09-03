// scripts/lib/glowdata.mjs — read the generated arrays out of a GlowVentures checkout. GLOW-OWNED.
//
// techmuns/GlowVentures bakes the family's consolidated book into `src/data/glowData.ts` (`npm run
// build-book` there). That file is TypeScript, generated, and every top-level export is a JSON
// literal with a type annotation in front:
//
//   export const BOOK_POSITIONS: Position[] = [ … ];
//   export const BOOK_SUMMARY: BookSummary = { … };
//   export const BOOK_AS_OF = "2026-08-13";
//
// So the reader below is a bracket matcher and JSON.parse, nothing more — no TypeScript, no npm
// dependency, exactly as CLAUDE.md's hard rule 2 requires of everything under scripts/. It is
// shared by build-book.mjs (the book) and build-managers.mjs (the family's managers) so the two
// files can never disagree about how the upstream is read.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/** Open a checkout. Returns readers over its generated book. */
export function openGlowData(srcDir) {
  const src = readFileSync(join(srcDir, 'src/data/glowData.ts'), 'utf8');

  /** A generated `export const NAME: T = <literal>;` — the literal is JSON. */
  function literal(name, open, close) {
    const key = `export const ${name}`;
    const at = src.indexOf(key);
    if (at < 0) throw new Error(`glowData.ts has no ${name}`);
    const start = src.indexOf(`= ${open}`, at) + 2;
    let depth = 0;
    let i = start;
    let inStr = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    return JSON.parse(src.slice(start, i + 1));
  }

  return {
    /** `export const NAME: T[] = [ … ]` */
    arr: (name) => literal(name, '[', ']'),
    /** `export const NAME: T = { … }` */
    obj: (name) => literal(name, '{', '}'),
    /** `export const NAME = "…"`, or null when the file has no such string. */
    str: (name) => {
      const m = src.match(new RegExp(`export const ${name} = "([^"]+)"`));
      return m ? m[1] : null;
    },
    has: (name) => src.includes(`export const ${name}`),
    /** The checkout's commit, or null when the directory is not a git checkout. */
    commit: () => {
      try {
        return execSync('git rev-parse --short HEAD', { cwd: srcDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch {
        return null;
      }
    },
  };
}
