const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browserPromise;
}

// Block images/fonts/css to speed up page loads
async function blockResources(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

/**
 * GET or POST /extract
 * Query/body params:
 *   url       (required) - page to load
 *   selector  (optional) - CSS selector to extract, default "#taglist"
 *   mode      (optional) - "innerText" | "innerHTML" | "outerHTML" | "html" (full page), default "innerText"
 *   waitFor   (optional) - extra ms to wait after selector appears (default 0)
 *   timeout   (optional) - max ms to wait for selector (default 30000)
 *   cookie    (optional) - raw cookie header string to set on the page (for authenticated sessions)
 */
async function handleExtract(req, res) {
  const params = { ...req.query, ...req.body };
  const {
    url,
    selector = '#taglist',
    mode = 'innerText',
    waitFor = '0',
    timeout = '30000',
    cookie,
  } = params;

  if (!url) {
    return res.status(400).json({ error: 'Missing required "url" parameter' });
  }

  let page;
  try {
    const browser = await getBrowser();

    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 900 });
    await blockResources(page);

    // If a cookie string is provided, apply it before navigating
    if (cookie) {
      const targetUrl = new URL(url);
      const cookiePairs = cookie.split(';').map((c) => c.trim()).filter(Boolean);
      const cookieObjects = cookiePairs.map((pair) => {
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx);
        const value = pair.slice(idx + 1);
        return {
          name,
          value,
          domain: targetUrl.hostname,
          path: '/',
        };
      });
      await page.setCookie(...cookieObjects);
    }

    console.log(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    if (mode === 'html') {
      const html = await page.content();
      console.log(`Returned full HTML for: ${url}`);
      return res.json({ success: true, html });
    }

    console.log(`Waiting for selector: ${selector}`);
    await page.waitForSelector(selector, { timeout: parseInt(timeout, 10) });
    console.log(`Found selector: ${selector}`);

    const extraWait = parseInt(waitFor, 10);
    if (extraWait > 0) {
      await new Promise((r) => setTimeout(r, extraWait));
    }

    const result = await page.evaluate(
      (sel, m) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        if (m === 'innerHTML') return el.innerHTML;
        if (m === 'outerHTML') return el.outerHTML;
        return el.innerText;
      },
      selector,
      mode
    );

    if (result === null) {
      console.log(`Selector "${selector}" not found on page: ${url}`);
      return res.status(404).json({
        success: false,
        error: `Selector "${selector}" not found on page`,
      });
    }

    console.log(`Extracted ${result.length} chars from "${selector}" on: ${url}`);
    return res.json({ success: true, selector, mode, data: result.trim() });
  } catch (err) {
    console.error(`Error extracting ${url}:`, err.message);
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
    }
    browserPromise = null;
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    try {
      if (page) await page.close();
    } catch (_) {
      // page already closed if browser was reset
    }
  }
}

app.get('/', (req, res) => {
  res.send('Taglist service is running!');
});

app.get('/extract', handleExtract);
app.post('/extract', handleExtract);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Taglist extraction service listening on port ${PORT}`);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
