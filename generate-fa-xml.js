const fs = require('fs');
const path = require('path');

const CONFIG = {
  inputJson:  path.join(__dirname, 'output', 'lego-translated.json'),   // خروجی translate-titles.js
  outputXml:  path.join(__dirname, 'output', 'lego-fa-products.xml'),
};

function xe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function buildProductXml(p) {
  // از عنوان فارسی استفاده می‌شود؛ اگر موجود نباشد، عنوان اصلی ترکی را می‌گذاریم
  const title = p.name_fa || p.name || '';

  // برای کمک به بروزرسانی، SKU باید دقیقاً مانند محصولات موجود باشد
  return `
  <item>
    <title>${xe(title)}</title>
    <sku>${xe(p.sku)}</sku>
    <regular_price>${p.price_try || 0}</regular_price>
    <stock_status>${(p.available && p.quantity > 0) ? 'instock' : 'outofstock'}</stock_status>
    <manage_stock>1</manage_stock>
    <stock_quantity>${p.quantity}</stock_quantity>
    <description><![CDATA[${(p.description || '').replace(/\n/g, '<br />')}]]></description>
    <short_description><![CDATA[${(p.description || '').slice(0, 400)}]]></short_description>
    <category>${xe(p.category || 'LEGO')}</category>
    <images>
      ${(p.images || []).map((img, i) => `<image position="${i}">${xe(img)}</image>`).join('\n      ')}
    </images>
    <meta_data>
      <meta><key>_lego_name_original</key><value>${xe(p.name_original || p.name)}</value></meta>
      <meta><key>_lego_source_url</key><value>${xe(p.source_url)}</value></meta>
    </meta_data>
  </item>`;
}

function wrapXml(products) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- WooCommerce Product Update — Farsi Titles — ${new Date().toISOString()} -->
<!-- تعداد محصولات: ${products.length} -->
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>LEGO Products (FA)</title>
  <link>https://yourstore.com</link>
${products.map(p => buildProductXml(p)).join('\n')}
</channel>
</rss>`;
}

function generateFaXml() {
  if (!fs.existsSync(CONFIG.inputJson)) {
    console.error('❌ فایل lego-translated.json یافت نشد. ابتدا translate-titles.js را اجرا کنید.');
    process.exit(1);
  }

  const products = JSON.parse(fs.readFileSync(CONFIG.inputJson, 'utf8'));

  const xmlContent = wrapXml(products);
  fs.mkdirSync(path.dirname(CONFIG.outputXml), { recursive: true });
  fs.writeFileSync(CONFIG.outputXml, xmlContent, 'utf8');

  console.log(`✅ فایل XML آمادهٔ بروزرسانی ووکامرس:\n   ${CONFIG.outputXml}`);
}

generateFaXml();
