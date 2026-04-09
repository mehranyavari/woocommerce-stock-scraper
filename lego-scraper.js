#!/usr/bin/env node
/**
 * lego-scraper.js
 * اسکرپر محصولات lego.tr
 * خروجی: فایل XML استاندارد WooCommerce برای import مستقیم
 *
 * نصب: npm install axios
 * اجرا: node lego-scraper.js --url "https://lego.tr/themes/lego-city"
 *    یا: node lego-scraper.js --product "https://lego.tr/43033-xxx"
 *    یا: node lego-scraper.js --all   (همه کتگوری‌ها)
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

// ─── تنظیمات ──────────────────────────────────────────────────────────────────
const CONFIG = {
  base_url:    'https://lego.tr',
  delay_ms:    800,          // تاخیر بین درخواست‌ها (میلی‌ثانیه)
  max_pages:   50,           // حداکثر صفحات هر کتگوری
  output_dir:  './output',   // پوشه خروجی
  user_agent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  timeout:     20000,

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

// ─── Helper: HTTP GET ──────────────────────────────────────────────────────────
function fetchHTML(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new url.URL(targetUrl);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   'GET',
      timeout:  CONFIG.timeout,
      headers: {
        'User-Agent':      CONFIG.user_agent,
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection':      'keep-alive',
      }
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchHTML(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end',  ()    => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error',   err => reject(err));
    req.end();
  });
}

// ─── تاخیر ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // ── ۱. PRODUCT_DATA (اصلی‌ترین منبع) ────────────────────────────────────
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
    } catch(e) { /* devam */ }
  }

  // ── ۲. JSON-LD (توضیحات + تصاویر + قیمت دقیق) ──────────────────────────
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

      // قیمت
      if (ld.offers) {
        const offers = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
        if (!product.price_try && offers.price) {
          product.price_try = parseFloat(offers.price);
        }
      }

      // تصاویر
      if (ld.image) {
        const imgs = Array.isArray(ld.image) ? ld.image : [ld.image];
        for (const img of imgs) {
          const cleanImg = img.replace(/\\/g, '');
          if (!product.images.includes(cleanImg)) product.images.push(cleanImg);
        }
      }

      // دسته‌بندی
      if (!product.category && ld.category) {
        const parts = ld.category.split('>');
        product.category = parts[parts.length - 1].trim();
        if (parts.length > 1) {
          product.category_path = parts.slice(0, -1).map(p => p.trim()).join(' > ');
        }
      }
      break;
    } catch(e) { /* skip */ }
  }

  // ── ۳. تصاویر گالری ─────────────────────────────────────────────────────
  const galleryRe = /data-id="0"\s+href="(https:\/\/lego\.witcdn\.net[^"]+(?:-B|-O)\.jpg)"/g;
  for (const m of html.matchAll(galleryRe)) {
    const oImg = m[1].replace(/-[BK]\.jpg$/, '-O.jpg');
    if (!product.images.includes(oImg)) product.images.push(oImg);
  }

  // ── ۴. ابعاد از توضیحات ─────────────────────────────────────────────────
  // "yüksekliği 21 cm, genişliği 14 cm, derinliği 8 cm"
  if (product.description) {
    const dimMatch = product.description.match(/yüksekliği\s+(\d+)\s*cm.*?genişliği\s+(\d+)\s*cm.*?derinliği\s+(\d+)\s*cm/i);
    if (dimMatch) {
      product.dimensions.height = dimMatch[1];
      product.dimensions.width  = dimMatch[2];
      product.dimensions.length = dimMatch[3];
    }
  }

  // ── ۵. تعداد قطعات (Parça) ──────────────────────────────────────────────
  const parcaMatch = html.match(/<strong>(\d+)<\/strong>\s*<span[^>]*>Parça<\/span>/);
  if (parcaMatch) {
    product.attributes['Parça Sayısı'] = parcaMatch[1];
  }

  // ── ۶. آیتم نامبر ──────────────────────────────────────────────────────
  const itemMatch = html.match(/<strong>(\d{5,6})<\/strong>\s*<span[^>]*>Öğe<\/span>/);
  if (itemMatch) {
    product.attributes['Set Numarası'] = itemMatch[1];
    if (!product.sku) product.sku = itemMatch[1];
  }

  // ── ۷. موجودی از hidden input (fallback) ────────────────────────────────
  if (!product.available) {
    const stockMatch = html.match(/id="product-stock-status"\s+value="(\d+)"/);
    if (stockMatch) product.available = parseInt(stockMatch[1]) > 0;
  }
  if (product.quantity === 0 && product.available) product.quantity = 1;

  // حذف تصاویر تکراری
  product.images = [...new Set(product.images.filter(Boolean))];

  // اعتبارسنجی
  if (!product.name && !product.sku) return null;

  return product;
}

// ─── استخراج URL محصولات از صفحه فهرست ───────────────────────────────────────
function extractProductUrlsFromListing(html) {
  const urls = new Set();

  // لینک‌های محصول: آدرس‌هایی که عدد ۴-۵ رقمی دارند و بعدش slug است
  const re = /href="(https:\/\/lego\.tr\/(\d{4,6})-[a-z0-9-]+)"/g;
  for (const m of html.matchAll(re)) {
    urls.add(m[1]);
  }

  // همچنین از card-link و product-link
  const re2 = /href="(\/(\d{4,6})-[a-z0-9-]+)"/g;
  for (const m of html.matchAll(re2)) {
    urls.add('https://lego.tr' + m[1]);
  }

  return [...urls];
}

// ─── گرفتن تعداد صفحات ─────────────────────────────────────────────────────
function getTotalPages(html) {
  const pageNums = [...html.matchAll(/[?&]pg=(\d+)/g)].map(m => parseInt(m[1]));
  return pageNums.length ? Math.max(...pageNums) : 1;
}

// ─── فرار از کاراکترهای XML ──────────────────────────────────────────────────
function xmlEscape(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // کنترل کاراکترها
}

// ─── HTML entities decode ────────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\\u00ae/gi, '®')
    .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// ─── ساخت XML یک محصول ──────────────────────────────────────────────────────
function buildProductXml(p, index) {
  // ساخت مسیر دسته‌بندی کامل
  let fullCategory = '';
  if (p.category_path && p.category) {
    fullCategory = `${p.category_path} > ${p.category}`;
  } else if (p.category) {
    fullCategory = p.category;
  } else {
    fullCategory = 'LEGO';
  }

  // تصاویر
  const mainImage    = p.images[0] || '';
  const galleryImgs  = p.images.slice(1).join(',');

  // توضیحات: تبدیل newline به <br>
  const descHtml = p.description
    ? p.description.replace(/\n/g, '<br />\n')
    : '';

  // متا attributes
  let metaXml = '';
  metaXml += `
      <wp:postmeta>
        <wp:meta_key><![CDATA[_lego_source_url]]></wp:meta_key>
        <wp:meta_value><![CDATA[${p.source_url}]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_external_stock_url]]></wp:meta_key>
        <wp:meta_value><![CDATA[${p.source_url}]]></wp:meta_value>
      </wp:postmeta>`;

  if (p.barcode) {
    metaXml += `
      <wp:postmeta>
        <wp:meta_key><![CDATA[_lego_barcode]]></wp:meta_key>
        <wp:meta_value><![CDATA[${p.barcode}]]></wp:meta_value>
      </wp:postmeta>`;
  }

  if (p.price_try) {
    metaXml += `
      <wp:postmeta>
        <wp:meta_key><![CDATA[lir_price]]></wp:meta_key>
        <wp:meta_value><![CDATA[${Math.round(p.price_try)}]]></wp:meta_value>
      </wp:postmeta>`;
  }

  // ابعاد
  if (p.dimensions.length) {
    metaXml += `
      <wp:postmeta>
        <wp:meta_key><![CDATA[_length]]></wp:meta_key>
        <wp:meta_value><![CDATA[${p.dimensions.length}]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_width]]></wp:meta_key>
        <wp:meta_value><![CDATA[${p.dimensions.width}]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_height]]></wp:meta_key>
        <wp:meta_value><![CDATA[${p.dimensions.height}]]></wp:meta_value>
      </wp:postmeta>`;
  }

  // گالری تصاویر — WooCommerce آنها را از product_image_gallery می‌خواند
  // ولی در XML import باید به صورت attachment باشند.
  // راه‌حل: تصاویر رو در images[] می‌نویسیم، ووکامرس آنها را import می‌کند.

  const now = new Date().toISOString().replace('T', ' ').substr(0, 19);

  // Attributes
  let attrsXml = '';
  let attrIdx  = 1;
  for (const [key, val] of Object.entries(p.attributes)) {
    attrsXml += `
      <wp:postmeta>
        <wp:meta_key><![CDATA[attribute_${key.toLowerCase().replace(/\s+/g, '_')}]]></wp:meta_key>
        <wp:meta_value><![CDATA[${val}]]></wp:meta_value>
      </wp:postmeta>`;
  }

  return `
  <item>
    <title><![CDATA[${p.name}]]></title>
    <link>${xmlEscape(p.source_url)}</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <dc:creator><![CDATA[admin]]></dc:creator>
    <guid isPermaLink="false">${xmlEscape(p.source_url)}</guid>
    <description></description>
    <content:encoded><![CDATA[${descHtml}]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${10000 + index}</wp:post_id>
    <wp:post_date><![CDATA[${now}]]></wp:post_date>
    <wp:post_date_gmt><![CDATA[${now}]]></wp:post_date_gmt>
    <wp:comment_status><![CDATA[open]]></wp:comment_status>
    <wp:ping_status><![CDATA[closed]]></wp:ping_status>
    <wp:post_name><![CDATA[${p.sku ? p.sku.toLowerCase() : ''}]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type><![CDATA[product]]></wp:post_type>
    <wp:post_password></wp:post_password>
    <wp:is_sticky>0</wp:is_sticky>

    <!-- دسته‌بندی -->
    <category domain="product_cat" nicename="${xmlEscape(p.category.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))}">
      <![CDATA[${p.category || 'LEGO'}]]>
    </category>

    <!-- WooCommerce product data -->
    <wp:postmeta>
      <wp:meta_key><![CDATA[_visibility]]></wp:meta_key>
      <wp:meta_value><![CDATA[visible]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_stock_status]]></wp:meta_key>
      <wp:meta_value><![CDATA[${p.available && p.quantity > 0 ? 'instock' : 'outofstock'}]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_stock]]></wp:meta_key>
      <wp:meta_value><![CDATA[${p.quantity}]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_manage_stock]]></wp:meta_key>
      <wp:meta_value><![CDATA[yes]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_backorders]]></wp:meta_key>
      <wp:meta_value><![CDATA[${p.available && p.quantity > 0 ? 'notify' : 'no'}]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_regular_price]]></wp:meta_key>
      <wp:meta_value><![CDATA[0]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_price]]></wp:meta_key>
      <wp:meta_value><![CDATA[0]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_sku]]></wp:meta_key>
      <wp:meta_value><![CDATA[${p.sku}]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_product_image_gallery]]></wp:meta_key>
      <wp:meta_value><![CDATA[]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_product_url]]></wp:meta_key>
      <wp:meta_value><![CDATA[${p.source_url}]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[total_sales]]></wp:meta_key>
      <wp:meta_value><![CDATA[0]]></wp:meta_value>
    </wp:postmeta>
    ${metaXml}
    ${attrsXml}

    <!-- تصویر شاخص -->
    <wp:postmeta>
      <wp:meta_key><![CDATA[_thumbnail_url]]></wp:meta_key>
      <wp:meta_value><![CDATA[${mainImage}]]></wp:meta_value>
    </wp:postmeta>

    <!-- تصاویر گالری — برای import دستی -->
    <wp:postmeta>
      <wp:meta_key><![CDATA[_lego_gallery_urls]]></wp:meta_key>
      <wp:meta_value><![CDATA[${p.images.join('|')}]]></wp:meta_value>
    </wp:postmeta>
  </item>`;
}

// ─── ساخت فایل XML کامل ────────────────────────────────────────────────────
function buildXmlFile(products) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<!-- WooCommerce Product Import XML -->
<!-- Generated by LEGO.tr Scraper on ${new Date().toISOString()} -->
<!-- تعداد محصولات: ${products.length} -->
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>LEGO.tr Products</title>
  <link>https://lego.tr</link>
  <description>Scraped from lego.tr</description>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <language>tr-TR</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>https://lego.tr</wp:base_site_url>
  <wp:base_blog_url>https://lego.tr</wp:base_blog_url>

  <!-- دسته‌بندی‌ها -->
`;

  // جمع‌آوری دسته‌بندی‌های یکتا
  const cats = new Set(products.map(p => p.category).filter(Boolean));
  let catsXml = '';
  for (const cat of cats) {
    const slug = cat.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    catsXml += `  <wp:category>
    <wp:term_id>${Math.abs(cat.split('').reduce((a,c)=>a+c.charCodeAt(0),0)) % 9000 + 1000}</wp:term_id>
    <wp:category_nicename><![CDATA[${slug}]]></wp:category_nicename>
    <wp:category_parent></wp:category_parent>
    <wp:cat_name><![CDATA[${cat}]]></wp:cat_name>
  </wp:category>\n`;
  }

  const items = products.map((p, i) => buildProductXml(p, i)).join('\n');
  const footer = `\n</channel>\n</rss>`;

  return header + catsXml + items + footer;
}

// ─── اسکرپ یک کتگوری ────────────────────────────────────────────────────────
async function scrapeCategory(categoryPath) {
  const baseUrl = `${CONFIG.base_url}/${categoryPath}`;
  console.log(`\n📂 کتگوری: ${baseUrl}`);

  let allUrls = [];

  // گرفتن صفحه اول برای فهمیدن تعداد صفحات
  let firstHtml;
  try {
    firstHtml = await fetchHTML(baseUrl);
  } catch(e) {
    console.error(`  ❌ خطا در گرفتن صفحه اول: ${e.message}`);
    return [];
  }

  const totalPages = Math.min(getTotalPages(firstHtml), CONFIG.max_pages);
  console.log(`  📄 تعداد صفحات: ${totalPages}`);

  // صفحه اول
  const firstPageUrls = extractProductUrlsFromListing(firstHtml);
  allUrls.push(...firstPageUrls);
  console.log(`  🔗 صفحه 1: ${firstPageUrls.length} محصول`);

  // بقیه صفحات
  for (let page = 2; page <= totalPages; page++) {
    await sleep(CONFIG.delay_ms);
    try {
      const pageHtml = await fetchHTML(`${baseUrl}?pg=${page}`);
      const pageUrls = extractProductUrlsFromListing(pageHtml);
      allUrls.push(...pageUrls);
      console.log(`  🔗 صفحه ${page}: ${pageUrls.length} محصول`);
    } catch(e) {
      console.error(`  ❌ صفحه ${page}: ${e.message}`);
    }
  }

  // حذف تکراری
  allUrls = [...new Set(allUrls)];
  console.log(`  ✅ جمع: ${allUrls.length} URL یکتا`);

  return allUrls;
}

// ─── اسکرپ محصولات از لیست URL ───────────────────────────────────────────────
async function scrapeProducts(productUrls) {
  const products = [];
  let success = 0, failed = 0;

  console.log(`\n🛒 شروع اسکرپ ${productUrls.length} محصول...\n`);

  for (let i = 0; i < productUrls.length; i++) {
    const productUrl = productUrls[i];
    process.stdout.write(`  [${i+1}/${productUrls.length}] ${productUrl.split('/').pop()} ... `);

    await sleep(CONFIG.delay_ms);

    try {
      const html    = await fetchHTML(productUrl);
      const product = parseProductPage(html, productUrl);

      if (product) {
        products.push(product);
        success++;
        console.log(`✅ ${product.sku} | ${product.quantity} موجود | ${product.price_try} TL`);
      } else {
        failed++;
        console.log(`⚠️  اطلاعات پیدا نشد`);
      }
    } catch(e) {
      failed++;
      console.log(`❌ ${e.message}`);
    }

    // ذخیره موقت هر ۵۰ محصول
    if (products.length > 0 && products.length % 50 === 0) {
      saveProgress(products, 'temp');
    }
  }

  console.log(`\n📊 نتیجه: ${success} موفق، ${failed} خطا`);
  return products;
}

// ─── ذخیره فایل‌های خروجی ────────────────────────────────────────────────────
function saveProgress(products, prefix = 'lego') {
  if (!fs.existsSync(CONFIG.output_dir)) {
    fs.mkdirSync(CONFIG.output_dir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substr(0, 19);

  // XML برای ووکامرس
  const xmlContent = buildXmlFile(products);
  const xmlPath    = path.join(CONFIG.output_dir, `${prefix}-products-${ts}.xml`);
  fs.writeFileSync(xmlPath, xmlContent, 'utf8');
  console.log(`\n💾 XML ذخیره شد: ${xmlPath}`);

  // JSON برای backup و stock-sync
  const jsonData = {};
  for (const p of products) {
    if (p.sku) {
      jsonData[p.sku] = {
        name:          p.name,
        source_url:    p.source_url,
        price_try:     p.price_try,
        quantity:      p.quantity,
        available:     p.available,
        images:        p.images,
        category:      p.category,
        barcode:       p.barcode,
      };
    }
  }
  const jsonPath = path.join(CONFIG.output_dir, `${prefix}-products-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
  console.log(`💾 JSON ذخیره شد: ${jsonPath}`);

  return xmlPath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  console.log('='.repeat(60));
  console.log('  🧱 LEGO.tr Product Scraper → WooCommerce XML');
  console.log('='.repeat(60));

  let productUrls = [];

  // حالت ۱: یک محصول
  if (args.includes('--product')) {
    const idx = args.indexOf('--product');
    const productUrl = args[idx + 1];
    if (!productUrl) { console.error('URL محصول را وارد کنید'); process.exit(1); }
    productUrls = [productUrl];
  }

  // حالت ۲: یک کتگوری
  else if (args.includes('--url')) {
    const idx        = args.indexOf('--url');
    const listingUrl = args[idx + 1];
    if (!listingUrl) { console.error('URL کتگوری را وارد کنید'); process.exit(1); }

    // استخراج path از URL
    const parsed = new url.URL(listingUrl);
    const catPath = parsed.pathname.replace(/^\//, '');
    productUrls = await scrapeCategory(catPath);
  }

  // حالت ۳: همه کتگوری‌ها
  else if (args.includes('--all')) {
    for (const cat of CONFIG.categories) {
      const urls = await scrapeCategory(cat);
      productUrls.push(...urls);
      await sleep(1000);
    }
    productUrls = [...new Set(productUrls)];
    console.log(`\n🌐 جمع کل: ${productUrls.length} URL یکتا از همه کتگوری‌ها`);
  }

  // حالت ۴: خواندن از فایل
  else if (args.includes('--file')) {
    const idx      = args.indexOf('--file');
    const filePath = args[idx + 1];
    if (!filePath || !fs.existsSync(filePath)) { console.error('فایل پیدا نشد'); process.exit(1); }
    const content  = fs.readFileSync(filePath, 'utf8');
    productUrls    = content.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
    console.log(`📄 ${productUrls.length} URL از فایل خوانده شد`);
  }

  else {
    console.log(`
استفاده:
  node lego-scraper.js --product "https://lego.tr/43033-..."    یک محصول
  node lego-scraper.js --url "https://lego.tr/themes/lego-city" یک کتگوری
  node lego-scraper.js --all                                     همه کتگوری‌ها
  node lego-scraper.js --file urls.txt                           از لیست فایل

گزینه‌های اضافی:
  --delay 1000     تاخیر بین درخواست‌ها به میلی‌ثانیه (پیش‌فرض: 800)
  --output ./out   پوشه خروجی (پیش‌فرض: ./output)
    `);
    process.exit(0);
  }

  // تنظیمات اضافی
  if (args.includes('--delay')) {
    CONFIG.delay_ms = parseInt(args[args.indexOf('--delay') + 1]) || 800;
  }
  if (args.includes('--output')) {
    CONFIG.output_dir = args[args.indexOf('--output') + 1] || './output';
  }

  if (productUrls.length === 0) {
    console.error('\n❌ هیچ URL محصولی پیدا نشد.');
    process.exit(1);
  }

  // اسکرپ محصولات
  const products = await scrapeProducts(productUrls);

  if (products.length === 0) {
    console.error('\n❌ هیچ محصولی اسکرپ نشد.');
    process.exit(1);
  }

  // ذخیره فایل‌های خروجی
  const xmlPath = saveProgress(products, 'lego');

  console.log('\n' + '='.repeat(60));
  console.log(`✅ ${products.length} محصول آماده import است`);
  console.log(`📂 فایل XML: ${xmlPath}`);
  console.log('\nمراحل import در ووکامرس:');
  console.log('  ۱. WooCommerce → Products → Import');
  console.log('  ۲. فایل XML را آپلود کنید');
  console.log('  ۳. Map fields را تایید کنید');
  console.log('  ۴. Run the Importer');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\n❌ خطای کلی:', err);
  process.exit(1);
});
