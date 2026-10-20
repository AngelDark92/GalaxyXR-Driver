import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guiArtifacts = path.resolve(__dirname, '../../builds/GalaxyXR-Driver/gui');
const LOCALES = ['en-US', 'zh-Hant', 'ja'];
const envLocale = process.env.LOCALE;
const locale = envLocale && LOCALES.includes(envLocale) ? envLocale : 'en-US';

// Dev-server middleware. The page ALWAYS lives at /<locale>/index.html (the
// Tauri window url is `en-US/index.html` and the release bundle mirrors that
// layout), and it loads its siblings (locale.json + public assets) with
// relative URLs. Vite serves the module graph and public/ at the root, so this
// middleware mirrors the per-locale directory: it serves the entry HTML, the
// generated locale.json, and public assets under each /<locale>/ path so the
// relative URLs resolve exactly as they do in the release bundle.
function localeDevServer(): Plugin {
  return {
    name: 'gx-r-locale-dev-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        const m = pathname.match(/^\/(en-US|zh-Hant|ja)\/(.*)$/);
        if (!m) return next();
        const loc = m[1];
        const rest = m[2];

        if (rest === '' || rest === 'index.html' || rest === 'curve.html') {
          let html = fs.readFileSync(path.join(__dirname, rest === 'curve.html' ? 'curve.html' : 'index.html'), 'utf8');
          // Inject the Vite client so HMR works even though we serve the
          // locale-path HTML directly rather than via Vite's root transform.
          if (!html.includes('/@vite/client')) {
            html = html.replace(/<head>/i, '<head>\n  <script type="module" src="/@vite/client"></script>');
          }
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(html);
          return;
        }

        if (rest === 'locale.json') {
          const p = path.join(guiArtifacts, 'build', 'locale-json', `${loc}.json`);
          if (fs.existsSync(p)) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(fs.readFileSync(p, 'utf8'));
            return;
          }
          res.statusCode = 404;
          res.end('locale.json not found. Run: npm run dev:ui');
          return;
        }

        const pub = path.join(__dirname, 'public', rest);
        if (fs.existsSync(pub) && fs.statSync(pub).isFile()) {
          res.end(fs.readFileSync(pub));
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  base: './',
  root: __dirname,
  cacheDir: path.join(guiArtifacts, 'cache', 'vite'),
  publicDir: path.join(__dirname, 'public'),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.join(guiArtifacts, 'dist', 'fluent', locale),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: { companion: path.join(__dirname, 'index.html'), curve: path.join(__dirname, 'curve.html') },
      // Our page/shell/controls modules and the Fluent element-definition modules
      // only "do" something via custom-element registration (Lit's @customElement
      // and FAST's `Element.define`). Those registrations are side effects that
      // rollup does not detect from the decorator call alone, so a side-effect-only
      // import of such a module is dropped and the element is never defined at
      // runtime. Explicitly mark these modules as having side effects so the
      // registration code is always retained.
      treeshake: {
        moduleSideEffects: (id: string) => {
          if (/[\\/]src-lit[\\/]/.test(id)) return true;
          if (/@fluentui[\\/]web-components[\\/]/.test(id)) return true;
          return false;
        },
      },
    },
  },
  plugins: [localeDevServer()],
});
