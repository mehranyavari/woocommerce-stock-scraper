const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const CONFIG = {
  inputJson:  path.join(__dirname, 'output', 'lego-latest.json'),
  outputJson: path.join(__dirname, 'output', 'lego-translated.json'),
  model:      'gemini-2.0-flash',  // سریع و رایگان
};

function buildPrompt(product) {
  return `You are a product title translator and formatter for LEGO items scraped from a Turkish store.

Convert the Turkish LEGO product title into this EXACT Persian pattern:

"[دسته‌بندی فارسی] مدل لکو LEGO® [نام انگلیسی محصول] - [رنگ فارسی]"

Rules:
- Determine the correct Persian category (e.g., کوله پشتی, ماشین, ایستگاه فضایی, ساختمان, هواپیما, قطار, کشتی, ربات, مجسمه, گل, قلعه, مزرعه, ایستگاه پلیس, ایستگاه آتش نشانی, آزمایشگاه, کارخانه, هتل, رستوران, موتور, کامیون, هلیکوپتر, زیردریایی, سفینه, ماهواره, تلسکوپ, پیانو, گیتار, موتور سیکلت, دوچرخه, قایق, جرثقیل, بیل مکانیکی, تراکتور, تانک, جنگنده, شوالیه, دایناسور, اژدها, روباه, خرگوش, سگ, گربه, شیر, ببر, خرس, پنگوئن, دلفین, کوسه, عقاب, جغد, طوطی, پروانه, زنبور, عنکبوت, مار, لاک پشت, قورباغه, میمون, فیل, زرافه, اسب, گاو, گوسفند, مرغ, خروس, اردک, غاز, قو, ماهی, ستاره دریایی, اختاپوس, خرچنگ, حلزون, کفشدوزک, سنجاقک, ملخ, مورچه, سوسک, کرم, پروانه, پشه, مگس, زنبور عسل, کک, شپش, کنه, عنکبوت, رتیل, عقرب, مارمولک, سوسمار, تمساح, لاک پشت, مار, افعی, کبرا, پیتون, آناکوندا, نهنگ, کوسه, دلفین, نهنگ قاتل, فک, شیر دریایی, خرس قطبی, پنگوئن, مرغ ماهیخوار, پلیکان, فلامینگو, طاووس, قرقاول, بلدرچین, کبک، کبوتر, یاکریم, کلاغ, زاغ, گنجشک, سار, دارکوب, هدهد, شاهین, عقاب, کرکس, جغد, خفاش, سنجاب, خرگوش, موش, همستر, خوکچه هندی, چینچیلا, راسو, سمور, گورکن, خارپشت, تشی, آرمادیلو, تنبل, مورچه خوار, پانگولین, کوالا, کانگورو, والابی, وامبت, شیطان تاسمانی, پلاتیپوس, اکیدنا, کیوی, شترمرغ, امو, کاسواری, ناندو, پنگوئن, آلباتروس, مرغ طوفان, باکلان, بوبی, ناوچه, پلیکان, لک لک, حواصیل, اکرت, فلامینگو, اکراس, کفچه نوک, قاشقک, اردک, غاز, قو، اردک ماندارین, اردک سرسبز, اردک نوک پهن, اردک بلوطی, اردک سرحنایی, اردک تاجدار, اردک ماهیخوار, اردک غواص, اردک چشم طلایی, اردک دم دراز, اردک سرسفید, اردک سیاه, اردک خالدار, اردک مرمری, اردک بلوطی, اردک تاجدار, اردک ماندارین, اردک کارولینا, اردک جنگلی, اردک آفریقایی, اردک هاوایی, اردک لکه دار, اردک ابرو سفید, اردک سرخ, اردک تاجدار, اردک کاکلی, اردک شانه به سر) based on the Turkish title.
- The English name must be the official LEGO set name or a natural English translation. Keep the ® symbol.
- The color(s) at the end must be in Persian (مشکی, سفید, قرمز, آبی, سبز, زرد, نارنجی, بنفش, صورتی, قهوه ای, خاکستری, طلایی, نقره ای, چندرنگ). Combine multiple colors with "و".
- Do NOT include any SKU, product codes, or numbers.
- Do NOT repeat "LEGO" in the Persian category.
- Output ONLY the final Persian title, nothing else.

Examples:
Input: "LEGO® Yapım Parçası Sırt Çantası – Siyah – Çok Renkli 2025.345-2.258"
Output: کوله پشتی مدل لکو LEGO® Brick Backpack Multicolored - مشکی

Input: "LEGO® Creator Expert NASA Apollo 11 Lunar Lander 10266 – Gri – Sarı"
Output: کاوشگر ماه مدل لکو LEGO® Creator Expert NASA Apollo 11 Lunar Lander - خاکستری و زرد

Input: "LEGO® City İtfaiye İstasyonu 60320 – Kırmızı – Beyaz"
Output: ایستگاه آتش نشانی مدل لکو LEGO® City Fire Station - قرمز و سفید

Now process this product:
Turkish title: ${product.name}
SKU: ${product.sku || '-'}
Item number: ${product.item_no || '-'}
Age: ${product.age || '-'}
Pieces: ${product.parts || '-'}
Category (Turkish): ${product.category || '-'}

Persian title:`;
}

async function translateAll() {
  if (!fs.existsSync(CONFIG.inputJson)) {
    console.error('❌ فایل lego-latest.json پیدا نشد. ابتدا اسکرپ را اجرا کنید.');
    process.exit(1);
  }

  const products = JSON.parse(fs.readFileSync(CONFIG.inputJson, 'utf8'));
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: CONFIG.model });

  console.log(`🔄 ترجمه ${products.length} عنوان با ${CONFIG.model}...\n`);

  const translated = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    
    if (!product.name) {
      translated.push({ ...product, name_fa: product.name || '', name_original: '' });
      continue;
    }

    const prompt = buildPrompt(product);

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const newTitle = response.text().trim();
      
      console.log(`✅ [${i + 1}/${products.length}] ${product.sku || product.name.slice(0, 40)} → ${newTitle}`);

      translated.push({
        ...product,
        name_fa: newTitle,
        name_original: product.name,
      });
    } catch (err) {
      console.error(`❌ خطا برای ${product.sku}: ${err.message}`);
      translated.push({ ...product, name_fa: product.name, name_original: product.name });
    }

    // تأخیر برای رعایت محدودیت نرخ (رایگان: 15 درخواست در دقیقه)
    await new Promise(r => setTimeout(r, 4000));  // 4 ثانیه = 15 تا تو دقیقه
  }

  fs.mkdirSync(path.dirname(CONFIG.outputJson), { recursive: true });
  fs.writeFileSync(CONFIG.outputJson, JSON.stringify(translated, null, 2), 'utf8');
  console.log(`\n🎉 ذخیره شد: ${CONFIG.outputJson}`);
}

translateAll().catch(err => {
  console.error(err);
  process.exit(1);
});
