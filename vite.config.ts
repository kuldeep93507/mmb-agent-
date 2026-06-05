import path from "path";
import http from "http";
import https from "https";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_VERSION = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")).version as string;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const MORELOGIN_PORT = String(Number.parseInt(env.MORELOGIN_PORT || "40000", 10) || 40000);
  const MORELOGIN_API_KEY_RAW = env.MORELOGIN_API_KEY ?? "";
  const MORELOGIN_API_KEY = String(MORELOGIN_API_KEY_RAW).trim();
  if (!MORELOGIN_API_KEY) {
    // Not a fatal error — key can be set via Settings page after server starts.
    // MoreLogin proxy calls will fail until key is configured, but the app will still load.
    console.warn("[Vite] MORELOGIN_API_KEY not found in .env — MoreLogin proxy disabled until set in Settings.");
  }
  const MORELOGIN_BASE = `http://127.0.0.1:${MORELOGIN_PORT}`;
  const BACKEND_PORT = String(Number.parseInt(env.BACKEND_PORT || "3100", 10) || 3100);
  const backendApiKeyRaw = env.BACKEND_API_KEY || env.MMB_API_TOKEN || env.VITE_BACKEND_API_KEY || "";
  const BACKEND_PROXY_KEY = String(backendApiKeyRaw).trim();
  if (!BACKEND_PROXY_KEY) {
    // BACKEND_API_KEY is required for the dev proxy security layer.
    // Without it, all /backend-api/* requests will be blocked by the server.
    // Add BACKEND_API_KEY=any-random-string to your .env file.
    throw new Error(
      "Missing BACKEND_API_KEY — add BACKEND_API_KEY=your-secret to .env\n" +
      "  (same value must be set in server .env or user-settings.json)\n" +
      "  Example: BACKEND_API_KEY=mmb-local-dev-2025",
    );
  }

  function moreloginRequest(apiPath: string, method: string, body?: string): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(apiPath, MORELOGIN_BASE);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : Number(MORELOGIN_PORT),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: MORELOGIN_API_KEY,
        },
        timeout: 60000,
      };
      if (body) {
        (options.headers as Record<string, string>)["Content-Length"] = Buffer.byteLength(body).toString();
      }

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 200, data });
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      req.on("error", (err) => reject(err));

      if (body) req.write(body);
      req.end();
    });
  }

  return {
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    // Localhost hits backend directly (not /backend-api proxy) — must match server BACKEND_API_KEY
    'import.meta.env.VITE_BACKEND_API_KEY': JSON.stringify(BACKEND_PROXY_KEY),
  },
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile(),
    {
      name: 'dev-api-proxy',
      /** Run early: `/backend-api` + `/morelogin-api` + YouTube proxies before SPA fallback (avoids <!DOCTYPE HTML as “JSON”). */
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (
            !req.url?.startsWith('/morelogin-api') &&
            !req.url?.startsWith('/youtube-feed') &&
            !req.url?.startsWith('/youtube-playlist') &&
            !req.url?.startsWith('/backend-api')
          ) {
            return next();
          }

          // Handle CORS preflight
          if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MMB-Token, x-api-key');
            res.statusCode = 204;
            res.end();
            return;
          }

          // Backend API → Express (profiles + Multilogin/MoreLogin)
          if (req.url?.startsWith('/backend-api')) {
            let body = '';
            req.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            req.on('end', () => {
              const apiPath = req.url!.replace('/backend-api', '') || '/';
              const payload = body || undefined;
              const opts: http.RequestOptions = {
                hostname: '127.0.0.1',
                port: Number(BACKEND_PORT),
                path: apiPath,
                method: req.method || 'GET',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': BACKEND_PROXY_KEY,
                },
                timeout: 120000,
              };
              if (payload)
                (opts.headers as Record<string, string>)['Content-Length'] = Buffer.byteLength(payload).toString();

              const proxyReq = http.request(opts, (proxyRes) => {
                let data = '';
                proxyRes.on('data', (chunk) => {
                  data += chunk;
                });
                proxyRes.on('end', () => {
                  res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
                  res.setHeader('Access-Control-Allow-Origin', '*');
                  res.statusCode = proxyRes.statusCode || 200;
                  res.end(data);
                });
              });
              proxyReq.on('error', (err: Error) => {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 502;
                res.end(JSON.stringify({ code: -1, message: 'Backend not running: ' + err.message, data: null }));
              });
              if (payload) proxyReq.write(payload);
              proxyReq.end();
            });
            return;
          }

          // MoreLogin local HTTP API
          if (req.url?.startsWith('/morelogin-api')) {
            let body = '';
            req.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            req.on('end', async () => {
              const apiPath = req.url!.replace('/morelogin-api', '') || '/';
              try {
                const result = await moreloginRequest(apiPath, req.method || 'POST', body || undefined);
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.statusCode = result.status;
                res.end(result.data);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Unknown';
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 502;
                res.end(JSON.stringify({ code: -1, message: 'Proxy error: ' + msg, data: null }));
              }
            });
            return;
          }

          // YouTube Playlist proxy — fetch all videos from a playlist
          if (req.url?.startsWith('/youtube-playlist')) {
            const urlParams = new URL(req.url, 'http://localhost').searchParams;
            const playlistId = urlParams.get('list');
            if (!playlistId) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'list parameter required' }));
              return;
            }

            const postData = JSON.stringify({
              context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
              browseId: `VL${playlistId}`,
            });

            const ytOpts: https.RequestOptions = {
              hostname: 'www.youtube.com',
              path: '/youtubei/v1/browse?prettyPrint=false',
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData).toString() },
              rejectUnauthorized: false,
            };

            const ytReq = https.request(ytOpts, (ytRes) => {
              let data = '';
              ytRes.on('data', (chunk: string) => { data += chunk; });
              ytRes.on('end', () => {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.statusCode = 200;
                res.end(data);
              });
            });
            ytReq.on('error', (err: any) => {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Playlist fetch failed: ' + err.message }));
            });
            ytReq.write(postData);
            ytReq.end();
            return;
          }

          // YouTube RSS Feed proxy — now uses InnerTube API for ALL videos
          if (req.url?.startsWith('/youtube-feed')) {
            const urlParams = new URL(req.url, 'http://localhost').searchParams;
            const channelId = urlParams.get('channel_id');
            if (!channelId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'channel_id required' }));
              return;
            }
            
            // Use YouTube InnerTube API to get ALL videos
            const postData = JSON.stringify({
              context: {
                client: {
                  clientName: 'WEB',
                  clientVersion: '2.20240101.00.00',
                }
              },
              browseId: channelId,
              params: 'EgZ2aWRlb3PyBgQKAjoA' // Videos tab
            });

            const ytOpts: https.RequestOptions = {
              hostname: 'www.youtube.com',
              path: '/youtubei/v1/browse?prettyPrint=false',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData).toString(),
              },
              rejectUnauthorized: false,
            };

            const ytReq = https.request(ytOpts, (ytRes) => {
              let data = '';
              ytRes.on('data', (chunk: string) => { data += chunk; });
              ytRes.on('end', () => {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.statusCode = 200;
                res.end(data);
              });
            });
            ytReq.on('error', (err: any) => {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'YouTube fetch failed: ' + err.message }));
            });
            ytReq.write(postData);
            ytReq.end();
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5178,
    strictPort: false,   // allow fallback to next available port if 5178 is busy
    host: true,
  },
  preview: {
    port: 4178,
    proxy: {
      '/backend-api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/backend-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('x-api-key', BACKEND_PROXY_KEY);
          });
        },
      },
      '/morelogin-api': {
        target: MORELOGIN_BASE,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/morelogin-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Authorization', MORELOGIN_API_KEY);
            if (!proxyReq.getHeader('content-type')) {
              proxyReq.setHeader('Content-Type', 'application/json');
            }
          });
        },
      },
    },
  },
};
});
