const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// تنظیمات
const CONFIG = {
    CONCURRENT_SCRAPES: 2,
    BATCH_SIZE: 10,
    BATCH_DELAY: 3000,
    PAGE_TIMEOUT: 90000,
    WAIT_AFTER_LOAD: 5000
};

/**
 * دریافت آرگومان‌های ورودی
 */
function getArgs() {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            args[key] = value;
        }
    });
    return args;
}

/**
 * نرمال‌سازی سایز
 */
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
        if (hostname && hostname.includes('meritspor')) return numbers[0].replace(',', '.');
        else return numbers[numbers.length - 1].replace(',', '.');
    }
    return trimmed;
}

/**
 * تبدیل قیمت ترکیه‌ای به عدد
 */
function parseTurkishPrice(rawPrice) {
    if (!rawPrice) return null;
    let clean = String(rawPrice).replace(/[^\d,\.]/g, '').replace(/\./g, '').replace(',', '.');
    const num = parseFloat(clean);
    if (isNaN(num)) return null;
    return Math.ceil(num);
}

// ==========================================
// 🚀 اسکرپر مخصوص دکتلون
// ==========================================
async function scrapeDecathlon(browser, url) {
    const page = await browser.newPage();
    try {
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7' });
        await page.emulateTimezone('Europe/Istanbul');
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // صبر کردن برای عبور از کلودفلر
        await new Promise(resolve => setTimeout(resolve, 12000));

        const dktString = await page.evaluate(() => {
            const scriptNode = document.getElementById('__dkt');
            if (!scriptNode) return null;
            const html = scriptNode.innerHTML;
            const startStr = '__DKT = ';
            const endStr = '__CONF =';
            const startIdx = html.indexOf(startStr);
            const endIdx = html.indexOf(endStr);
            if (startIdx !== -1 && endIdx !== -1) {
                let jsonText = html.substring(startIdx + startStr.length, endIdx).trim();
                if (jsonText.endsWith(';')) jsonText = jsonText.slice(0, -1);
                return jsonText;
            }
            return null;
        });

        await page.close();

        if (!dktString) return { success: false, error: "Decathlon __DKT not found (Cloudflare Blocked)" };

        const dktData = JSON.parse(dktString);
        const supermodelNode = dktData._ctx.data.find(item => item.type === 'Supermodel');
        
        if (!supermodelNode || !supermodelNode.data || !supermodelNode.data.models) {
            return { success: false, error: "Product models not found in Decathlon JSON" };
        }

        const urlObj = new URL(url);
        const targetModelId = urlObj.searchParams.get('mc'); 
        const targetModel = supermodelNode.data.models.find(m => m.modelId === targetModelId) || supermodelNode.data.models[0];

        let extractedStocks = {};
        let finalPrice = null;

        targetModel.skus.forEach(sku => {
            if (!finalPrice && sku.price) finalPrice = sku.price;
            const isOut = sku.isNotAvailable === true || sku.isNotAvailableOnline === true;
            extractedStocks[sku.size] = isOut ? 0 : 5; 
        });

        const normalizedStocks = {};
        const hostname = urlObj.hostname;
        for (const [key, val] of Object.entries(extractedStocks)) {
            const normKey = normalizeSize(key, hostname);
            if (normKey) normalizedStocks[normKey] = val;
        }

        const price = parseTurkishPrice(finalPrice);
        console.log(`  ✅ Decathlon URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: price, offer_price: price };

    } catch (error) {
        try { await page.close(); } catch(e){}
        return { success: false, error: "Decathlon Error: " + error.message };
    }
}

// ==========================================
// 🛒 اسکرپر استاندارد (سایر سایت‌ها)
// ==========================================
async function scrapeProduct(browser, productObj, isSecondary = false) {
    const urlLabel = isSecondary ? "Secondary URL" : "Primary URL";
    console.log(`Scraping ${urlLabel} for product ${productObj.id}: ${productObj.url}`);

    const page = await browser.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        try {
            await page.goto(productObj.url, { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_TIMEOUT });
        } catch (navError) {
            throw new Error(`Navigation Error: ${navError.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, CONFIG.WAIT_AFTER_LOAD));

        const hostname = new URL(page.url()).hostname;

        const result = await page.evaluate(() => {
            const match = document.body.innerHTML.match(/var productDetailModel = (.*?);/);
            if (!match) return { success: false, error: "Variable 'productDetailModel' NOT found" };

            try {
                const data = JSON.parse(match[1]);
                const stocks = {};
                let regularPrice = null, offerPrice = null;

                if (data.productVariantData && Array.isArray(data.productVariantData) && data.productVariantData.length > 0) {
                    const stockMap = {};
                    if (data.products && Array.isArray(data.products)) {
                        data.products.forEach(p => {
                            if (p.id !== undefined && p.stokAdedi !== undefined) stockMap[p.id] = parseInt(p.stokAdedi);
                        });
                        if (data.products.length > 0) {
                            regularPrice = data.products[0].satisFiyatiStr || null;
                            offerPrice = data.products[0].indirimliFiyatiStr || null;
                        }
                    }
                    data.productVariantData.forEach(variant => {
                        if (variant.tanim && variant.urunID !== undefined) stocks[variant.tanim] = stockMap[variant.urunID] || 0;
                    });
                } else if (data.product) {
                    stocks['Standart'] = parseInt(data.product.stokAdedi) || 0;
                    regularPrice = data.product.satisFiyatiStr || null;
                    offerPrice = data.product.indirimliFiyatiStr || null;
                } else {
                    return { success: false, error: "Unknown JSON structure" };
                }

                return { success: true, stocks, regularPrice, offerPrice };
            } catch (e) {
                return { success: false, error: "JSON Parse Error: " + e.message };
            }
        });

        await page.close();

        if (!result.success) return { success: false, error: result.error };

        const normalizedStocks = {};
        for (const [rawSize, stock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = stock;
        }

        const regular = parseTurkishPrice(result.regularPrice);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;

        console.log(`  ✅ ${urlLabel} Success: ${Object.keys(normalizedStocks).length} variants found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
    } catch (error) {
        try { await page.close(); } catch(e){}
        return { success: false, error: error.message };
    }
}

/**
 * محاسبه قیمت نهایی برای مقایسه
 */
function getEffectivePrice(scrapeData) {
    if (!scrapeData || !scrapeData.success) return 0;
    return scrapeData.offer_price ? scrapeData.offer_price : (scrapeData.regular_price || 0);
}

/**
 * پردازش هوشمند محصول
 */
async function processProduct(browser, product) {
    let primaryData = { success: false, error: "No Primary URL", stocks: {} };
    let secondaryData = { success: false, error: "No Secondary URL", stocks: {} };

    // 1. بررسی سایت اصلی
    if (product.url) {
        if (product.url.toLowerCase().includes('decathlon')) {
            console.log(`Scraping Primary URL for product ${product.id} (Decathlon Engine)`);
            primaryData = await scrapeDecathlon(browser, product.url);
        } else {
            primaryData = await scrapeProduct(browser, { id: product.id, url: product.url }, false);
        }
    }

    // 2. بررسی سایت دوم
    if (product.secondary_url) {
        if (product.secondary_url.toLowerCase().includes('decathlon')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Decathlon Engine)`);
            secondaryData = await scrapeDecathlon(browser, product.secondary_url);
        } else {
            secondaryData = await scrapeProduct(browser, { id: product.id, url: product.secondary_url }, true);
        }
    }

    const primarySuccess = primaryData.success;
    const secondarySuccess = secondaryData.success;

    if (!primarySuccess && !secondarySuccess) {
        return {
            id: product.id,
            success: false,
            error: `Primary: ${primaryData.error} | Secondary: ${secondaryData.error}`,
            lastUpdated: new Date().toISOString()
        };
    }

    // 3. مقایسه قیمت‌ها (همیشه قیمت بالاتر رو میگیریم)
    let priceWinner = null;
    if (primarySuccess && secondarySuccess) {
        const price1 = getEffectivePrice(primaryData);
        const price2 = getEffectivePrice(secondaryData);
        priceWinner = (price2 > price1) ? secondaryData : primaryData;
        console.log(`  ⚖️ Comparing Prices: Primary=${price1}₺, Secondary=${price2}₺ -> Selected higher price.`);
    } else if (primarySuccess) {
        priceWinner = primaryData;
    } else {
        priceWinner = secondaryData;
    }

    // 4. ادغام موجودی‌ها
    const mergedStocks = {};
    const allSizes = new Set([
        ...Object.keys(primaryData.stocks || {}),
        ...Object.keys(secondaryData.stocks || {})
    ]);

    allSizes.forEach(size => {
        const stock1 = (primaryData.stocks && primaryData.stocks[size]) || 0;
        const stock2 = (secondaryData.stocks && secondaryData.stocks[size]) || 0;
        
        if (stock1 > 0) mergedStocks[size] = stock1;
        else if (stock2 > 0) mergedStocks[size] = stock2;
        else mergedStocks[size] = 0;
    });

    console.log(`  🤝 Merged Stocks: ${Object.keys(mergedStocks).length} total sizes processed.`);

    return {
        id: product.id,
        success: true,
        stocks: mergedStocks,
        regular_price: priceWinner.regular_price,
        offer_price: priceWinner.offer_price,
        lastUpdated: new Date().toISOString()
    };
}

// ==========================================
// 🚀 موتور پردازش Multi-site (جدید)
// ==========================================
async function main() {
    const args = getArgs();
    const targetIds = args.ids ? args.ids.split(',').map(id => id.trim()) : null;

    // پیدا کردن تمام فایل‌هایی که با products_ شروع می‌شوند
    const files = fs.readdirSync('.').filter(fn => fn.startsWith('products_') && fn.endsWith('.json'));

    if (files.length === 0) {
        console.log('⚠️ هیچ فایلی با فرمت products_*.json یافت نشد.');
        return;
    }

    // راه‌اندازی مرورگر (یک بار برای تمام سایت‌ها)
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    // پردازش هر سایت به صورت جداگانه
    for (const file of files) {
        const siteName = file.replace('products_', '').replace('.json', '');
        const outputFile = `stock-data_${siteName}.json`;

        console.log('\n' + '='.repeat(60));
        console.log(`🌍 در حال اسکرپ سایت: ${siteName}`);
        console.log('='.repeat(60));

        let products = [];
        let currentData = {};

        try {
            products = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (fs.existsSync(outputFile)) {
                currentData = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
            }
        } catch (error) {
            console.error(`❌ خطا در خواندن فایل‌های سایت ${siteName}:`, error);
            continue; // پرش به سایت بعدی در صورت خطا
        }

        if (targetIds) {
            products = products.filter(p => targetIds.includes(String(p.id)));
            if (products.length === 0) {
                console.log(`⚠️ هیچ محصولی با این آیدی‌ها در سایت ${siteName} پیدا نشد.`);
                continue;
            }
        }

        const results = { ...currentData };
        let successCount = 0;
        let failCount = 0;
        let skippedCount = 0;

        for (const product of products) {
            const result = await processProduct(browser, product);
            const isSkipped = result.error && result.error.toString().includes('Skipped');

            if (isSkipped) {
                if (results[product.id]) delete results[product.id];
                console.log(`⏩ Skipped & Removed: ${product.id}`);
                skippedCount++;
            } else {
                results[product.id] = result;
                if (result.success) successCount++;
                else {
                    failCount++;
                    console.log(`⚠️ Failed: ${product.id} -> ${result.error}`);
                }
            }
            
            const delay = isSkipped ? 0 : CONFIG.BATCH_DELAY;
            await new Promise(r => setTimeout(r, delay));
        }

        // ذخیره فایل اختصاصی همین سایت
        fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

        console.log(`\n✅ پایان اسکرپ سایت: ${siteName}`);
        console.log(`موفق: ${successCount} | ناموفق: ${failCount} | رد شده: ${skippedCount}`);
        console.log(`فایل ذخیره شد: ${outputFile}\n`);
    }

    await browser.close();
    console.log('🎉 تمام سایت‌ها با موفقیت پردازش شدند.');
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
