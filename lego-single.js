#!/usr/bin/env node
/**
 * lego-single.js — دریافت اطلاعات یک محصول از lego.tr + دانلود تصاویر + ZIP
 * استفاده: node lego-single.js "https://lego.tr/43033-..."
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const http         = require('http');
const { execSync } = require('child_process');

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Browser ──────────────────────────────────────────────────────────────────
async function fetchHTML(targetUrl) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });
  const page = await browser.newPage();
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
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    return await page.content();
  } finally {
    await page.close();
    await browser.close();
  }
}

// ─── دانلود فایل ─────────────────────────────────────────────────────────────
function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const lib  = fileUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const req  = lib.get(fileUrl, {
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
    req.on('error', err => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ─── دانلود تصاویر محصول ─────────────────────────────────────────────────────
async function downloadProductImages(product) {
  if (!product.images || product.images.length === 0) return [];

  const folderName    = product.sku || product.source_url.split('/').pop().slice(0, 50);
  const productImgDir = path.join(IMAGES_DIR, folderName);
  fs.mkdirSync(productImgDir, { recursive: true });

  const downloaded = [];
  for (let i = 0; i < product.images.length; i++) {
    const imgUrl   = product.images[i];
    const ext      = path.extname(imgUrl.split('?')[0]) || '.jpg';
    const destPath = path.join(productImgDir, `${i + 1}${ext}`);
    try {
      await downloadFile(imgUrl, destPath);
      downloaded.push(destPath);
      console.log(`  📸 تصویر ${i + 1}/${product.images.length} دانلود شد`);
      await sleep(200);
    } catch(e) {
      console.warn(`  ⚠️  تصویر ${i + 1} خطا: ${e.message}`);
    }
  }
  return downloaded;
}

// ─── ساخت ZIP ────────────────────────────────────────────────────────────────
function createZip(slug) {
  const zipPath = path.join(OUTPUT_DIR, `${slug}-images.zip`);
  try {
    execSync(`cd "${OUTPUT_DIR}" && zip -r "${slug}-images.zip" "images/"`, {
      stdio: 'pipe', timeout: 120000,
    });
    const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    console.log(`📦 ZIP: ${zipPath} (${sizeMB} MB)`);
    return zipPath;
  } catch(e) {
    console.error('خطا در ساخت ZIP:', e.message);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function htmlDecode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
    .replace(/\\u00ae/gi, '®')
    .replace(/\\u([0-9a-f]{4})/gi, (_, c) => String.fromCharCode(parseInt(c, 16)));
}

function xe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// ─── Parser ──────────────────────────────────────────────────────────────────
function parseProductPage(html, sourceUrl) {
  const p = {
    source_url: sourceUrl, name: '', sku: '', barcode: '', description: '',
    price_try: 0, quantity: 0, images: [], category: '', brand: 'LEGO',
    available: false, attributes: {}, dimensions: { length: '', width: '', height: '' },
    age: '', parts: '', item_no: '',
  };

  const pdM = html.match(/PRODUCT_DATA\.push\(JSON\.parse\('(.+?)'\)\)/s);
  if (pdM) {
    try {
      const pd = JSON.parse(pdM[1].replace(/\\'/g, "'"));
      p.name      = pd.name             ? htmlDecode(pd.name) : '';
      p.sku       = pd.code             || '';
      p.barcode   = pd.supplier_code    || '';
      p.price_try = pd.total_sale_price || pd.total_price || 0;
      p.quantity  = typeof pd.quantity === 'number' ? pd.quantity : 0;
      p.available = !!pd.available;
      p.category  = pd.category         ? htmlDecode(pd.category) : '';
      p.brand     = pd.brand            || 'LEGO';
      if (pd.image) p.images.push(pd.image.replace(/\\/g, ''));
    } catch(e) {}
  }

  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      let ld = JSON.parse(m[1]);
      if (Array.isArray(ld)) ld = ld[0];
      if (!ld || ld['@type'] !== 'Product') continue;
      if (!p.name    && ld.name)   p.name    = ld.name;
      if (!p.sku     && ld.sku)    p.sku     = ld.sku;
      if (!p.barcode && ld.gtin13) p.barcode = ld.gtin13;
      if (ld.description)          p.description = ld.description.trim();
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
  if (parça) p.parts = parça[1];

  const yaş = html.match(/<strong>(\d+\+?)<\/strong>\s*<span[^>]*>Yaş<\/span>/);
  if (yaş) p.age = yaş[1];

  const öğe = html.match(/<strong>(\d{4,6})<\/strong>\s*<span[^>]*>Öğe<\/span>/);
  if (öğe) p.item_no = öğe[1];

  p.images = [...new Set(p.images.filter(Boolean))];
  return (p.name || p.sku) ? p : null;
}

// ─── XML Builder ─────────────────────────────────────────────────────────────
function buildXml(p) {
  const imgsXml = p.images.map((img, i) =>
    `\n      <image position="${i}">${xe(img)}</image>`
  ).join('');
  const instock = p.available && p.quantity > 0;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- WooCommerce Product Import — lego.tr — ${new Date().toISOString()} -->
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>LEGO.tr Products</title>
  <link>https://lego.tr</link>
  <item>
    <title>${xe(p.name)}</title>
    <sku>${xe(p.sku)}</sku>
    <regular_price>${p.price_try || 0}</regular_price>
    <stock_status>${instock ? 'instock' : 'outofstock'}</stock_status>
    <manage_stock>1</manage_stock>
    <stock_quantity>${p.quantity}</stock_quantity>
    <description><![CDATA[${p.description.replace(/\n/g, '<br />')}]]></description>
    <short_description><![CDATA[${p.description.slice(0, 400)}]]></short_description>
    <category>${xe(p.category || 'LEGO')}</category>
    <brand>${xe(p.brand || 'LEGO')}</brand>
    <images>${imgsXml}
    </images>
    <meta_data>
      <meta><key>_lego_source_url</key><value>${xe(p.source_url)}</value></meta>
      <meta><key>_external_stock_url</key><value>${xe(p.source_url)}</value></meta>
      <meta><key>lir_price</key><value>${Math.round(p.price_try || 0)}</value></meta>
      <meta><key>_lego_barcode</key><value>${xe(p.barcode)}</value></meta>
      <meta><key>_lego_gallery_urls</key><value>${xe(p.images.join('|'))}</value></meta>
      <meta><key>_lego_age</key><value>${xe(p.age)}</value></meta>
      <meta><key>_lego_parts</key><value>${xe(p.parts)}</value></meta>
      <meta><key>_lego_item_no</key><value>${xe(p.item_no)}</value></meta>
      <meta><key>_lego_dim_height</key><value>${xe(p.dimensions.height)}</value></meta>
      <meta><key>_lego_dim_width</key><value>${xe(p.dimensions.width)}</value></meta>
      <meta><key>_lego_dim_length</key><value>${xe(p.dimensions.length)}</value></meta>
    </meta_data>
  </item>
</channel>
</rss>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const productUrl = process.argv[2] || process.env.PRODUCT_URL;

  if (!productUrl) {
    console.error('❌ لینک محصول را وارد کنید:');
    console.error('   node lego-single.js "https://lego.tr/43033-..."');
    process.exit(1);
  }

  console.log(`🔍 در حال دریافت: ${productUrl}`);

  let html;
  try {
    html = await fetchHTML(productUrl);
  } catch(e) {
    console.error('❌ خطا در دریافت صفحه:', e.message);
    process.exit(1);
  }

  const product = parseProductPage(html, productUrl);
  if (!product) {
    console.error('❌ اطلاعات محصول پیدا نشد.');
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const slug    = product.sku || productUrl.split('/').pop().slice(0, 50);
  const xmlPath = path.join(OUTPUT_DIR, `${slug}.xml`);
  fs.writeFileSync(xmlPath, buildXml(product), 'utf8');

  // دانلود تصاویر
  console.log(`\n📸 در حال دانلود ${product.images.length} تصویر...`);
  const downloaded = await downloadProductImages(product);

  // ساخت ZIP
  let zipPath = null;
  if (downloaded.length > 0) {
    console.log('\n📦 در حال ساخت ZIP...');
    zipPath = createZip(slug);
  }

  // لاگ نهایی
  console.log('\n' + '='.repeat(50));
  console.log(`✅ نام:       ${product.name}`);
  console.log(`✅ SKU:       ${product.sku}`);
  console.log(`✅ قیمت:      ${product.price_try} ₺`);
  console.log(`✅ موجودی:    ${product.quantity}`);
  console.log(`✅ تصاویر:    ${downloaded.length}/${product.images.length}`);
  console.log(`✅ XML:       ${xmlPath}`);
  if (zipPath) console.log(`✅ ZIP:       ${zipPath}`);
  console.log('='.repeat(50));

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `sku=${product.sku}\n` +
      `name=${product.name}\n` +
      `price=${product.price_try}\n` +
      `xml_file=${xmlPath}\n` +
      `zip_file=${zipPath || ''}\n`
    );
  }

  // GitHub Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 🧱 محصول دریافت شد

| فیلد | مقدار |
|------|-------|
| نام | ${product.name} |
| SKU | ${product.sku} |
| قیمت | ${product.price_try} ₺ |
| موجودی | ${product.quantity} |
| دسته‌بندی | ${product.category} |
| سن | ${product.age || '—'} |
| تعداد قطعات | ${product.parts || '—'} |
| تصاویر دانلود شده | ${downloaded.length} از ${product.images.length} |
| فایل XML | \`${slug}.xml\` |
| فایل ZIP | \`${slug}-images.zip\` |
`);
  }
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
