const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

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
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,900',
      ],
    });
  }
  return browserPromise;
}

// Block images/fonts/css to speed up page loads (optional)
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
 *   url          (required) - page to load
 *   selector     (optional) - CSS selector to extract, default "#taglist"
 *   mode         (optional) - "innerText" | "innerHTML" | "outerHTML" | "html" (full page), default "innerText"
 *   waitFor      (optional) - extra ms to wait after selector appears (default 0)
 *   timeout      (optional) - max ms to wait for selector (default 30000)
 *   cookie       (optional) - raw cookie string to inject into Puppeteer (e.g. "name=value; name2=value2")
 *   blockAssets  (optional) - "true" | "false" — whether to block images/css/fonts (default "false")
 *   waitUntil    (optional) - Puppeteer waitUntil strategy: "domcontentloaded" | "networkidle2" | "load" (default "networkidle2")
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
    blockAssets = 'false',
    waitUntil = 'networkidle2',
  } = params;

  if (!url) {
    return res.status(400).json({ error: 'Missing required "url" parameter' });
  }

  let page;
  try {
    const browser = await getBrowser();

    page = await browser.newPage();

    // Realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 900 });

    // Extra stealth: override navigator properties
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    // Conditionally block resources
    if (blockAssets === 'true') {
      await blockResources(page);
    }

    // Inject cookies BEFORE navigating so they're sent with the first request
    if (cookie) {
      const targetUrl = new URL(url);
      const cookiePairs = cookie.split(';').map((c) => c.trim()).filter(Boolean);
      const cookieObjects = cookiePairs.map((pair) => {
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        return {
          name,
          value,
          domain: targetUrl.hostname,
          path: '/',
        };
      });
      await page.setCookie(...cookieObjects);
      console.log(`Set ${cookieObjects.length} cookie(s) for ${new URL(url).hostname}`);
    }

    console.log(`Navigating to: ${url} (waitUntil: ${waitUntil})`);
    await page.goto(url, {
      waitUntil: waitUntil,
      timeout: 90000,
    });

    // Return full page HTML if mode is "html"
    if (mode === 'html') {
      const html = await page.content();
      console.log(`Returned full HTML (${html.length} chars) for: ${url}`);
      return res.json({ success: true, html });
    }

    console.log(`Waiting for selector: "${selector}" (timeout: ${timeout}ms)`);
    await page.waitForSelector(selector, { timeout: parseInt(timeout, 10) });
    console.log(`Found selector: "${selector}"`);

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
      console.log(`Selector "${selector}" found in DOM but returned null on: ${url}`);
      return res.status(404).json({
        success: false,
        error: `Selector "${selector}" not found on page`,
      });
    }

    console.log(`Extracted ${result.length} chars from "${selector}" on: ${url}`);
    return res.json({ success: true, selector, mode, data: result.trim() });

  } catch (err) {
    console.error(`Error extracting ${url}:`, err.message);

    // Reset the browser on crash so the next request gets a fresh one
    if (browserPromise) {
      try {
        const browser = await browserPromise;
        await browser.close();
      } catch (_) {
        // already dead
      }
    }
    browserPromise = null;

    return res.status(500).json({ success: false, error: err.message });
  } finally {
    try {
      if (page && !page.isClosed()) await page.close();
    } catch (_) {
      // page already closed if browser was reset
    }
  }
}

app.get('/', (req, res) => {
  res.send('Taglist extraction service is running!');
});

app.get('/extract', handleExtract);
app.post('/extract', handleExtract);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Taglist extraction service listening on port ${PORT}`);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch (_) {}
  }
  process.exit(0);
});
