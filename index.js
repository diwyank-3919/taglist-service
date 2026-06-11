const express = require('express');
const puppeteer = require('puppeteer');

const USERNAME = process.env.GMATCLUB_USERNAME;
const PASSWORD = process.env.GMATCLUB_PASSWORD;

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Reuse a single browser instance across requests for performance
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

// Track login state so we don't re-login on every request
let isLoggedIn = false;

async function ensureLoggedIn(browser) {
  if (isLoggedIn) return;

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 900 });

    await page.goto('https://gmatclub.com/forum/ucp.php?mode=login', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    await page.waitForSelector('input[name="username"]');
    await page.type('input[name="username"]', USERNAME);
    await page.type('input[name="password"]', PASSWORD);

    await Promise.all([
      page.click('input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }),
    ]);

    // Verify login succeeded by checking for a logged-in indicator
    const loggedIn = await page.evaluate(() => {
      return !document.querySelector('input[name="username"]');
    });

    if (!loggedIn) {
      throw new Error('Login failed — check GMATCLUB_USERNAME and GMATCLUB_PASSWORD env vars');
    }

    isLoggedIn = true;
    console.log('Successfully logged in to GMATClub');
  } finally {
    await page.close();
  }
}

/**
 * GET or POST /extract
 * Query/body params:
 *   url       (required) - page to load
 *   selector  (optional) - CSS selector to extract, default "#taglist"
 *   mode      (optional) - "innerText" | "innerHTML" | "outerHTML" | "html" (full page), default "innerText"
 *   waitFor   (optional) - extra ms to wait after selector appears (default 0)
 *   timeout   (optional) - max ms to wait for selector (default 30000)
 */
async function handleExtract(req, res) {
  const params = { ...req.query, ...req.body };
  const {
    url,
    selector = '#taglist',
    mode = 'innerText',
    waitFor = '0',
    timeout = '30000',
  } = params;

  if (!url) {
    return res.status(400).json({ error: 'Missing required "url" parameter' });
  }

  let page;
  try {
    const browser = await getBrowser();

    // Ensure we are logged in (only logs in once, reuses session)
    await ensureLoggedIn(browser);

    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 900 });
    await page.setRequestInterception(true);
page.on('request', (req) => {
  if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
    req.abort();
  } else {
    req.continue();
  }
});

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

    if (mode === 'html') {
      const html = await page.content();
      console.log('Contains taglist:', html.includes('taglist'));
      return res.json({ success: true, html });
    }

    // Wait for the target selector to appear
    await page.waitForSelector(selector, { timeout: parseInt(timeout, 10) });

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
      return res.status(404).json({
        success: false,
        error: `Selector "${selector}" not found on page`,
      });
    }

    return res.json({ success: true, selector, mode, data: result.trim() });
 } catch (err) {
    isLoggedIn = false;
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

// Graceful shutdown
process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
