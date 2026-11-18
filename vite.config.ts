import { execFileSync } from 'node:child_process';
import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin } from 'vite';
import { ROOM_SOCKET_PATH } from './shared/net/types.ts';
import pkg from './package.json' with { type: 'json' };

const BASE = '/fatfish-island/';

function preloadGame(): Plugin {
  return {
    name: 'preload-game',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, { chunk, bundle }) {
        if (!chunk || !bundle) return;
        const modules = new Set<string>();
        const wasm = new Set<string>();
        function collect(file: string) {
          const entry = bundle?.[file];
          if (entry?.type !== 'chunk' || modules.has(file)) return;
          modules.add(file);
          entry.imports.forEach(collect);
          for (const asset of entry.viteMetadata?.importedAssets ?? []) {
            if (asset.endsWith('.wasm')) wasm.add(asset);
          }
        }
        chunk.dynamicImports.forEach(collect);
        const preloads: HtmlTagDescriptor[] = Array.from(wasm, (file) => ({
          tag: 'link',
          attrs: { rel: 'preload', as: 'fetch', type: 'application/wasm', crossorigin: true, href: BASE + file },
          injectTo: 'head',
        }));
        for (const file of modules) {
          if (chunk.imports.includes(file)) continue;
          preloads.push({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: BASE + file }, injectTo: 'head' });
        }
        return preloads;
      },
    },
  };
}

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
    base: BASE,
    plugins: [preloadGame()],
    resolve: { alias: { '@dimforge/rapier3d-compat': '@dimforge/rapier3d' } },
    optimizeDeps: { exclude: ['@dimforge/rapier3d'] },
    server: { host, proxy },
    preview: { host, proxy },
    define: {
      __GAME_VERSION__: JSON.stringify(pkg.version),
      __COMMIT_SHA__: JSON.stringify(commitShortHash()),
    },
  };
});
