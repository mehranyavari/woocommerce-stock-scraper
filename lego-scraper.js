#!/usr/bin/env node
/**
 * lego-scraper.js
 * اسکرپر محصولات lego.tr
 * خروجی: فایل XML استاندارد WooCommerce برای import مستقیم
 *
 * نصب: npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth axios
 * اجرا: node lego-scraper.js --url "https://lego.tr/themes/lego-city"
 *    یا: node lego-scraper.js --product "https://lego.tr/43033-xxx"
 *    یا: node lego-scraper.js --all   (همه کتگوری‌ها)
 */

const fs   = require('fs');
const path = require('path');
const url  = require('url');

// --- Puppeteer Imports ---
const puppeteer    = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

let browser = null; // برای نگهداری نمونه مرورگر باز شده

// ─── تنظیمات ──────────────────────────────────────────────────────────────────
const CONFIG = {
  base_url:   'https://lego.tr',
  delay_ms:   800,          // تاخیر بین درخواست‌ها (میلی‌ثانیه)
  max_pages:  50,           // حداکثر صفحات هر کتگوری
  output_dir: './output',   // پوشه خروجی
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  timeout:    60000,

  // دسته‌بندی‌های پیش‌فرض lego.tr (برای --all)
  categories: [
    'themes/lego-city',
    'themes/lego-technic',
    'themes/lego-star-wars',
    'themes/lego-harry-potter',
    'themes/lego-ninjago',
    'themes/lego-creator',
    'themes/lego-icons',
    'themes/lego-architecture',
    'themes/lego-friends',
    'themes/lego-pokemon',
  ]
};

// ─── Helper: تاخیر ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Helper: Initialize Puppeteer Browser ──────────────────────────────────
async function initBrowser() {
  if (browser) return browser;

  console.log('Initializing Puppeteer browser...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  console.log('Browser initialized.');
  return browser;
}

// ─── Helper: Close Puppeteer Browser ──────────────────────────────────────
async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
      console.log('Browser closed.');
    } catch (e) {
      console.error('Error closing browser:', e.message);
    }
    browser = null;
  }
}

// ─── Helper: HTTP GET via Puppeteer ───────────────────────────────────────
async function fetchHTML(targetUrl) {
  await initBrowser();

  const page = await browser.newPage();

  try {
    await page.setUserAgent(CONFIG.user_agent);

    await page.setViewport({ width: 1920, height: 1080 });

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
    });

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType();
      if (
        type === 'image' ||
        type === 'stylesheet' ||
        type === 'font' ||
        type === 'media' ||
        type === 'other'
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log(`Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.timeout,
    });
    console.log('Page loaded, waiting for scripts...');
    await sleep(5000);

    const html = await page.content();
    console.log('HTML content extracted.');

    await page.close();
    return html;
  } catch (err) {
    console.error(`Error fetching ${targetUrl}: ${err.message}`);
    try {
      await page.close();
    } catch (_) {}
    throw err;
  }
}

// ─── استخراج اطلاعات محصول از HTML ───────────────────────────────────────────
function parseProductPage(html, sourceUrl) {
  const product = {
    source_url:   sourceUrl,
    name:         '',
    sku:          '',
    barcode:      '',
    description:  '',
    price_try:    0,
    sale_price:   0,
    quantity:     0,
    images:       [],
    category:     '',
    category_path:'',
    brand:        'LEGO',
    available:    false,
    weight:       '',
    dimensions:   { length: '', width: '', height: '' },
    tags:         [],
    attributes:   {},
  };

  // 1. PRODUCT_DATA
  const pdMatch = html.match(/PRODUCT_DATA\.push\(JSON\.parse\('(.+?)'\)\)/s);
  if (pdMatch) {
    try {
      const pd = JSON.parse(pdMatch[1].replace(/\\'/g, "'"));
      product.name      = pd.name     ? decodeHtmlEntities(pd.name) : '';
      product.sku       = pd.code     || '';
      product.barcode   = pd.supplier_code || pd.barcode || '';
      product.price_try = pd.total_sale_price || pd.total_price || 0;
      product.quantity  = typeof pd.quantity === 'number' ? pd.quantity : 0;
      product.available = !!pd.available;
      product.category  = pd.category ? decodeHtmlEntities(pd.category) : '';
      product.category_path = pd.category_path ? pd.category_path.replace(/\s*>\s*/g, ' > ') : '';
      product.brand     = pd.brand    || 'LEGO';
      if (pd.image) product.images.push(pd.image);
    } catch(e) { console.error('Error parsing PRODUCT_DATA:', e.message); }
  }

  // 2. JSON-LD
  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      let ld = JSON.parse(m[1]);
      if (Array.isArray(ld)) ld = ld[0];
      if (!ld || ld['@type'] !== 'Product') continue;

      if (!product.name  && ld.name)        product.name = ld.name;
      if (!product.sku   && ld.sku)         product.sku  = ld.sku;
      if (!product.barcode && ld.gtin13)    product.barcode = ld.gtin13;
      if (ld.description) product.description = ld.description.trim();

      if (ld.offers) {
        const offers = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
        if (!product.price_try && offers.price) {
          product.price_try = parseFloat(offers.price);
        }
      }

      if (ld.image) {
        const imgs = Array.isArray(ld.image) ? ld.image : [ld.image];
        for (const img of imgs) {
          const cleanImg = img.replace(/\\/g, '');
          if (!product.images.includes(cleanImg)) product.images.push(cleanImg);
        }
      }

      if (!product.category && ld.category) {
        const parts = ld.category.split('>');
        product.category = parts[parts.length - 1].trim();
        if (parts.length > 1) {
          product.category_path = parts.slice(0, -1).map(p => p.trim()).join(' > ');
        }
      }
      break;
    } catch(e) { console.error('Error parsing JSON-LD:', e.message); }
  }

  // 3. گالری تصاویر
  const galleryRe = /data-id="0"\s+href="(https:\/\/lego\.witcdn\.net[^"]+(?:-B|-O)\.jpg)"/g;
  for (const m of html.matchAll(galleryRe)) {
    const oImg = m[1].replace(/-[BK]\.jpg$/, '-O.jpg');
    if (!product.images.includes(oImg)) product.images.push(oImg);
  }

  // 4. ابعاد از توضیحات
  if (product.description) {
    const dimMatch = product.description.match(/yüksekliği\s+(\d+)\s*cm.*?genişliği\s+(\d+)\s*cm.*?derinliği\s+(\d+)\s*cm/i);
    if (dimMatch) {
      product.dimensions.height = dimMatch[1];
      product.dimensions.width  = dimMatch[2];
      product.dimensions.length = dimMatch[3];
    }
  }

  // 5. تعداد قطعات
  const parcaMatch = html.match(/<strong>(\d+)<\/strong>\s*<span[^>]*>Parça<\/span>/);
  if (parcaMatch) {
    product.attributes['Parça Sayısı'] = parcaMatch[1];
  }

  // 6. موجودی / وضعیت
  if (!product.available) {
    const stokMatch = html.match(/Stokta var|Stokta yok|Tükendi/i);
    if (stokMatch) {
      product.available = /Stokta var/i.test(stokMatch[0]);
    }
  }

  return product;
}

// ─── استخراج URL محصولات از صفحه لیست ──────────────────────────────────────
function extractProductUrlsFromListing(html) {
  const urls = new Set();

  const re = /<a[^>]+href="(https:\/\/lego\.tr\/\d{3,}-[^"]+)"[^>]*class="product-image"/g;
  for (const m of html.matchAll(re)) {
    urls.add(m[1]);
  }

  return Array.from(urls);
}

// ─── تشخیص تعداد صفحات کتگوری ───────────────────────────────────────────────
function getTotalPages(html) {
  const match = html.match(/href="[^"]*[\?&]pg=(\d+)[^"]*".*?>\s*Son\s*<\/a>/i);
  if (match) {
    return parseInt(match[1], 10) || 1;
  }
  return 1;
}

// ─── Helper: XML Escape ─────────────────────────────────────────────────────
function xmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Helper: Decode HTML Entities ───────────────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'');
}

// ─── ساخت XML هر محصول ─────────────────────────────────────────────────────
function buildProductXml(p, index) {
  const id = index + 1;
  const sku = xmlEscape(p.sku || `lego-${id}`);

  const price = p.price_try || 0;

  let imagesXml = '';
  if (p.images && p.images.length) {
    p.images.forEach((img, idx) => {
      imagesXml += `
      <image position="${idx}">${xmlEscape(img)}</image>`;
    });
  }

  let attrsXml = '';
  if (p.attributes) {
    Object.entries(p.attributes).forEach(([name, value]) => {
      attrsXml += `
    <attribute>
      <name>${xmlEscape(name)}</name>
      <value>${xmlEscape(value)}</value>
      <position>0</position>
      <visible>1</visible>
      <variation>0</variation>
    </attribute>`;
    });
  }

  const shortDesc = p.description ? xmlEscape(p.description.slice(0, 400)) : '';
  const fullDesc  = p.description ? xmlEscape(p.description) : '';

  const categoryName = xmlEscape(p.category || 'LEGO');

  return `
  <item>
    <title>${xmlEscape(p.name || sku)}</title>
    <link>${xmlEscape(p.source_url || '')}</link>
    <sku>${sku}</sku>
    <regular_price>${price}</regular_price>
    <stock_status>${p.available && p.quantity > 0 ? 'instock' : 'outofstock'}</stock_status>
    <manage_stock>1</manage_stock>
    <stock_quantity>${p.quantity || 0}</stock_quantity>
    <description>${fullDesc}</description>
    <short_description>${shortDesc}</short_description>
    <category>${categoryName}</category>
    <images>${imagesXml}
    </images>
    <attributes>${attrsXml}
    </attributes>
  </item>`;
}

// ─── Scraper: یک محصول ─────────────────────────────────────────────────────
async function scrapeProductUrl(productUrl) {
  console.log(`Scraping product: ${productUrl}`);
  const html = await fetchHTML(productUrl);
  const product = parseProductPage(html, productUrl);
  return product;
}

// ─── Scraper: یک کتگوری ───────────────────────────────────────────────────
async function scrapeCategory(categoryPathOrUrl) {
  const isFullUrl = /^https?:\/\//i.test(categoryPathOrUrl);
  const firstUrl = isFullUrl
    ? categoryPathOrUrl
    : `${CONFIG.base_url.replace(/\/+$/, '')}/${categoryPathOrUrl.replace(/^\/+/, '')}`;

  console.log(`Scraping category: ${firstUrl}`);

  const firstHtml = await fetchHTML(firstUrl);
  let totalPages  = getTotalPages(firstHtml);
  if (totalPages > CONFIG.max_pages) {
    console.log(`Total pages (${totalPages}) > max_pages (${CONFIG.max_pages}), limiting.`);
    totalPages = CONFIG.max_pages;
  }

  const allProducts = [];

  async function scrapeListingPage(pageNum) {
    let pageUrl = firstUrl;
    if (pageNum > 1) {
      const parsed = new url.URL(firstUrl);
      if (parsed.searchParams.has('pg')) {
        parsed.searchParams.set('pg', pageNum);
      } else {
        parsed.searchParams.append('pg', pageNum);
      }
      pageUrl = parsed.toString();
    }

    console.log(`Listing page ${pageNum}/${totalPages}: ${pageUrl}`);
    const html = pageNum === 1 ? firstHtml : await fetchHTML(pageUrl);
    const productUrls = extractProductUrlsFromListing(html);
    console.log(`Found ${productUrls.length} products on page ${pageNum}.`);

    for (const pUrl of productUrls) {
      try {
        const product = await scrapeProductUrl(pUrl);
        allProducts.push(product);
        await sleep(CONFIG.delay_ms);
      } catch (e) {
        console.error(`Error scraping product ${pUrl}:`, e.message);
      }
    }
  }

  for (let pg = 1; pg <= totalPages; pg++) {
    await scrapeListingPage(pg);
    await sleep(CONFIG.delay_ms);
  }

  return allProducts;
}

// ─── Scraper: همه کتگوری‌های پیش‌فرض ─────────────────────────────────────
async function scrapeAllCategories() {
  const results = [];
  for (const cat of CONFIG.categories) {
    try {
      const products = await scrapeCategory(cat);
      results.push(...products);
    } catch (e) {
      console.error(`Error scraping category ${cat}:`, e.message);
    }
  }
  return results;
}

// ─── خروجی XML ─────────────────────────────────────────────────────────────
function wrapXml(products) {
  const itemsXml = products.map((p, idx) => buildProductXml(p, idx)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:g="http://base.google.com/ns/1.0"
  xmlns:wpsc="http://wordpress.org/export/1.1/">
<channel>
  <title>LEGO TR Products</title>
  <link>${xmlEscape(CONFIG.base_url)}</link>
  <description>Exported from lego.tr</description>
${itemsXml}
</channel>
</rss>`;
}

// ─── ذخیره خروجی ───────────────────────────────────────────────────────────
function ensureOutputDir() {
  if (!fs.existsSync(CONFIG.output_dir)) {
    fs.mkdirSync(CONFIG.output_dir, { recursive: true });
  }
}

function saveXmlToFile(xml, filenamePrefix = 'lego-tr') {
  ensureOutputDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(CONFIG.output_dir, `${filenamePrefix}-${ts}.xml`);
  fs.writeFileSync(outPath, xml, 'utf8');
  console.log(`XML saved to: ${outPath}`);
}

// ─── CLI / main ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { url: null, product: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) {
      args.url = argv[++i];
    } else if (arg === '--product' && argv[i + 1]) {
      args.product = argv[++i];
    } else if (arg === '--all') {
      args.all = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.url && !args.product && !args.all) {
    console.log('Usage: node lego-scraper.js [--url CATEGORY_URL] [--product PRODUCT_URL] [--all]');
    process.exit(1);
  }

  let products = [];

  try {
    if (args.product) {
      const p = await scrapeProductUrl(args.product);
      products = [p];
    } else if (args.url) {
      products = await scrapeCategory(args.url);
    } else if (args.all) {
      products = await scrapeAllCategories();
    }

    console.log(`Total products scraped: ${products.length}`);

    const xml = wrapXml(products);
    saveXmlToFile(xml, 'lego-tr');
  } catch (err) {
    console.error('Error in main:', err);
  } finally {
    await closeBrowser();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
