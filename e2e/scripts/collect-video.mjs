/**
 * Turns Playwright's recording into something you can send someone.
 *
 * Playwright writes one `video.webm` per test into `artifacts/`. This picks the
 * newest, converts it to H.264 mp4 (which every mail client, Slack and browser
 * plays without asking), and drops it in `docs/`.
 *
 * Conversion is skipped, with a message rather than a failure, when ffmpeg is
 * absent: the webm is still there and still watchable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = join(here, '..', 'artifacts');
const outDir = join(here, '..', '..', 'docs');
const out = join(outDir, 'ng-bridge-demo.mp4');
// GitHub will not play a repo-relative mp4 inline, so the README embeds a GIF
// of the same recording and links it to the mp4. Both come from one run so
// they cannot drift.
const gif = join(outDir, 'ng-bridge-demo.gif');

function newestVideo(root) {
  if (!existsSync(root)) {
    return undefined;
  }

  const candidates = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const path = join(root, entry.name, 'video.webm');

    if (existsSync(path)) {
      candidates.push({ path, mtime: statSync(path).mtimeMs });
    }
  }

  return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

const source = newestVideo(artifacts);

if (source === undefined) {
  console.error('No video found. Run `pnpm demo` first.');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

try {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      source,
      // `yuv420p` and an even-dimension scale: without both, QuickTime and
      // several browsers refuse the file outright.
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '23',
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: 'inherit' },
  );
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      out,
      '-vf',
      'fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      gif,
    ],
    { stdio: 'inherit' },
  );
  console.log(`\nWrote ${out}\nWrote ${gif}`);
} catch (error) {
  console.warn(
    `Could not convert (${error.message}). The raw recording is at:\n  ${source}`,
  );
}
