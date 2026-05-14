#!/usr/bin/env node
/**
 * lego-sku-scraper.js
 * کد محصول رو مستقیم از URL لیست استخراج می‌کنه — بدون رفتن به صفحه محصول
 * خروجی: output/lego-skus.json  و  output/lego-skus-only.json
 */

const fs   = require('fs');
const path = require('path');

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CONFIG = {
  all_products_url: 'https://lego.tr/yeni-urunler',
  delay_ms:         1200,
  max_pages:        200,
  output_dir:       './output',
  timeout:          60000,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

let browser = null;

async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });
  return browser;
}

async function closeBrowser() {
  if (browser) { await browser.close(); browser = null; }
}

async function fetchHTML(targetUrl, waitMs = 3000) {
  const b    = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' });
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    await sleep(waitMs);
    return await page.content();
  } finally {
    await page.close();
  }
}

// ─── استخراج کد محصول مستقیم از URL ──────────────────────────────────────────
// مثال: /20290-0199-lego-yapim-parcasi  →  20290
// مثال: /10425-lego-duplo-tren          →  10425
function extractSkuFromUrl(url) {
  const slug = url.split('/').pop().split('?')[0];
  const m = slug.match(/^(\d{4,6})/);
  return m ? m[1] : null;
}

// ─── استخراج URL محصولات از HTML ──────────────────────────────────────────────
function extractProductData(html) {
  const results = new Map(); // sku → source_url

  const patterns = [
    /href="(https:\/\/lego\.tr\/\d{3,6}[a-z0-9\-]+)"/gi,
    /href="(\/\d{3,6}[a-z0-9\-]+)"/gi,
    /href="(\/product\/\d{3,6}[a-z0-9\-]+)"/gi,
  ];

  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      let u = m[1];
      if (u.startsWith('/')) u = 'https://lego.tr' + u;

      const sku = extractSkuFromUrl(u);
      if (sku && !results.has(sku)) {
        results.set(sku, u);
      }
    }
  }

  return results;
}

// ─── ذخیره نتایج ──────────────────────────────────────────────────────────────
function saveResults(allSkus) {
  fs.mkdirSync(CONFIG.output_dir, { recursive: true });
  const fullPath = path.join(CONFIG.output_dir, 'lego-skus.json');
  const onlyPath = path.join(CONFIG.output_dir, 'lego-skus-only.json');
  fs.writeFileSync(fullPath, JSON.stringify(allSkus, null, 2), 'utf8');
  fs.writeFileSync(onlyPath, JSON.stringify(allSkus.map(i => i.sku), null, 2), 'utf8');
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const get  = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

  if (get('--output')) CONFIG.output_dir       = get('--output');
  if (get('--delay'))  CONFIG.delay_ms         = parseInt(get('--delay')) || CONFIG.delay_ms;
  if (get('--url'))    CONFIG.all_products_url = get('--url');

  const baseUrl  = CONFIG.all_products_url.split('?')[0].replace(/\/+$/, '');
  const seenSkus = new Set();
  let   allSkus  = [];

  console.log('='.repeat(60));
  console.log('  🧱 LEGO.tr SKU Scraper — استخراج از URL');
  console.log(`  🔗 ${baseUrl}`);
  console.log('='.repeat(60));

  try {
    for (let ps = 1; ps <= CONFIG.max_pages; ps++) {
      const pageUrl = ps === 1 ? baseUrl : `${baseUrl}?ps=${ps}`;
      process.stdout.write(`\n📄 صفحه ${ps} ... `);

      let html;
      try {
        html = await fetchHTML(pageUrl, 3000);
      } catch(e) {
        console.error(`❌ ${e.message}`);
        break;
      }

      const found   = extractProductData(html);
      const freshMap = new Map([...found].filter(([sku]) => !seenSkus.has(sku)));

      if (freshMap.size === 0) {
        console.log(`🏁 خالی بود — اتمام`);
        break;
      }

      freshMap.forEach((url, sku) => {
        seenSkus.add(sku);
        allSkus.push({ sku, source_url: url });
      });

      console.log(`✅ ${freshMap.size} کد جدید (مجموع: ${allSkus.length})`);

      // نمایش نمونه
      [...freshMap.entries()].slice(0, 3).forEach(([sku, url]) => {
        console.log(`    ${sku} ← ${url.split('/').pop()}`);
      });

      saveResults(allSkus);
      await sleep(CONFIG.delay_ms);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ ${allSkus.length} کد یکتا استخراج شد`);
    console.log(`📄 JSON کامل → ${path.join(CONFIG.output_dir, 'lego-skus.json')}`);
    console.log(`📄 فقط کدها  → ${path.join(CONFIG.output_dir, 'lego-skus-only.json')}`);
    console.log('='.repeat(60));

  } finally {
    await closeBrowser();
  }
}

main().catch(err => {
  console.error('❌', err.message);
  closeBrowser().finally(() => process.exit(1));
});
