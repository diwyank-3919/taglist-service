# Taglist Extraction Service

Tiny Express + Puppeteer service that loads a page in a real (headless) browser,
waits for JS to render, and returns the text/HTML of any element you point it at —
e.g. `#taglist` ("555-605 (Medium) | Assumption | Kaplan").

## 0. Push to GitHub

From this folder:

```bash
git init
git add .
git commit -m "Initial commit: taglist extraction service"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Once pushed, the included GitHub Actions workflow (`.github/workflows/docker-publish.yml`)
automatically builds a Docker image and publishes it to GitHub Container Registry (GHCR)
on every push to `main`. The image will be available at:

```
ghcr.io/<your-username>/<your-repo>:main
```

(Make sure the package visibility is set to **Public** under your repo's
**Packages** tab if you want to pull it without authentication, or use a
`GITHUB_TOKEN`/PAT if private.)

## 1. Run it

### Option A — Pull the published image (after pushing to GitHub)

```bash
docker run -d \
  --name taglist-service \
  -p 3000:3000 \
  --shm-size=1gb \
  --restart unless-stopped \
  ghcr.io/<your-username>/<your-repo>:main
```

### Option B — Build locally with Docker Compose

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
docker compose up -d --build
```


### Option C — Plain Node (no Docker)

```bash
cd taglist-service
npm install
npm start
```

Note: Puppeteer's `npm install` downloads a Chromium build automatically. On Linux you
may need extra system libs (libnss3, libatk1.0-0, libgbm1, etc.) if you're not using Docker.

## 2. API

### `GET/POST /extract`

| Param      | Required | Default       | Description                                                                 |
|------------|----------|---------------|------------------------------------------------------------------------------|
| `url`      | yes      | —             | Page URL to load                                                              |
| `selector` | no       | `#taglist`    | CSS selector of the element to extract                                       |
| `mode`     | no       | `innerText`   | `innerText` \| `innerHTML` \| `outerHTML` \| `html` (returns full rendered page) |
| `waitFor`  | no       | `0`           | Extra ms to wait after the selector appears (use if content loads in stages) |
| `timeout`  | no       | `15000`       | Max ms to wait for the selector to appear                                    |

### Example

```bash
curl -G "http://localhost:3000/extract" \
  --data-urlencode "url=https://gmatclub.com/forum/recently-proposed-legislation-would-change-the-way-that-the-federal-458806.html" \
  --data-urlencode "selector=#taglist"
```

Response:

```json
{
  "success": true,
  "selector": "#taglist",
  "mode": "innerText",
  "data": "555-605 (Medium)|  Assumption|  Kaplan"
}
```

### Health check

```bash
curl http://localhost:3000/health
```

## 3. Use it from n8n

1. Add an **HTTP Request** node.
2. Method: `GET` (or `POST`).
3. URL: `http://<your-host>:3000/extract`
   - If n8n runs in Docker on the same machine as this service, use the Docker network
     hostname (e.g. `http://taglist-service:3000/extract` if both are on the same
     `docker-compose` network) or `http://host.docker.internal:3000/extract`.
4. Query Parameters:
   - `url` = `{{ $json.pageUrl }}` (or wherever your URL comes from upstream)
   - `selector` = `#taglist`
   - `mode` = `innerText`
5. Response → JSON. The result is at `{{ $json.data }}`, e.g.
   `"555-605 (Medium)|  Assumption|  Kaplan"`.

### Splitting the tags

The raw text is pipe-separated. Add a **Code** node (or Set node with an expression)
after the HTTP Request to split it into clean fields:

```javascript
const raw = $input.item.json.data; // "555-605 (Medium)|  Assumption|  Kaplan"
const parts = raw.split('|').map(s => s.trim()).filter(Boolean);

return {
  json: {
    difficulty: parts[0] || null,   // "555-605 (Medium)"
    questionType: parts[1] || null, // "Assumption"
    source: parts[2] || null,       // "Kaplan"
    rawTags: parts,
  }
};
```

## 4. Notes / tuning

- The browser instance is reused across requests (faster after the first call), but
  each `/extract` call opens and closes its own page (tab) — safe for concurrent requests.
- If a target site is heavier or the tag list loads after additional async calls,
  increase `waitFor` (e.g. `waitFor=2000`) or `timeout`.
- For scraping many URLs, call `/extract` once per URL from an n8n loop (Split In Batches
  node) — the shared browser keeps things efficient.
- If you deploy this on a VPS, put it behind a reverse proxy (nginx/Caddy) with basic
  auth or an API key check, since it can be used as an open URL-fetch proxy otherwise.
