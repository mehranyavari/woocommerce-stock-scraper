const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');   // npm install openai

const CONFIG = {
  inputJson:  path.join(__dirname, 'output', 'lego-latest.json'),
  outputJson: path.join(__dirname, 'output', 'lego-translated.json'),
  model:      'gpt-3.5-turbo',          // یا gpt-4 در صورت نیاز
};

function buildPrompt(product) {
  // از تمام اطلاعات موجود در محصول برای تولید عنوان دقیق استفاده می‌کنیم
  return `
You are a product title translator and formatter for LEGO items scraped from a Turkish store.

Convert the Turkish LEGO product title into this EXACT Persian pattern:

"[دسته‌بندی فارسی] LEGO® [نام انگلیسی محصول] - [رنگ فارسی]"

Rules:
- Determine the correct Persian category (e.g., کوله پشتی, ماشین, ایستگاه فضایی ...) based on the Turkish title and product type.
- The English name must be the official LEGO set name or a natural English translation of the descriptive part. Keep the ® symbol.
- The color(s) at the end must be in Persian (مشکی, قرمز, چندرنگ ...). Combine multiple colors with "و".
- Do NOT include any SKU, product codes, or numbers in the final output.
- Do NOT repeat "LEGO" in the Persian category (e.g., "مدل لکو" is already included).
- Output ONLY the final Persian title, nothing else.

Examples:
Input: "LEGO® Yapım Parçası Sırt Çantası – Siyah – Çok Renkli 2025.345-2.258"
Output: کوله پشتی مدل لکو LEGO® Brick Backpack Multicolored - مشکی

Input: "LEGO® Creator Expert NASA Apollo 11 Lunar Lander 10266 – Gri – Sarı"
Output: کاوشگر ماه مدل لکو LEGO® Creator Expert NASA Apollo 11 Lunar Lander - خاکستری و زرد

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
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });   // کلید از متغیر محیطی خوانده شود

  console.log(`🔄 ترجمه ${products.length} عنوان با ${CONFIG.model}...\n`);

  const translated = [];

  for (const product of products) {
    if (!product.name) {
      // اگر عنوان ترکی نداشت، بدون تغییر رد می‌شود
      translated.push({ ...product, name_fa: product.name || '', name_original: '' });
      continue;
    }

    const prompt = buildPrompt(product);

    try {
      const completion = await openai.chat.completions.create({
        model: CONFIG.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 120,
      });

      const newTitle = completion.choices[0].message.content.trim();
      console.log(`✅ ${product.sku || product.name.slice(0, 40)} → ${newTitle}`);

      translated.push({
        ...product,
        name_fa: newTitle,           // عنوان نهایی فارسی
        name_original: product.name, // نگهداری عنوان ترکی اصلی
      });
    } catch (err) {
      console.error(`❌ خطا برای ${product.sku}: ${err.message}`);
      translated.push({ ...product, name_fa: product.name, name_original: product.name });
    }

    // احترام به محدودیت نرخ (Rate Limit)
    await new Promise(r => setTimeout(r, 500));
  }

  fs.mkdirSync(path.dirname(CONFIG.outputJson), { recursive: true });
  fs.writeFileSync(CONFIG.outputJson, JSON.stringify(translated, null, 2), 'utf8');
  console.log(`\n🎉 ذخیره شد: ${CONFIG.outputJson}`);
}

translateAll().catch(err => {
  console.error(err);
  process.exit(1);
});
