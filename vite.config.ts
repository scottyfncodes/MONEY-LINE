import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MIME: Record<string, string> = {
  '.ogg': 'audio/ogg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
};

/** The project keeps produced assets in /assets (audio, icons, brand, fx). Serve them in dev and copy them into the build. */
function projectAssets(): Plugin {
  const root = join(process.cwd(), 'assets');
  return {
    name: 'money-line-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0])).replace(/^([/\\]|\.\.)+/, '');
        const file = join(root, rel);
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (existsSync(root)) cpSync(root, join(process.cwd(), 'dist', 'assets'), { recursive: true });
    },
  };
}

/**
 * The approved icon set lives in /assets/icons. Its tags are added after Vite's own HTML asset pass, so the links
 * point at those exact files rather than at hashed copies.
 */
function appIcons(): Plugin {
  const tag = (attrs: Record<string, string>, t = 'link') => ({ tag: t, attrs, injectTo: 'head' as const });
  return {
    name: 'money-line-icons',
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        tag({ rel: 'icon', href: '/assets/icons/favicon.ico', sizes: '48x48' }),
        tag({ rel: 'icon', href: '/assets/icons/favicon-32.png', type: 'image/png', sizes: '32x32' }),
        tag({ rel: 'icon', href: '/assets/icons/favicon-16.png', type: 'image/png', sizes: '16x16' }),
        tag({ rel: 'apple-touch-icon', href: '/assets/icons/apple-touch-icon.png', sizes: '180x180' }),
        tag({ rel: 'manifest', href: '/manifest.webmanifest' }),
        tag({ name: 'theme-color', content: '#1f4d3a' }, 'meta'),
        tag({ name: 'apple-mobile-web-app-title', content: 'MONEY LINE' }, 'meta'),
      ],
    },
  };
}

export default defineConfig({
  plugins: [react(), projectAssets(), appIcons()],
  build: { assetsDir: 'bundle', target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as never);
