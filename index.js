const express = require('express');
const puppeteer = require('puppeteer');

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

/**
 * GET or POST /extract
 * Query/body params:
 *   url       (required) - page to load
 *   selector  (optional) - CSS selector to extract, default "#taglist"
 *   mode      (optional) - "innerText" | "innerHTML" | "outerHTML" | "html" (full page), default "innerText"
 *   waitFor   (optional) - extra ms to wait after selector appears (default 0)
 *   timeout   (optional) - max ms to wait for selector (default 15000)
 */
async function handleExtract(req, res) {
  const params = { ...req.query, ...req.body };
  const {
    url,
    selector = '#taglist',
    mode = 'innerText',
    waitFor = '0',
    timeout = '15000',
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

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    if (mode === 'html') {
      const html = await page.content();
      return res.json({ success: true, html });
    }

    // Wait for the target selector to appear (data is JS-injected)
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
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    if (page) await page.close();
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
