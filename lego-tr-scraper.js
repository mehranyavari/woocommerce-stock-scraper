#!/usr/bin/env node
/**
 * lego-tr-scraper.js — اسکرپر مستقیم و هوشمند محصولات LEGO.tr
 *
 * قابلیت‌ها:
 *   ۱. اسکرپ مستقیم لینک‌های محصولات سایت از woo-products-lego.json (فوق‌سریع و بدون گشتن در دسته‌ها)
 *   ۲. استخراج دقیق قیمت قبل از تخفیف (Regular Price)
 *   ۳. تولید خروجی اختصاصی برای افزونه lego-updater.php (فایل output/lego-update.json)
 *
 * استفاده:
 *   node lego-tr-scraper.js                             → اسکرپ مستقیم محصولات woo-products-lego.json
 *   node lego-tr-scraper.js --file my-products.json     → اسکرپ از فایل دلخواه
 *   node lego-tr-scraper.js --theme star-wars           → اسکرپ یک تم خاص از سایت مبدا
 *   node lego-tr-scraper.js --crawl                     → اسکرپ کل سایت lego.tr
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ─── تنظیمات ──────────────────────────────────────────────────────────────────
const CONFIG = {
  base_url:      'https://lego.tr',
  themes_url:    'https://lego.tr/lego-temalar',
  products_file: 'woo-products-lego.json',
  delay_ms:      1000,
  max_pages:     50,
  output_dir:    './output',
  timeout:       60000,
  batch_save:    25,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── تبدیل قیمت ترکی ────────────────────────────────────────────────────────
function parseTurkishPrice(rawPrice) {
  if (!rawPrice) return 0;
  const str = String(rawPrice).trim();
  let clean = str.replace(/[^\d,\.]/g, '');
  const commaIdx = clean.lastIndexOf(',');
  const dotIdx = clean.lastIndexOf('.');

  if (dotIdx > commaIdx && commaIdx !== -1) {
    clean = clean.replace(/,/g, '');
  } else if (commaIdx > dotIdx && dotIdx !== -1) {
    clean = clean.replace(/\./g, '').replace(/,/g, '.');
  } else if (commaIdx !== -1 && dotIdx === -1) {
    clean = clean.replace(/,/g, '.');
  } else if (dotIdx !== -1 && commaIdx === -1) {
    if (clean.length - dotIdx === 4) {
      clean = clean.replace(/\./g, '');
    }
  }

  const num = parseFloat(clean);
  return isNaN(num) ? 0 : Math.round(num);
}

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

// ─── واکشی صفحه ─────────────────────────────────────────────────────────────
async function fetchPage(targetUrl, waitMs = 2500) {
  const b    = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    // جلوگیری از دانلود تصاویر و فونت‌ها برای حداکثر سرعت
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    await sleep(waitMs);

    return await page.content();
  } finally {
    await page.close();
  }
}

// ─── استخراج مشخصات یک محصول از HTML ──────────────────────────────────────────
function parseProductDetails(html, sourceUrl, defaultSku = '', productId = null) {
  const p = {
    id:          defaultSku || '',
    product_id:  productId,
    name:        '',
    sku:         defaultSku || '',
    price:       0,
    offer_price: null,
    quantity:    0,
    in_stock:    false,
    url:         sourceUrl,
    category:    'LEGO',
  };

  // ۱. بررسی PRODUCT_DATA
  let pd = null;
  const pdM = html.match(/PRODUCT_DATA\.push\(JSON\.parse\('(.+?)'\)\)/s);
  if (pdM) {
    try {
      const decoded = pdM[1]
        .replace(/\\\\"/g, '\x00DQ\x00')
        .replace(/\\"/g, '"')
        .replace(/\x00DQ\x00/g, '\\"')
        .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
      pd = JSON.parse(decoded);
      p.name     = pd.name ? String(pd.name).replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : '';
      p.sku      = pd.code || p.sku;
      p.id       = p.sku || String(pd.id || '');
      p.quantity = typeof pd.quantity === 'number' ? pd.quantity : 0;
      p.in_stock = p.quantity > 0 || !!pd.available;
      p.category = pd.category || pd.brand || 'LEGO';
    } catch(e) {}
  }

  // ۲. استخراج قیمت قبل از تخفیف (Regular Price)
  // اولویت اول: تگ product-price-not-discounted
  const notDiscountedMatch = html.match(/class=["'][^"']*product-price-not-discounted[^"']*["'][^>]*>([\d\.,]+)<\/span>/i) ||
                             html.match(/class=["'][^"']*product-discounted-price[^"']*["'][^>]*>[\s\S]*?([\d\.,]+)\s*(?:TL)?[\s\S]*?<\/div>/i);
  if (notDiscountedMatch) {
    p.price = parseTurkishPrice(notDiscountedMatch[1]);
  }

  // اولویت دوم: PRODUCT_DATA برای total_base_price / old_price / price
  if (!p.price && pd) {
    p.price = parseTurkishPrice(pd.total_base_price || pd.base_price || pd.old_price || pd.total_price || pd.price);
  }

  // در صورت عدم وجود تخفیف:
  if (!p.price) {
    if (pd && (pd.total_sale_price || pd.sale_price)) {
      p.price = parseTurkishPrice(pd.total_sale_price || pd.sale_price);
    } else {
      const priceMatch = html.match(/class=["'][^"']*product-price[^"']*["'][^>]*>([\d\.,]+)/i);
      if (priceMatch) {
        p.price = parseTurkishPrice(priceMatch[1]);
      }
    }
  }

  // اگر نام هنوز پر نشده
  if (!p.name) {
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (titleMatch) {
      p.name = titleMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  return p;
}

// ─── استخراج محصولات از صفحات کتگوری ──────────────────────────────────────────
function extractProductsFromCategory(html) {
  const products = [];
  const seen     = new Set();
  const pattern  = /PRODUCT_DATA\.push\(JSON\.parse\('(.+?)'\)\)/g;
  let   m;

  while ((m = pattern.exec(html)) !== null) {
    try {
      const decoded = m[1]
        .replace(/\\\\"/g, '\x00DQ\x00')
        .replace(/\\"/g,   '"')
        .replace(/\x00DQ\x00/g, '\\"')
        .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g,   (_, c) => String.fromCharCode(parseInt(c, 16)));

      const d  = JSON.parse(decoded);
      const id = String(d.code || d.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const qty   = parseInt(d.quantity ?? 0, 10);
      const price = Math.round(parseFloat(d.total_base_price ?? d.base_price ?? d.total_price ?? d.price ?? d.total_sale_price ?? d.sale_price ?? 0));

      products.push({
        id,
        sku:      id,
        name:     String(d.name || '').replace(/\s+/g, ' ').trim(),
        price,
        quantity: qty,
        in_stock: qty > 0,
        category: String(d.category || d.brand || '').trim(),
        url:      d.url ? (d.url.startsWith('http') ? d.url : CONFIG.base_url + '/' + d.url) : '',
      });
    } catch (_) {}
  }

  return products;
}

// ─── ذخیره خروجی‌ها ────────────────────────────────────────────────────────────
function saveOutput(products) {
  fs.mkdirSync(CONFIG.output_dir, { recursive: true });

  // ۱. فایل مخصوص آپلود در افزونه ووکامرس (lego-updater.php)
  const updatePayload = products.map(p => ({
    id:         p.id || p.sku,
    product_id: p.product_id || null,
    price:      p.price,
    in_stock:   p.in_stock,
    quantity:   p.quantity,
    name:       p.name,
  }));
  const updatePath = path.join(CONFIG.output_dir, 'lego-update.json');
  fs.writeFileSync(updatePath, JSON.stringify(updatePayload, null, 2), 'utf8');

  // ۲. فایل کامل
  const fullPath = path.join(CONFIG.output_dir, 'lego-products-full.json');
  fs.writeFileSync(fullPath, JSON.stringify(products, null, 2), 'utf8');

  // ۳. فایل خلاصه
  const summary = {};
  for (const p of products) {
    summary[p.id || p.sku] = {
      id:       p.id || p.sku,
      name:     p.name,
      price:    p.price,
      in_stock: p.in_stock,
      quantity: p.quantity,
    };
  }
  const summaryPath = path.join(CONFIG.output_dir, 'lego-stock-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  // ۴. فایل CSV اکسل
  const csvLines = [
    'ID,SKU,Fiyat (TL),Stok,Adet,Ürün Adı,URL',
    ...products.map(p => [
      p.product_id || '',
      p.sku || p.id,
      p.price,
      p.in_stock ? 'Mevcut' : 'Tükendi',
      p.quantity,
      `"${(p.name || '').replace(/"/g, '""')}"`,
      `"${p.url || ''}"`,
    ].join(',')),
  ];
  const csvPath = path.join(CONFIG.output_dir, 'lego-products.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');

  return { updatePath, fullPath, summaryPath, csvPath };
}

// ─── اسکرپ مستقیم بر اساس لینک‌های فایل ووکامرس ──────────────────────────────
async function scrapeDirectFromProducts(items) {
  console.log(`\n🚀 شروع اسکرپ مستقیم ${items.length} محصول از لیست سایت...\n`);
  const results = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const url  = item.url || item.source_url || (typeof item === 'string' ? item : '');
    const sku  = item.sku || item.id || '';
    const pid  = item.id && typeof item.id === 'number' ? item.id : (item.product_id || null);

    if (!url || !url.startsWith('http')) {
      console.log(`  [${i + 1}/${items.length}] ⚠️ لینک نامعتبر برای SKU: ${sku}`);
      continue;
    }

    process.stdout.write(`  [${i + 1}/${items.length}] #${sku || pid} ... `);

    try {
      const html = await fetchPage(url, 2000);
      const data = parseProductDetails(html, url, sku, pid);

      if (item.title && !data.name) data.name = item.title;
      results.push(data);

      const stockStr = data.in_stock ? `✅ موجود (${data.quantity})` : `❌ ناموجود`;
      console.log(`${data.price} TL | ${stockStr}`);

    } catch (err) {
      console.log(`❌ خطا: ${err.message}`);
      // ذخیره رکورد با وضعیت ناموجود در صورت خطا
      results.push({
        id:         sku || (pid ? String(pid) : ''),
        product_id: pid,
        name:       item.title || '',
        sku:        sku,
        price:      0,
        quantity:   0,
        in_stock:   false,
        url:        url,
        error:      err.message
      });
    }

    // ذخیره مقطعی برای امنیت اطلاعات
    if ((i + 1) % CONFIG.batch_save === 0) {
      saveOutput(results);
    }

    await sleep(CONFIG.delay_ms);
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args    = process.argv.slice(2);
  const get     = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const hasFlag = flag => args.includes(flag);

  if (get('--out'))   CONFIG.output_dir = get('--out');
  if (get('--delay')) CONFIG.delay_ms   = parseInt(get('--delay'), 10) || CONFIG.delay_ms;

  console.log('='.repeat(65));
  console.log('  🧱 LEGO.tr اسکرپر اختصاصی بروزرسانی قیمت و موجودی');
  console.log('='.repeat(65));

  // بررسی اول: آیا فایل لینک‌های ووکامرس وجود دارد؟
  const customFile = get('--file') || get('--list');
  const targetFile = customFile || (fs.existsSync(CONFIG.products_file) ? CONFIG.products_file : null);

  let allProducts = [];

  try {
    if (targetFile && fs.existsSync(targetFile) && !hasFlag('--crawl')) {
      console.log(`📂 فایل ورودی محصولات سایت پیدا شد: ${targetFile}`);
      const raw = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      const items = Array.isArray(raw) ? raw : (raw.products || []);

      if (items.length > 0) {
        allProducts = await scrapeDirectFromProducts(items);
      } else {
        console.error('❌ لیست محصولات در فایل خالی است.');
      }

    } else if (hasFlag('--theme')) {
      const themeUrl = `${CONFIG.base_url}/themes/${get('--theme')}`;
      console.log(`🔍 اسکرپ تم: ${themeUrl}`);
      // اجرای حالت تم
      const html = await fetchPage(themeUrl, 3000);
      allProducts = extractProductsFromCategory(html);

    } else {
      console.log(`ℹ️ فایل ${CONFIG.products_file} یافت نشد. در حال اجرای اسکرپ تم‌ها...`);
      const html = await fetchPage(CONFIG.themes_url, 3000);
      const urls = new Set();
      for (const m of html.matchAll(/href="(?:https:\/\/lego\.tr)?(\/themes\/[a-z0-9\-]+)"/gi)) {
        urls.add(CONFIG.base_url + m[1]);
      }
      for (const tUrl of urls) {
        try {
          const tHtml = await fetchPage(tUrl, 2500);
          allProducts.push(...extractProductsFromCategory(tHtml));
        } catch (e) {}
        await sleep(CONFIG.delay_ms);
      }
    }

    if (allProducts.length === 0) {
      console.error('\n❌ هیچ محصولی اسکرپ نشد.');
      process.exit(1);
    }

    const paths = saveOutput(allProducts);
    console.log('\n' + '='.repeat(65));
    console.log(`🎉 پایان اسکرپ! ${allProducts.length} محصول با موفقیت استخراج شد.`);
    console.log(`🚀 فایل آماده آپلود در افزونه سایت → ${paths.updatePath}`);
    console.log(`✅ فایل کامل                    → ${paths.fullPath}`);
    console.log(`✅ فایل CSV اکسل               → ${paths.csvPath}`);
    console.log('='.repeat(65));

  } finally {
    await closeBrowser();
  }
}

main().catch(err => {
  console.error('❌ خطا در اجرا:', err.message);
  closeBrowser().finally(() => process.exit(1));
});
