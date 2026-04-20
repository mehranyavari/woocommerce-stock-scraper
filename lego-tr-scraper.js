#!/usr/bin/env node
/**
 * lego-tr-scraper.js
 * lego.tr — tüm kategoriler, fiyat + stok durumu
 *
 * Kurulum:
 *   npm install puppeteer-extra puppeteer-extra-plugin-stealth
 *
 * Kullanım:
 *   node lego-tr-scraper.js                    → Tüm kategoriler
 *   node lego-tr-scraper.js --theme star-wars   → Tek kategori
 *   node lego-tr-scraper.js --out ./output      → Çıktı klasörü
 *   node lego-tr-scraper.js --delay 1200        → İstek arası bekleme (ms)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ─── Ayarlar ──────────────────────────────────────────────────────────────────
const CONFIG = {
  base_url:   'https://lego.tr',
  themes_url: 'https://lego.tr/lego-temalar',
  delay_ms:   1200,
  max_pages:  50,
  output_dir: './output',
  timeout:    60000,
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

// ─── Sayfa getir ──────────────────────────────────────────────────────────────
async function fetchPage(targetUrl, waitMs = 3000) {
  const b    = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    // Gereksiz kaynakları engelle — sadece HTML lazım
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

// ─── HTML'den ürünleri çıkar ──────────────────────────────────────────────────
function extractProducts(html) {
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
      const price = Math.round(parseFloat(d.total_sale_price ?? d.total_base_price ?? d.sale_price ?? 0));

      products.push({
        id,
        name:     String(d.name || '').replace(/\s+/g, ' ').trim(),
        price,
        quantity: qty,
        in_stock: qty > 0,
        category: String(d.category || d.brand || '').trim(),
        url:      d.url
          ? (d.url.startsWith('http') ? d.url : CONFIG.base_url + '/' + d.url)
          : '',
      });
    } catch (_) { /* hatalı girişi atla */ }
  }

  return products;
}

// ─── Tema URL'lerini çek ──────────────────────────────────────────────────────
async function fetchThemeUrls() {
  console.log(`\n🔍 Tema listesi alınıyor...`);
  const html = await fetchPage(CONFIG.themes_url, 3000);

  const urls = new Set();
  for (const m of html.matchAll(/href="(?:https:\/\/lego\.tr)?(\/themes\/[a-z0-9\-]+)"/gi)) {
    urls.add(CONFIG.base_url + m[1]);
  }

  const result = [...urls];
  console.log(`✅ ${result.length} tema bulundu\n`);
  return result;
}

// ─── Bir kategoriyi tüm sayfalarıyla tara ─────────────────────────────────────
async function scrapeTheme(themeUrl) {
  const baseUrl     = themeUrl.split('?')[0].replace(/\/+$/, '');
  const allProducts = [];
  const seenIds     = new Set();

  console.log(`\n📂 ${baseUrl}`);

  for (let page = 1; page <= CONFIG.max_pages; page++) {
    const pageUrl = page === 1 ? baseUrl : `${baseUrl}?ps=${page}`;
    process.stdout.write(`  Sayfa ${page} ... `);

    let html;
    try {
      html = await fetchPage(pageUrl, 3000);
    } catch (err) {
      console.log(`❌ ${err.message}`);
      break;
    }

    const pageProducts = extractProducts(html);
    const fresh        = pageProducts.filter(p => !seenIds.has(p.id));
    fresh.forEach(p => seenIds.add(p.id));

    if (fresh.length === 0) {
      console.log(`(boş — son sayfa)`);
      break;
    }

    allProducts.push(...fresh);
    console.log(`${fresh.length} ürün  |  toplam: ${allProducts.length}`);

    await sleep(CONFIG.delay_ms);
  }

  return allProducts;
}

// ─── Kaydet ───────────────────────────────────────────────────────────────────
function saveOutput(products) {
  fs.mkdirSync(CONFIG.output_dir, { recursive: true });

  // Tam liste
  const fullPath = path.join(CONFIG.output_dir, 'lego-products-full.json');
  fs.writeFileSync(fullPath, JSON.stringify(products, null, 2), 'utf8');

  // Özet (id → stok/fiyat)
  const summary = {};
  for (const p of products) {
    summary[p.id] = {
      id:       p.id,
      name:     p.name,
      price:    p.price,
      in_stock: p.in_stock,
      quantity: p.quantity,
      category: p.category,
    };
  }
  const summaryPath = path.join(CONFIG.output_dir, 'lego-stock-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  // CSV
  const csvLines = [
    'ID,Fiyat (TL),Stok,Adet,Kategori,Ürün Adı',
    ...products.map(p => [
      p.id,
      p.price,
      p.in_stock ? 'Mevcut' : 'Tükendi',
      p.quantity,
      `"${p.category.replace(/"/g, '""')}"`,
      `"${p.name.replace(/"/g, '""')}"`,
    ].join(',')),
  ];
  const csvPath = path.join(CONFIG.output_dir, 'lego-products.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');

  return { fullPath, summaryPath, csvPath };
}

// ─── İstatistik ───────────────────────────────────────────────────────────────
function printStats(products) {
  const total    = products.length;
  const inStock  = products.filter(p => p.in_stock).length;
  const avgPrice = total
    ? Math.round(products.reduce((s, p) => s + p.price, 0) / total)
    : 0;

  const byCat = {};
  for (const p of products) byCat[p.category] = (byCat[p.category] || 0) + 1;

  const catLines = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `    ${cat}: ${n}`)
    .join('\n');

  console.log(`
${'='.repeat(60)}
📊 SONUÇ
${'='.repeat(60)}
  Toplam ürün    : ${total}
  Mevcut (stokta): ${inStock}
  Tükendi        : ${total - inStock}
  Ortalama fiyat : ${avgPrice} TL

  Kategoriler:
${catLines}
${'='.repeat(60)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args    = process.argv.slice(2);
  const get     = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const hasFlag = flag => args.includes(flag);

  if (get('--out'))   CONFIG.output_dir = get('--out');
  if (get('--delay')) CONFIG.delay_ms   = parseInt(get('--delay'), 10) || CONFIG.delay_ms;

  console.log('='.repeat(60));
  console.log('  🧱 lego.tr Stok & Fiyat Takip Scripti');
  console.log('='.repeat(60));

  let allProducts = [];

  try {
    if (hasFlag('--theme')) {
      const themeUrl = `${CONFIG.base_url}/themes/${get('--theme')}`;
      allProducts    = await scrapeTheme(themeUrl);

    } else {
      const themeUrls = await fetchThemeUrls();

      for (let i = 0; i < themeUrls.length; i++) {
        console.log(`\n[${i + 1}/${themeUrls.length}]`);
        try {
          const products = await scrapeTheme(themeUrls[i]);
          allProducts.push(...products);
        } catch (err) {
          console.error(`  ❌ ${err.message}`);
        }
        await sleep(CONFIG.delay_ms);
      }

      // Tekrarlananları kaldır
      const seen = new Set();
      allProducts = allProducts.filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
    }

    if (allProducts.length === 0) {
      console.error('\n❌ Hiç ürün bulunamadı.');
      process.exit(1);
    }

    const paths = saveOutput(allProducts);
    console.log(`\n✅ Tam liste  → ${paths.fullPath}`);
    console.log(`✅ Stok özeti → ${paths.summaryPath}`);
    console.log(`✅ CSV        → ${paths.csvPath}`);

    printStats(allProducts);

  } finally {
    await closeBrowser();
  }
}

main().catch(err => {
  console.error('❌', err.message);
  closeBrowser().finally(() => process.exit(1));
});
