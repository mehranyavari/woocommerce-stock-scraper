#!/usr/bin/env node
/**
 * lego-scraper.js — نسخه نهایی با دانلود تصاویر
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { execSync } = require('child_process');

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ─── تنظیمات ─────────────────────────────────────────────────────────────────
const CONFIG = {
  base_url:    'https://lego.tr',
  delay_ms:    1200,
  max_pages:   50,
  output_dir:  './output',
  images_dir:  './output/images',   // تصاویر اینجا ذخیره می‌شن
  timeout:     60000,

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
    'themes/lego-minecraft',
    'themes/lego-duplo',
    'themes/lego-speed-champions',
    'themes/lego-marvel',
    'themes/lego-disney',
  ]
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Browser ──────────────────────────────────────────────────────────────────
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

// ─── Fetch HTML via Puppeteer ─────────────────────────────────────────────────
async function fetchHTML(targetUrl, waitMs = 3000) {
  const b    = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','stylesheet','font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    await sleep(waitMs);
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// ─── دانلود یک فایل (بدون puppeteer) ────────────────────────────────────────
function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const lib = fileUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    const req = lib.get(fileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer':    'https://lego.tr/',
      },
      timeout: 30000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(destPath, () => {});
        return resolve(downloadFile(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    });

    req.on('error', err => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

// ─── دانلود تصاویر یک محصول ──────────────────────────────────────────────────
async function downloadProductImages(product) {
  if (!product.images || product.images.length === 0) return [];

  // نام پوشه: SKU + اول slug URL
  const folderName = product.sku
    ? product.sku
    : product.source_url.split('/').pop().slice(0, 50);

  const productImgDir = path.join(CONFIG.images_dir, folderName);
  fs.mkdirSync(productImgDir, { recursive: true });

  const downloaded = [];

  for (let i = 0; i < product.images.length; i++) {
    const imgUrl  = product.images[i];
    const ext     = path.extname(imgUrl.split('?')[0]) || '.jpg';
    const destPath = path.join(productImgDir, `${i + 1}${ext}`);

    // اگر قبلاً دانلود شده skip کن
    if (fs.existsSync(destPath)) {
      downloaded.push(destPath);
      continue;
    }

    try {
      await downloadFile(imgUrl, destPath);
      downloaded.push(destPath);
      await sleep(200);
    } catch(e) {
      process.stdout.write(`⚠️ `);
    }
  }

  return downloaded;
}

// ─── ساخت فایل ZIP تصاویر ────────────────────────────────────────────────────
function createImagesZip(outputPath) {
  const imagesDir = CONFIG.images_dir;

  if (!fs.existsSync(imagesDir)) {
    console.log('  پوشه تصاویر خالی است');
    return null;
  }

  const zipPath = outputPath || path.join(CONFIG.output_dir, 'lego-images.zip');

  try {
    // استفاده از zip دستور سیستم (موجود در Ubuntu/GitHub Actions)
    execSync(`cd "${CONFIG.output_dir}" && zip -r "lego-images.zip" "images/"`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log(`\n📦 ZIP تصاویر: ${zipPath}`);
    console.log(`   حجم: ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
    return zipPath;
  } catch(e) {
    console.error('خطا در ساخت ZIP:', e.message);
    return null;
  }
}

// ─── استخراج URL محصولات از صفحه لیست ───────────────────────────────────────
function extractProductUrls(html) {
  const urls = new Set();
  const patterns = [
    /href="(https:\/\/lego\.tr\/\d{3,6}-[a-z0-9\-]+)"/gi,
    /href="(\/\d{3,6}-[a-z0-9\-]+)"/gi,
    /href="(\/product\/\d{3,6}-[a-z0-9\-]+)"/gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      let u = m[1];
      if (u.startsWith('/')) u = CONFIG.base_url + u;
      if (/\/\d{3,6}-/.test(u)) urls.add(u);
    }
  }
  return [...urls];
}

function getTotalPages(html) {
  const pgNums = [...html.matchAll(/[?&]pg=(\d+)/g)].map(m => parseInt(m[1]));
  if (pgNums.length) return Math.max(...pgNums);
  return 1;
}

// ─── Parse محصول ─────────────────────────────────────────────────────────────
function parseProductPage(html, sourceUrl) {
  const p = {
    source_url:  sourceUrl,
    name:        '',
    sku:         '',
    barcode:     '',
    description: '',
    price_try:   0,
    quantity:    0,
    images:      [],
    category:    '',
    brand:       'LEGO',
    available:   false,
    attributes:  {},
    dimensions:  { length: '', width: '', height: '' },
  };

  const pdM = html.match(/PRODUCT_DATA\.push\(JSON\.parse\('(.+?)'\)\)/s);
  if (pdM) {
    try {
      const pd = JSON.parse(pdM[1].replace(/\\'/g, "'"));
      p.name      = pd.name            ? htmlDecode(pd.name) : '';
      p.sku       = pd.code            || '';
      p.barcode   = pd.supplier_code   || '';
      p.price_try = pd.total_sale_price || pd.total_price || 0;
      p.quantity  = typeof pd.quantity === 'number' ? pd.quantity : 0;
      p.available = !!pd.available;
      p.category  = pd.category        ? htmlDecode(pd.category) : '';
      p.brand     = pd.brand           || 'LEGO';
      if (pd.image) p.images.push(pd.image.replace(/\\/g, ''));
    } catch(e) {}
  }

  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      let ld = JSON.parse(m[1]);
      if (Array.isArray(ld)) ld = ld[0];
      if (!ld || ld['@type'] !== 'Product') continue;
      if (!p.name    && ld.name)    p.name    = ld.name;
      if (!p.sku     && ld.sku)     p.sku     = ld.sku;
      if (!p.barcode && ld.gtin13)  p.barcode = ld.gtin13;
      if (ld.description)           p.description = ld.description.trim();
      if (ld.offers) {
        const off = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
        if (!p.price_try && off.price) p.price_try = parseFloat(off.price);
      }
      if (ld.image) {
        const imgs = Array.isArray(ld.image) ? ld.image : [ld.image];
        for (const img of imgs) {
          const clean = img.replace(/\\/g, '');
          if (!p.images.includes(clean)) p.images.push(clean);
        }
      }
      if (!p.category && ld.category) {
        const parts = ld.category.split('>');
        p.category = parts[parts.length - 1].trim();
      }
      break;
    } catch(e) {}
  }

  for (const m of html.matchAll(/href="(https:\/\/lego\.witcdn\.net[^"]+(?:-B|-O)\.jpg)"/g)) {
    const img = m[1].replace(/-[BK]\.jpg$/, '-O.jpg');
    if (!p.images.includes(img)) p.images.push(img);
  }

  const dim = p.description.match(/yüksekliği\s+(\d+)\s*cm.*?genişliği\s+(\d+)\s*cm.*?derinliği\s+(\d+)\s*cm/i);
  if (dim) p.dimensions = { height: dim[1], width: dim[2], length: dim[3] };

  const parça = html.match(/<strong>(\d+)<\/strong>\s*<span[^>]*>Parça<\/span>/);
  if (parça) p.attributes['Parça Sayısı'] = parça[1];

  p.images = [...new Set(p.images.filter(Boolean))];
  return (p.name || p.sku) ? p : null;
}

// ─── XML helpers ──────────────────────────────────────────────────────────────
function xe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function htmlDecode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
    .replace(/\\u00ae/gi, '®')
    .replace(/\\u([0-9a-f]{4})/gi, (_, c) => String.fromCharCode(parseInt(c, 16)));
}

function buildProductXml(p, idx) {
  const imgsXml = p.images.map((img, i) =>
    `\n      <image position="${i}">${xe(img)}</image>`
  ).join('');

  const attrsXml = Object.entries(p.attributes).map(([name, val]) => `
    <attribute>
      <n>${xe(name)}</n>
      <value>${xe(val)}</value>
      <visible>1</visible>
      <variation>0</variation>
    </attribute>`).join('');

  return `
  <item>
    <title>${xe(p.name)}</title>
    <sku>${xe(p.sku)}</sku>
    <regular_price>${p.price_try || 0}</regular_price>
    <stock_status>${(p.available && p.quantity > 0) ? 'instock' : 'outofstock'}</stock_status>
    <manage_stock>1</manage_stock>
    <stock_quantity>${p.quantity}</stock_quantity>
    <description><![CDATA[${p.description.replace(/\n/g, '<br />')}]]></description>
    <short_description><![CDATA[${p.description.slice(0, 400)}]]></short_description>
    <category>${xe(p.category || 'LEGO')}</category>
    <images>${imgsXml}
    </images>
    <attributes>${attrsXml}
    </attributes>
    <meta_data>
      <meta><key>_lego_source_url</key><value>${xe(p.source_url)}</value></meta>
      <meta><key>_external_stock_url</key><value>${xe(p.source_url)}</value></meta>
      <meta><key>lir_price</key><value>${Math.round(p.price_try || 0)}</value></meta>
      <meta><key>_lego_barcode</key><value>${xe(p.barcode)}</value></meta>
      <meta><key>_lego_gallery_urls</key><value>${xe(p.images.join('|'))}</value></meta>
      <meta><key>_lego_local_folder</key><value>${xe(p.sku || p.source_url.split('/').pop().slice(0,50))}</value></meta>
    </meta_data>
  </item>`;
}

function wrapXml(products) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- WooCommerce Product Import — lego.tr — ${new Date().toISOString()} -->
<!-- تعداد محصولات: ${products.length} -->
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>LEGO.tr Products</title>
  <link>https://lego.tr</link>
${products.map((p, i) => buildProductXml(p, i)).join('\n')}
</channel>
</rss>`;
}

// ─── ذخیره خروجی‌ها ──────────────────────────────────────────────────────────
function saveOutput(products) {
  fs.mkdirSync(CONFIG.output_dir, { recursive: true });

  const xml     = wrapXml(products);
  const xmlPath = path.join(CONFIG.output_dir, 'lego-latest.xml');
  fs.writeFileSync(xmlPath, xml, 'utf8');

  const jsonPath = path.join(CONFIG.output_dir, 'lego-latest.json');
  fs.writeFileSync(jsonPath, JSON.stringify(products, null, 2), 'utf8');

  console.log(`\n✅ XML  → ${xmlPath}`);
  console.log(`✅ JSON → ${jsonPath}`);
}

// ─── اسکرپ کتگوری ────────────────────────────────────────────────────────────
async function scrapeCategory(catUrl, downloadImages = true) {
  console.log(`\n📂 ${catUrl}`);

  let firstHtml;
  try { firstHtml = await fetchHTML(catUrl, 4000); }
  catch(e) { console.error(`  ❌ ${e.message}`); return []; }

  const totalPages = Math.min(getTotalPages(firstHtml), CONFIG.max_pages);
  console.log(`  📄 ${totalPages} صفحه`);

  const allUrls = new Set();
  extractProductUrls(firstHtml).forEach(u => allUrls.add(u));

  for (let pg = 2; pg <= totalPages; pg++) {
    await sleep(CONFIG.delay_ms);
    const pageUrl = `${catUrl}${catUrl.includes('?') ? '&' : '?'}pg=${pg}`;
    try {
      const html = await fetchHTML(pageUrl, 3000);
      extractProductUrls(html).forEach(u => allUrls.add(u));
      console.log(`  📄 صفحه ${pg}: ${allUrls.size} محصول تا اینجا`);
    } catch(e) {
      console.error(`  ❌ صفحه ${pg}: ${e.message}`);
    }
  }

  console.log(`  🔗 ${allUrls.size} URL یکتا`);

  const products = [];
  const urls     = [...allUrls];

  for (let i = 0; i < urls.length; i++) {
    const productUrl = urls[i];
    process.stdout.write(`  [${i+1}/${urls.length}] ${productUrl.split('/').pop().slice(0, 45)} ... `);
    await sleep(CONFIG.delay_ms);

    try {
      const html    = await fetchHTML(productUrl, 3000);
      const product = parseProductPage(html, productUrl);

      if (product) {
        // دانلود تصاویر
        if (downloadImages && product.images.length > 0) {
          process.stdout.write(`📸 ${product.images.length} تصویر ... `);
          const downloaded = await downloadProductImages(product);
          console.log(`✅ ${product.sku} | ${downloaded.length}/${product.images.length} تصویر | ${product.quantity} موجود`);
        } else {
          console.log(`✅ ${product.sku} | ${product.quantity} موجود`);
        }
        products.push(product);
      } else {
        console.log(`⚠️  اطلاعات پیدا نشد`);
      }
    } catch(e) {
      console.log(`❌ ${e.message}`);
    }

    // ذخیره موقت هر ۲۰ محصول
    if (products.length > 0 && products.length % 20 === 0) {
      saveOutput(products);
    }
  }

  return products;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2);
  const get       = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };
  const hasFlag   = flag => args.includes(flag);

  if (get('--output'))  CONFIG.output_dir = get('--output');
  if (get('--delay'))   CONFIG.delay_ms   = parseInt(get('--delay')) || CONFIG.delay_ms;
  CONFIG.images_dir = path.join(CONFIG.output_dir, 'images');

  // آیا تصاویر هم دانلود بشن؟ (پیش‌فرض: بله)
  const downloadImages = !hasFlag('--no-images');

  console.log('='.repeat(60));
  console.log('  🧱 LEGO.tr Scraper → XML + Images ZIP');
  console.log('='.repeat(60));
  if (downloadImages) {
    console.log('  📸 حالت: اسکرپ + دانلود تصاویر + ساخت ZIP');
  } else {
    console.log('  📄 حالت: فقط اسکرپ (بدون تصویر)');
  }

  let products = [];

  try {
    if (hasFlag('--product')) {
      const productUrl = get('--product');
      const html = await fetchHTML(productUrl, 3000);
      const p    = parseProductPage(html, productUrl);
      if (p) {
        if (downloadImages) await downloadProductImages(p);
        products = [p];
      }

    } else if (hasFlag('--url')) {
      products = await scrapeCategory(get('--url'), downloadImages);

    } else if (hasFlag('--all')) {
      for (const cat of CONFIG.categories) {
        const catProducts = await scrapeCategory(`${CONFIG.base_url}/${cat}`, downloadImages);
        products.push(...catProducts);
        await sleep(2000);
      }
      // حذف تکراری
      const seen = new Set();
      products = products.filter(p => {
        if (!p.sku || seen.has(p.sku)) return false;
        seen.add(p.sku);
        return true;
      });

    } else {
      console.log(`
استفاده:
  node lego-scraper.js --product "https://lego.tr/43033-..."     یک محصول
  node lego-scraper.js --url "https://lego.tr/themes/lego-city"  یک کتگوری
  node lego-scraper.js --all                                      همه کتگوری‌ها

گزینه‌ها:
  --no-images    فقط XML بساز (بدون دانلود تصویر)
  --delay 1200   تاخیر به ms
  --output ./out پوشه خروجی
      `);
      process.exit(0);
    }

    if (products.length === 0) {
      console.error('\n❌ هیچ محصولی اسکرپ نشد.');
      process.exit(1);
    }

    // ذخیره XML و JSON
    saveOutput(products);

    // ساخت ZIP تصاویر
    if (downloadImages) {
      console.log('\n📦 در حال ساخت ZIP تصاویر...');
      createImagesZip();
    }

    // آمار نهایی
    const totalImages = products.reduce((s, p) => s + p.images.length, 0);
    const imagesDir   = CONFIG.images_dir;
    let downloadedCount = 0;
    if (fs.existsSync(imagesDir)) {
      const folders = fs.readdirSync(imagesDir);
      for (const folder of folders) {
        const fPath = path.join(imagesDir, folder);
        if (fs.statSync(fPath).isDirectory()) {
          downloadedCount += fs.readdirSync(fPath).length;
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ ${products.length} محصول اسکرپ شد`);
    if (downloadImages) {
      console.log(`📸 ${downloadedCount} تصویر دانلود شد (از ${totalImages} تصویر)`);
      console.log(`📦 ZIP: ${path.join(CONFIG.output_dir, 'lego-images.zip')}`);
    }
    console.log(`📄 XML: ${path.join(CONFIG.output_dir, 'lego-latest.xml')}`);
    console.log('='.repeat(60));

  } finally {
    await closeBrowser();
  }
}

main().catch(err => {
  console.error('❌', err.message);
  closeBrowser().finally(() => process.exit(1));
});
