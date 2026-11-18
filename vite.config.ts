import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

function commitShortHash(): string {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 8);
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'local';
  }
}

export default defineConfig({
  base: '/fatfish-island/',
  define: {
    __GAME_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_SHA__: JSON.stringify(commitShortHash()),
  },
});
