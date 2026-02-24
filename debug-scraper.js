const puppeteer = require('puppeteer');
const fs = require('fs');

// لینک محصول برای تست
const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-etegi-beyaz-essentiel-100/_/R-p-305841?mc=8547381&c=BEYAZ";

// --- توابع کمکی (دقیقاً کپی شده از اسکرپر اصلی) ---

function normalizeSize(rawSize, hostname) {
    const trimmed = rawSize.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower === 's-m') return 'S/M';
    if (lower === 'm-l') return 'M/L';
    if (lower === 'standart' || lower === 'one size' || lower === 'os') return 'Standart';
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) return rangeMatch[1] + '-' + rangeMatch[2];
    const numbers = trimmed.match(/\b(\d+([.,]\d+)?)\b/g);
    if (numbers && numbers.length > 0) {
        if (hostname === 'www.meritspor.com.tr') return numbers[0].replace(',', '.');
        else return numbers[numbers.length - 1].replace(',', '.');
    }
    return trimmed;
}

function parseTurkishPrice(rawPrice) {
    if (!rawPrice) return null;
    let clean = rawPrice.replace(/[^\d,\.]/g, '');
    clean = clean.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(clean);
    if (isNaN(num)) return null;
    return Math.ceil(num);
}

// --- اسکرپت دیباگ ---

async function debug() {
    console.log('🐞 Starting Advanced Debug Scraper...');
    console.log(`🎯 Target: ${TEST_URL}\n`);
    
    // ۱. اضافه شدن پروکسی به تنظیمات مرورگر
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--proxy-server=http://45.145.20.148:3128' // <--- آدرس سرور پروکسی ترکیه
        ]
    });

    const page = await browser.newPage();

    // ۲. وارد کردن یوزرنیم و پسورد پروکسی
    await page.authenticate({
        username: 'mehran',
        password: 'mehran75'
    });

    await page.setExtraHTTPHeaders({
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    // تنظیم منطقه زمانی روی استانبول
    await page.emulateTimezone('Europe/Istanbul');
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        await page.goto(TEST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        
        await new Promise(r => setTimeout(r, 4000));

        // 1. استخراج آبجکت طلایی دکتلون از روی صفحه
        console.log('📥 Extracting raw __DKT data from Decathlon...');
        const dktData = await page.evaluate(() => {
            // مرورگر مستقیماً آبجکت را به ما برمی‌گرداند
            return typeof window.__DKT !== 'undefined' ? window.__DKT : null;
        });

        if (!dktData) {
            console.error("❌ Critical: '__DKT' object NOT found! Page might be blocked or structure changed.");
            await browser.close();
            return;
        }
        console.log("✅ Decathlon JSON (__DKT) found.\n");

        // 2. پیدا کردن بخش اطلاعات محصول (Supermodel)
        const supermodelNode = dktData._ctx.data.find(item => item.type === 'Supermodel');
        if (!supermodelNode || !supermodelNode.data || !supermodelNode.data.models) {
            console.error("❌ Critical: Product models not found in JSON.");
            await browser.close();
            return;
        }

        // گرفتن ID رنگ مورد نظر از لینک (مثلا mc=8547381)
        const urlObj = new URL(TEST_URL);
        const targetModelId = urlObj.searchParams.get('mc'); 
        
        // پیدا کردن رنگ دقیق داخل دیتا
        const targetModel = supermodelNode.data.models.find(m => m.modelId === targetModelId) || supermodelNode.data.models[0];
        
        console.log(`🎯 Target Model ID: ${targetModel.modelId}`);
        console.log(`🎨 Web Label: ${targetModel.webLabel}`);

        // 3. استخراج قیمت و موجودی سایزها
        let extractedStocks = {};
        let finalPrice = null;

        targetModel.skus.forEach(sku => {
            // استخراج قیمت (از اولین سایز موجود می‌گیریم)
            if (!finalPrice && sku.price) {
                finalPrice = sku.price;
            }
            
            // دکتلون عدد موجودی نمیده، فقط اگه ناموجود باشه مینویسه isNotAvailable: true
            const isOut = sku.isNotAvailable === true || sku.isNotAvailableOnline === true;
            
            // اگر موجود بود، به صورت فرضی عدد ۵ رو میذاریم تا وردپرس بفهمه موجوده
            extractedStocks[sku.size] = isOut ? 0 : 5; 
        });

        console.log('\n--- EXTRACTED VALUES ---');
        console.log(`💰 Final Price: ${finalPrice} TL`);
        
        console.log('\n📦 Stocks (Raw from Decathlon):');
        console.table(extractedStocks);

        // 4. نرمال‌سازی برای وردپرس
        console.log('\n✨ Normalized Stocks (Final Output):');
        const hostname = urlObj.hostname;
        const normalized = {};
        for (const [key, val] of Object.entries(extractedStocks)) {
            const normKey = normalizeSize(key, hostname);
            if (normKey) normalized[normKey] = val;
        }
        console.table(normalized);

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await browser.close();
        console.log('\n🏁 Debugging finished.');
    }
}

debug();
