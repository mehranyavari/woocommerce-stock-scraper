const fs = require('fs');
const path = require('path');
const { translate } = require('@vitalets/google-translate-api');

const CONFIG = {
  inputJson:  path.join(__dirname, 'output', 'lego-latest.json'),
  outputJson: path.join(__dirname, 'output', 'lego-translated.json'),
};

// نگاشت رنگ‌های ترکی به فارسی
const colorMap = {
  'siyah': 'مشکی',
  'beyaz': 'سفید',
  'kırmızı': 'قرمز',
  'mavi': 'آبی',
  'yeşil': 'سبز',
  'sarı': 'زرد',
  'turuncu': 'نارنجی',
  'mor': 'بنفش',
  'pembe': 'صورتی',
  'kahverengi': 'قهوه‌ای',
  'gri': 'خاکستری',
  'altın': 'طلایی',
  'gümüş': 'نقره‌ای',
  'çok renkli': 'چندرنگ',
  'çok renklı': 'چندرنگ',
  'şeffaf': 'شفاف',
  'lacivert': 'سرمه‌ای',
  'bordo': 'زرشکی',
  'krem': 'کرم',
  'bej': 'بژ',
  'turkuaz': 'فیروزه‌ای',
};

function translateColor(turkishColor) {
  const lower = turkishColor.toLowerCase().trim();
  return colorMap[lower] || lower;
}

async function translateProductTitle(product) {
  if (!product.name) return '';

  const title = product.name;

  try {
    // ترجمه کل عنوان از ترکی به فارسی
    const result = await translate(title, { from: 'tr', to: 'fa' });
    let faTitle = result.text;

    // اطمینان از وجود LEGO®
    if (!faTitle.includes('LEGO') && !faTitle.includes('لگو')) {
      faTitle = 'LEGO® ' + faTitle;
    }

    // جایگزینی LEGO به LEGO® (اگر حذف شده باشد)
    faTitle = faTitle.replace(/LEGO(?!®)/g, 'LEGO®');

    // ترجمه رنگ‌های رایج داخل متن
    for (const [trColor, faColor] of Object.entries(colorMap)) {
      const regex = new RegExp(`\\b${trColor}\\b`, 'gi');
      faTitle = faTitle.replace(regex, faColor);
    }

    return faTitle;
  } catch (err) {
    console.error(`⚠️ خطا در ترجمه: ${err.message}`);
    return title; // برگشت به عنوان اصلی در صورت خطا
  }
}

async function translateAll() {
  if (!fs.existsSync(CONFIG.inputJson)) {
    console.error('❌ فایل lego-latest.json پیدا نشد.');
    process.exit(1);
  }

  const products = JSON.parse(fs.readFileSync(CONFIG.inputJson, 'utf8'));
  console.log(`🔄 ترجمه ${products.length} عنوان با Google Translate (رایگان)...\n`);

  const translated = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];

    if (!product.name) {
      translated.push({ ...product, name_fa: '', name_original: '' });
      continue;
    }

    process.stdout.write(`[${i + 1}/${products.length}] ${product.sku || '???'} ... `);
    
    const faTitle = await translateProductTitle(product);
    console.log(`✅ ${faTitle.slice(0, 60)}${faTitle.length > 60 ? '...' : ''}`);

    translated.push({
      ...product,
      name_fa: faTitle,
      name_original: product.name,
    });

    // تأخیر کوتاه برای جلوگیری از بن شدن (۱ ثانیه)
    await new Promise(r => setTimeout(r, 1000));
  }

  fs.mkdirSync(path.dirname(CONFIG.outputJson), { recursive: true });
  fs.writeFileSync(CONFIG.outputJson, JSON.stringify(translated, null, 2), 'utf8');
  console.log(`\n🎉 تمام! ${translated.length} عنوان ترجمه شد: ${CONFIG.outputJson}`);
}

translateAll().catch(err => console.error('❌', err.message));
