import { execFileSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import { ROOM_SOCKET_PATH } from './shared/net/types.ts';
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

export default defineConfig(({ mode }) => {
  const { PORT = '8797', ROOM_HOST: host = '127.0.0.1' } = loadEnv(mode, process.cwd(), ['PORT', 'ROOM_HOST']);
  const backendHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1'
    : host.includes(':') ? `[${host}]` : host;
  const proxy = { [ROOM_SOCKET_PATH]: { target: `http://${backendHost}:${PORT}`, ws: true } };
  return {
    base: '/fatfish-island/',
    server: { host, proxy },
    preview: { host, proxy },
    define: {
      __GAME_VERSION__: JSON.stringify(pkg.version),
      __COMMIT_SHA__: JSON.stringify(commitShortHash()),
    },
  };
});
