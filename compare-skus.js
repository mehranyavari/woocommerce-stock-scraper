#!/usr/bin/env node
/**
 * compare-skus.js
 * مقایسه کدهای lego.tr با کدهای WooCommerce
 * می‌گه کدوم محصولات lego.tr تو سایت شما نیست
 *
 * استفاده:
 *   node compare-skus.js
 *   node compare-skus.js --lego output/lego-skus.json --woo output/woo-skus.json
 *   node compare-skus.js --lego output/lego-skus-only.json --woo output/woo-skus-only.json
 */

const fs   = require('fs');
const path = require('path');

// ─── آرگومان‌ها ────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const get    = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const legoPath = get('--lego')   || './output/lego-skus.json';
const wooPath  = get('--woo')    || './output/woo-skus.json';
const outDir   = get('--output') || './output';

// ─── خواندن و نرمال‌سازی JSON ──────────────────────────────────────────────────
function loadSkus(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ فایل ${label} پیدا نشد: ${filePath}`);
    process.exit(1);
  }

  const raw  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let skus;

  // هم آرایه ساده ["60001", ...] هم آرایه آبجکت [{sku: "60001"}, ...]
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (typeof raw[0] === 'string' || typeof raw[0] === 'number') {
      skus = raw.map(s => String(s).trim().toUpperCase());
    } else {
      skus = raw.map(p => String(p.sku || '').trim().toUpperCase()).filter(Boolean);
    }
  } else {
    console.error(`❌ فرمت ${label} نامعتبر است — باید آرایه باشد`);
    process.exit(1);
  }

  return [...new Set(skus)];
}

// ─── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log('='.repeat(60));
  console.log('  🔍 مقایسه‌گر SKU — LEGO.tr vs WooCommerce');
  console.log('='.repeat(60));

  console.log(`\n📂 فایل LEGO.tr : ${legoPath}`);
  console.log(`📂 فایل WooCommerce: ${wooPath}`);

  const legoSkus = loadSkus(legoPath, 'LEGO.tr');
  const wooSkus  = loadSkus(wooPath,  'WooCommerce');

  console.log(`\n📊 تعداد کدهای LEGO.tr     : ${legoSkus.length}`);
  console.log(`📊 تعداد کدهای WooCommerce : ${wooSkus.length}`);

  const wooSet  = new Set(wooSkus);
  const legoSet = new Set(legoSkus);

  // ── کدهایی که تو lego.tr هستن ولی تو WooCommerce نیستن ──────────────────────
  const missingInWoo = legoSkus.filter(sku => !wooSet.has(sku));

  // ── کدهایی که تو WooCommerce هستن ولی تو lego.tr نیستن ──────────────────────
  const notInLego = wooSkus.filter(sku => !legoSet.has(sku));

  // ── کدهای مشترک ──────────────────────────────────────────────────────────────
  const common = legoSkus.filter(sku => wooSet.has(sku));

  // ─── نمایش نتایج ────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`✅ کدهای مشترک (هر دو سایت)         : ${common.length}`);
  console.log(`🆕 محصولات LEGO.tr که تو ما نیست    : ${missingInWoo.length}`);
  console.log(`🗑️  محصولات ما که دیگه تو LEGO نیست : ${notInLego.length}`);
  console.log('─'.repeat(60));

  // ─── ذخیره خروجی ────────────────────────────────────────────────────────────
  fs.mkdirSync(outDir, { recursive: true });

  const result = {
    generated_at:         new Date().toISOString(),
    lego_total:           legoSkus.length,
    woo_total:            wooSkus.length,
    common_count:         common.length,
    missing_in_woo_count: missingInWoo.length,
    extra_in_woo_count:   notInLego.length,

    // ← اینا مهم‌ترینن: محصولاتی که باید اضافه بشن
    missing_in_woo: missingInWoo,

    // محصولاتی که ممکنه دیگه تو lego.tr نباشن
    extra_in_woo: notInLego,

    // کدهای مشترک برای مرجع
    common: common,
  };

  const resultPath = path.join(outDir, 'comparison-result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n💾 نتیجه کامل → ${resultPath}`);

  // ─── فایل ساده فقط کدهای گمشده ─────────────────────────────────────────────
  const missingOnlyPath = path.join(outDir, 'missing-skus.json');
  fs.writeFileSync(missingOnlyPath, JSON.stringify(missingInWoo, null, 2), 'utf8');
  console.log(`📋 فقط کدهای گمشده → ${missingOnlyPath}`);

  // ─── نمایش اول ۲۰ تا ───────────────────────────────────────────────────────
  if (missingInWoo.length > 0) {
    console.log('\n🆕 اولین ۲۰ محصول گمشده:');
    missingInWoo.slice(0, 20).forEach((sku, i) => {
      console.log(`   ${i + 1}. ${sku}`);
    });
    if (missingInWoo.length > 20) {
      console.log(`   ... و ${missingInWoo.length - 20} تا دیگه`);
    }
  } else {
    console.log('\n🎉 همه محصولات lego.tr تو سایت شما موجودن!');
  }

  console.log('\n' + '='.repeat(60));
}

main();
