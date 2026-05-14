#!/usr/bin/env node
/**
 * lego-sku-scraper.js
 * همه محصولات lego.tr رو از صفحه yeni-urunler با ?ps=N اسکرپ می‌کنه
 * خروجی: output/lego-skus.json  و  output/lego-skus-only.json
 */

const fs   = require('fs');
const path = require('path');

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ─── تنظیمات ──────────────────────────────────────────────────────────────────
const CONFIG = {
  all_products_url: 'https://lego.tr/yeni-urunler',
  delay_ms:         800,
  max_pages:        200,
  output_dir:       './output',
  timeout:          60000,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Browser ───────────────────────────────────────────────────────────────────
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

// ─── Fetch HTML ────────────────────────────────────────────────────────────────
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

// ─── استخراج URL محصولات از HTML ──────────────────────────────────────────────
function extractProductUrls(html) {
  const urls = new Set();
  const patterns = [
    /href="(https:\/\/lego\.tr\/\d{3,6}[a-z]?-[a-z0-9\-]+)"/gi,
    /href="(\/\d{3,6}[a-z]?-[a-z0-9\-]+)"/gi,
    /href="(\/product\/\d{3,6}[a-z]?-[a-z0-9\-]+)"/gi,
    /href="(https:\/\/lego\.tr\/product\/[a-z0-9\-]+)"/gi,
    /href="(\/product\/[a-z0-9\-]+)"/gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      let u = m[1];
      if (u.startsWith('/')) u = 'https://lego.tr' + u;
      urls.add(u);
    }
  }
  return [...urls];
}

// ─── استخراج SKU از صفحه محصول ────────────────────────────────────────────────
function extractSku(html, sourceUrl) {
  // روش ۱: PRODUCT_DATA
  const pdM = html.match(/PRODUCT_DATA\.push\(JSON\.parse\('(.+?)'\)\)/s);
  if (pdM) {
    try {
      const pd = JSON.parse(pdM[1].replace(/\\'/g, "'"));
      if (pd.code) return { sku: pd.code, source_url: sourceUrl };
    } catch(e) {}
  }

  // روش ۲: JSON-LD
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      let ld = JSON.parse(m[1]);
      if (Array.isArray(ld)) ld = ld[0];
      if (ld && ld['@type'] === 'Product' && ld.sku) {
        return { sku: ld.sku, source_url: sourceUrl };
      }
    } catch(e) {}
  }

  // روش ۳: از URL
  const urlPart  = sourceUrl.split('/').pop();
  const skuMatch = urlPart.match(/^(\d{4,6}[a-z]?)/i);
  if (skuMatch) return { sku: skuMatch[1], source_url: sourceUrl };

  return null;
}

// ─── ذخیره نتایج (بعد از هر صفحه) ────────────────────────────────────────────
function saveResults(allSkus) {
  fs.mkdirSync(CONFIG.output_dir, { recursive: true });
  const fullPath = path.join(CONFIG.output_dir, 'lego-skus.json');
  const onlyPath = path.join(CONFIG.output_dir, 'lego-skus-only.json');
  fs.writeFileSync(fullPath, JSON.stringify(allSkus, null, 2), 'utf8');
  fs.writeFileSync(onlyPath, JSON.stringify(allSkus.map(i => i.sku), null, 2), 'utf8');
  process.stdout.write(` 💾 ذخیره شد (${allSkus.length} کد)\n`);
}

// ─── اسکرپ یه صفحه از لیست محصولات ──────────────────────────────────────────
async function scrapeListPage(pageUrl, knownUrls) {
  const html      = await fetchHTML(pageUrl, 3000);
  const allOnPage = extractProductUrls(html);
  const freshUrls = allOnPage.filter(u => !knownUrls.has(u));
  freshUrls.forEach(u => knownUrls.add(u));

  const pageSkus = [];

  for (let i = 0; i < freshUrls.length; i++) {
    const productUrl = freshUrls[i];
    process.stdout.write(
      `    [${i + 1}/${freshUrls.length}] ${productUrl.split('/').pop().slice(0, 40)} ... `
    );
    await sleep(CONFIG.delay_ms);

    try {
      const pHtml = await fetchHTML(productUrl, 2000);
      const item  = extractSku(pHtml, productUrl);

      if (item) {
        console.log(`✅ ${item.sku}`);
        pageSkus.push(item);
      } else {
        console.log(`⚠️  SKU پیدا نشد`);
      }
    } catch(e) {
      console.log(`❌ ${e.message}`);
    }
  }

  return pageSkus;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const get  = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

  if (get('--output')) CONFIG.output_dir       = get('--output');
  if (get('--delay'))  CONFIG.delay_ms         = parseInt(get('--delay')) || CONFIG.delay_ms;
  if (get('--url'))    CONFIG.all_products_url = get('--url');

  const baseUrl   = CONFIG.all_products_url.split('?')[0].replace(/\/+$/, '');
  const knownUrls = new Set();
  let   allSkus   = [];

  console.log('='.repeat(60));
  console.log('  🧱 LEGO.tr SKU Scraper');
  console.log(`  🔗 ${baseUrl}`);
  console.log('='.repeat(60));

  try {
    for (let ps = 1; ps <= CONFIG.max_pages; ps++) {
      // صفحه اول بدون پارامتر، بقیه با ?ps=N
      const pageUrl = ps === 1 ? baseUrl : `${baseUrl}?ps=${ps}`;
      console.log(`\n📄 صفحه ${ps} → ${pageUrl}`);

      let pageSkus;
      try {
        pageSkus = await scrapeListPage(pageUrl, knownUrls);
      } catch(e) {
        console.error(`❌ خطا در صفحه ${ps}: ${e.message}`);
        break;
      }

      if (pageSkus.length === 0) {
        console.log(`🏁 صفحه ${ps} خالی بود — اتمام`);
        break;
      }

      allSkus.push(...pageSkus);
      saveResults(allSkus);
      console.log(`📊 مجموع تا اینجا: ${allSkus.length} کد`);
      await sleep(CONFIG.delay_ms);
    }

    // حذف تکراری نهایی
    const seen = new Set();
    allSkus = allSkus.filter(item => {
      if (!item.sku || seen.has(item.sku)) return false;
      seen.add(item.sku);
      return true;
    });

    saveResults(allSkus);

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
