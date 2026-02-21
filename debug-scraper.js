const puppeteer = require('puppeteer');
const fs = require('fs');

// لینک محصول برای تست
const TEST_URL = "https://www.raketspor.com.tr/nikecourt-io6234-323-dri-fit-max90-erkek-tisort-yesil-10584";

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
        
        // جایگزین استاندارد waitForTimeout
        await new Promise(r => setTimeout(r, 4000));

        // 1. استخراج متغیر خام
        console.log('📥 Extracting raw data from page...');
        const variableContent = await page.evaluate(() => {
            const match = document.body.innerHTML.match(/var productDetailModel = (.*?);/);
            return match ? match[1] : null;
        });

        if (!variableContent) {
            console.error("❌ Critical: 'productDetailModel' variable NOT found!");
            await browser.close();
            return;
        }

        console.log("✅ Raw JSON found.\n");

        // 2. پردازش داده‌ها (شبیه‌سازی منطق اسکرپر)
        const data = JSON.parse(variableContent);
        
        console.log('--- RAW DATA ANALYSIS ---');
        
        // بررسی نوع محصول
        let isVariantProduct = false;
        let isSingleProduct = false;

        if (data.productVariantData && Array.isArray(data.productVariantData) && data.productVariantData.length > 0) {
            isVariantProduct = true;
            console.log("Type: Multi-Variant Product (Like Shoes)");
            console.log(`Variants Found: ${data.productVariantData.length}`);
        } else if (data.product) {
            isSingleProduct = true;
            console.log("Type: Single Product (Like Wristbands)");
        } else {
            console.log("Type: Unknown Structure ⚠️");
        }

        console.log('\n--- EXTRACTED VALUES ---');

        let extractedStocks = {};
        let rawRegPrice = null;
        let rawOffPrice = null;

        if (isVariantProduct) {
            // منطق واریانت
            const stockMap = {};
            if (data.products) {
                data.products.forEach(p => stockMap[p.id] = parseInt(p.stokAdedi));
                if (data.products.length > 0) {
                    rawRegPrice = data.products[0].satisFiyatiStr;
                    rawOffPrice = data.products[0].indirimliFiyatiStr;
                }
            }
            data.productVariantData.forEach(variant => {
                extractedStocks[variant.tanim] = stockMap[variant.urunID] || 0;
            });
        } else if (isSingleProduct) {
            // منطق تکی (جدید)
            const qty = parseInt(data.product.stokAdedi) || 0;
            extractedStocks['Standart'] = qty;
            rawRegPrice = data.product.satisFiyatiStr;
            rawOffPrice = data.product.indirimliFiyatiStr;
        }

        // نمایش قیمت‌ها
        console.log(`🏷️  Raw Regular Price:  "${rawRegPrice}"`);
        console.log(`🏷️  Raw Offer Price:    "${rawOffPrice}"`);
        
        const finalReg = parseTurkishPrice(rawRegPrice);
        const finalOff = parseTurkishPrice(rawOffPrice);

        console.log(`💰 Parsed Regular:     ${finalReg}`);
        console.log(`💰 Parsed Offer:       ${finalOff}`);

        // نمایش موجودی
        console.log('\n📦 Stocks:');
        console.table(extractedStocks);

        // نرمال‌سازی
        console.log('\n✨ Normalized Stocks (Final Output):');
        const hostname = new URL(TEST_URL).hostname;
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
