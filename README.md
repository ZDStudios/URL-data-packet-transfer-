# URL Stream Proxy

A tiny web dashboard you can deploy to Render. Paste any URL, get back a link on
your own Render domain (`https://your-app.onrender.com/p/<id>/`) that live-streams
the real site through this server.

## What it does

- **Dashboard** at `/` — enter a URL, it creates and lists your proxy links (copy / delete / request counts).
- **Streaming proxy** at `/p/<id>/…` — every request is forwarded to the target and the
  response is piped straight back, chunk by chunk (no buffering for images, video, downloads, SSE).
- **Link rewriting** — HTML and CSS responses have their `href`/`src`/`action`/`srcset`/`url(...)`
  references rewritten so pages, assets and cross-host resources keep flowing through the proxy.
- Redirects are followed through the proxy, cookies are re-scoped, and frame-blocking
  headers (`X-Frame-Options`, CSP) are stripped so the page renders.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Deploy to Render

1. Push this repo to GitHub.
2. On Render: **New → Web Service**, pick the repo. `render.yaml` is included, so
   the blueprint fills everything in. Otherwise set it manually:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
3. Deploy. Open the service URL — that is your dashboard.

No environment variables are required; Render's `PORT` is picked up automatically.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Dashboard |
| `GET` | `/api/links` | List links |
| `POST` | `/api/links` | Create a link — body `{"url": "https://example.com"}` |
| `DELETE` | `/api/links/:id` | Remove a link |
| `ANY` | `/p/:id/*` | The proxied, streamed site |
| `GET` | `/healthz` | Health check |

## Notes

- Links are kept in memory and mirrored to `data/links.json`. Render's free tier has an
  ephemeral filesystem, so links reset on redeploy unless you attach a disk and set `DATA_DIR`.
- WebSockets are not proxied — normal HTTP/streaming responses are.
- Anyone with the generated link can reach the target through your server. Keep the links
  private, and only proxy sites you are allowed to proxy.
