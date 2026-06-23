const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

let useProxy = true;

// تنظیمات
const CONFIG = {
    CONCURRENT_SCRAPES: 2,
    BATCH_SIZE: 10,
    BATCH_DELAY: 3000,
    PAGE_TIMEOUT: 90000,
    WAIT_AFTER_LOAD: 5000
};

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
        const parsed = numbers.map(n => parseFloat(n.replace(',', '.')));
        return String(Math.max(...parsed));
    }
    return trimmed;
}

function parseTurkishPrice(rawPrice) {
    if (!rawPrice) return null;
    const str = String(rawPrice).trim();

    // اگه عدد خالص بود (از JSON، بدون فرمت‌بندی)
    const plain = parseFloat(str);
    if (!isNaN(plain) && !str.includes(',')) {
        return Math.ceil(plain);
    }

    // فرمت ترکی: 1.234,56 → 1234.56
    // اول نقطه‌های هزارگان رو حذف کن، بعد کاما رو به نقطه تبدیل کن
    let clean = str.replace(/[^\d,\.]/g, '');

    const commaIdx = clean.lastIndexOf(',');
    const dotIdx = clean.lastIndexOf('.');

    if (commaIdx > dotIdx) {
        // فرمت ترکی: 1.234,56
        clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (dotIdx > commaIdx) {
        // فرمت انگلیسی: 1,234.56
        clean = clean.replace(/,/g, '');
    }

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
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
        });

        await page.emulateTimezone('Europe/Istanbul');
        await page.setViewport({ width: 1920, height: 1080 });

        console.log(`  🔄 Visiting Decathlon homepage first...`);
        await page.goto('https://www.decathlon.com.tr', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

        console.log(`  🔄 Navigating to product page...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 8000 + Math.random() * 4000));

        const isBlocked = await page.evaluate(() => {
            const title = document.title.toLowerCase();
            return title.includes('just a moment') || title.includes('attention required') || title.includes('cloudflare');
        });

        if (isBlocked) {
            console.log(`  ⏳ Cloudflare challenge detected, waiting extra 10s...`);
            await new Promise(r => setTimeout(r, 10000));
        }

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
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Decathlon Error: " + error.message };
    }
}

async function waitForCloudflare(page, timeoutMs = 30000) {
    const startTime = Date.now();
    let isBlocked = true;

    while (Date.now() - startTime < timeoutMs) {
        const title = (await page.title()).toLowerCase();
        isBlocked = title.includes('just a moment') || 
                    title.includes('attention required') || 
                    title.includes('cloudflare') || 
                    title.includes('bir dakika') || 
                    title.includes('lütfen');

        if (!isBlocked) {
            console.log(`  🎉 Cloudflare bypassed! Title changed to: "${await page.title()}"`);
            return true;
        }

        console.log(`  ⏳ Cloudflare challenge active (Title: "${await page.title()}"). Waiting 2s...`);
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`  ⚠️ Cloudflare bypass timed out after ${timeoutMs / 1000}s.`);
    return false;
}

// ==========================================
// 👟 اسکرپر مخصوص کورای اسپور
// ==========================================
async function scrapeKorayspor(browser, url) {
    const page = await browser.newPage();
    try {
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
        });

        await page.emulateTimezone('Europe/Istanbul');
        await page.setViewport({ width: 1920, height: 1080 });

        if (useProxy) {
            await page.authenticate({
                username: 'mehran',
                password: 'mehran75'
            });
        }

        console.log(`  🔄 Navigating to product page...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log(`  ⏳ Waiting 15s to let Cloudflare pass...`);
        await new Promise(r => setTimeout(r, 15000));

        const hostname = new URL(page.url()).hostname;

        const nextDataString = await page.evaluate(() => {
            const scriptNode = document.getElementById('__NEXT_DATA__');
            return scriptNode ? scriptNode.innerHTML : null;
        });

        await page.close();

        if (!nextDataString) {
            return { success: false, error: "Korayspor: __NEXT_DATA__ not found (Cloudflare Blocked or structure changed)" };
        }

        const nextData = JSON.parse(nextDataString);
        const product = nextData.props?.pageProps?.data?.response?.product;

        if (!product || !product.barcodes || !product.stocksByBarcode) {
            return { success: false, error: "Korayspor: Product, barcodes, or stocks not found in JSON" };
        }

        const regularPrice = product.basePrice || product.salesPrice || null;
        const discountPrice = product.discountPrice || null;

        // مرتب‌سازی بارکدها بر اساس مقدار بارکد به صورت عددی/رشته‌ای صعودی
        const sortedBarcodes = [...product.barcodes].sort((a, b) => {
            return String(a.barcode).localeCompare(String(b.barcode), undefined, { numeric: true });
        });

        // مرتب‌سازی کلیدهای استوک به صورت عددی صعودی
        const sortedStockKeys = Object.keys(product.stocksByBarcode).sort((a, b) => {
            return parseInt(a) - parseInt(b);
        });

        const extractedStocks = {};
        sortedBarcodes.forEach((bc, idx) => {
            if (bc.stockTypeValues && bc.stockTypeValues[0]) {
                const rawSize = bc.stockTypeValues[0].name;
                const stockKey = sortedStockKeys[idx];
                const stockVal = product.stocksByBarcode[stockKey] !== undefined ? product.stocksByBarcode[stockKey] : 0;
                extractedStocks[rawSize] = stockVal;
            }
        });

        const normalizedStocks = {};
        for (const [key, val] of Object.entries(extractedStocks)) {
            const normKey = normalizeSize(key, hostname);
            if (normKey) normalizedStocks[normKey] = val;
        }

        const regular = parseTurkishPrice(regularPrice);
        let offer = parseTurkishPrice(discountPrice);
        if (regular && offer && offer >= regular) offer = null;

        console.log(`  ✅ Korayspor URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };

    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Korayspor Error: " + error.message };
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
        if (useProxy) {
            await page.authenticate({
                username: 'mehran',
                password: 'mehran75'
            });
        }

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

                // ✅ FIX: از productPriceKDVIncluded استفاده می‌کنیم
                // این فیلد مستقیماً قیمت نمایشی صفحه رو داره (با KDV)
                // و وابسته به ترتیب products[] نیست
                let regularPrice = data.productPriceKDVIncluded
                    ? String(data.productPriceKDVIncluded)
                    : null;
                let offerPrice = null;

                if (data.productVariantData && Array.isArray(data.productVariantData) && data.productVariantData.length > 0) {
                    const stockMap = {};
                    if (data.products && Array.isArray(data.products)) {
                        data.products.forEach(p => {
                            if (p.id !== undefined && p.stokAdedi !== undefined) stockMap[p.id] = parseInt(p.stokAdedi);
                        });

                        // بررسی تخفیف: اگر anaUrun داشت indirimliFiyati کمتر از satisFiyati بود
                        const anaUrun = data.products.find(p => p.anaUrun === true) || data.products[0];
                        if (anaUrun && anaUrun.indirimliFiyati < anaUrun.satisFiyati) {
                            // تخفیف واقعی وجود داره — offer price رو با همون نسبت حساب می‌کنیم
                            const ratio = anaUrun.indirimliFiyati / anaUrun.satisFiyati;
                            offerPrice = String(Math.ceil(data.productPriceKDVIncluded * ratio));
                        }
                    }
                    data.productVariantData.forEach(variant => {
                        if (variant.tanim && variant.urunID !== undefined) stocks[variant.tanim] = stockMap[variant.urunID] || 0;
                    });
                } else if (data.product) {
                    stocks['Standart'] = parseInt(data.product.stokAdedi) || 0;
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

        console.log(`  ✅ ${urlLabel} Success: ${Object.keys(normalizedStocks).length} variants found. Price: ${regular} ₺`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
    } catch (error) {
        try { await page.close(); } catch(e){}
        return { success: false, error: error.message };
    }
}

function getEffectivePrice(scrapeData) {
    if (!scrapeData || !scrapeData.success) return 0;
    return scrapeData.offer_price ? scrapeData.offer_price : (scrapeData.regular_price || 0);
}

async function processProduct(browser, product) {
    let primaryData = { success: false, error: "No Primary URL", stocks: {} };
    let secondaryData = { success: false, error: "No Secondary URL", stocks: {} };

    if (product.url) {
        if (product.url.toLowerCase().includes('decathlon')) {
            console.log(`Scraping Primary URL for product ${product.id} (Decathlon Engine)`);
            primaryData = await scrapeDecathlon(browser, product.url);
        } else if (product.url.toLowerCase().includes('korayspor')) {
            console.log(`Scraping Primary URL for product ${product.id} (Korayspor Engine)`);
            primaryData = await scrapeKorayspor(browser, product.url);
        } else {
            primaryData = await scrapeProduct(browser, { id: product.id, url: product.url }, false);
        }
    }

    if (product.secondary_url) {
        if (product.secondary_url.toLowerCase().includes('decathlon')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Decathlon Engine)`);
            secondaryData = await scrapeDecathlon(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('korayspor')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Korayspor Engine)`);
            secondaryData = await scrapeKorayspor(browser, product.secondary_url);
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

async function main() {
    const args = getArgs();
    useProxy = args.proxy !== 'false' && !process.argv.includes('--no-proxy');
    const targetIds = args.ids ? args.ids.split(',').map(id => id.trim()) : null;

    const files = fs.readdirSync('.').filter(fn => fn.startsWith('products_') && fn.endsWith('.json'));

    if (files.length === 0) {
        console.log('⚠️ هیچ فایلی با فرمت products_*.json یافت نشد.');
        return;
    }

    console.log(`🔌 Proxy Enabled: ${useProxy}`);

    const launchArgs = [];
    if (useProxy) {
        launchArgs.push('--proxy-server=http://45.145.20.148:3128');
    }

    console.log('🚀 Launching puppeteer-real-browser...');
    const { browser } = await connect({
        headless: false,
        turnstile: true,
        disableXvfb: false,
        args: launchArgs
    });

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
            continue;
        }

        if (targetIds) {
            products = products.filter(p => targetIds.includes(String(p.id)));
            if (products.length === 0) continue;
        }

        const results = { ...currentData };
        let successCount = 0;
        let failCount = 0;
        let skippedCount = 0;

        const CONCURRENCY = 3;

        for (let i = 0; i < products.length; i += CONCURRENCY) {
            const chunk = products.slice(i, i + CONCURRENCY);
            console.log(`\n⏳ پردازش همزمان محصولات ${i + 1} تا ${i + chunk.length} از ${products.length}...`);

            const chunkPromises = chunk.map(async (product) => {
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
            });

            await Promise.all(chunkPromises);
            await new Promise(r => setTimeout(r, 2000));
        }

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
