const puppeteer = require('puppeteer');
const fs = require('fs');

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
    if (rangeMatch) {
        return rangeMatch[1] + '-' + rangeMatch[2];
    }

    const numbers = trimmed.match(/\b(\d+([.,]\d+)?)\b/g);
    if (numbers && numbers.length > 0) {
        if (hostname && hostname.includes('meritspor')) {
            return numbers[0].replace(',', '.');
        } else {
            return numbers[numbers.length - 1].replace(',', '.');
        }
    }

    return trimmed;
}

/**
 * تبدیل قیمت ترکیه‌ای به عدد
 */
function parseTurkishPrice(rawPrice) {
    if (!rawPrice) return null;

    let clean = rawPrice.replace(/[^\d,\.]/g, '');
    clean = clean
        .replace(/\./g, '') 
        .replace(',', '.'); 

    const num = parseFloat(clean);
    if (isNaN(num)) return null;

    return Math.ceil(num);
}

/**
 * استخراج موجودی و قیمت از یک URL
 */
async function scrapeProduct(browser, product, isSecondary = false) {
    const urlLabel = isSecondary ? "Secondary URL" : "Primary URL";
    console.log(`Scraping ${urlLabel} for product ${product.id}: ${product.url}`);

    const page = await browser.newPage();

    try {
        await page.authenticate({
            username: 'mehran',
            password: 'mehran75'
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        await page.setViewport({ width: 1920, height: 1080 });

        try {
            await page.goto(product.url, {
                waitUntil: 'networkidle2',
                timeout: CONFIG.PAGE_TIMEOUT
            });
        } catch (navError) {
            throw new Error(`Navigation Timeout/Error: ${navError.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, CONFIG.WAIT_AFTER_LOAD));

        const hostname = new URL(page.url()).hostname;

        const result = await page.evaluate(() => {
            const match = document.body.innerHTML.match(/var productDetailModel = (.*?);/);
            if (!match) return { success: false, error: "Variable 'productDetailModel' NOT found" };

            try {
                const data = JSON.parse(match[1]);
                
                if (data.brandName && data.brandName.toLowerCase().includes('decathlon')) {
                    return { success: false, error: "Skipped: Brand is Decathlon" };
                }

                const stocks = {};
                let regularPrice = null;
                let offerPrice = null;

                if (data.productVariantData && Array.isArray(data.productVariantData) && data.productVariantData.length > 0) {
                    const stockMap = {};
                    if (data.products && Array.isArray(data.products)) {
                        data.products.forEach(p => {
                            if (p.id !== undefined && p.stokAdedi !== undefined) {
                                stockMap[p.id] = parseInt(p.stokAdedi);
                            }
                        });
                        if (data.products.length > 0) {
                            const p = data.products[0];
                            regularPrice = p.satisFiyatiStr || null;
                            offerPrice = p.indirimliFiyatiStr || null;
                        }
                    }

                    data.productVariantData.forEach(variant => {
                        if (variant.tanim && variant.urunID !== undefined) {
                            stocks[variant.tanim] = stockMap[variant.urunID] || 0;
                        }
                    });
                } 
                else if (data.product) {
                    stocks['Standart'] = parseInt(data.product.stokAdedi) || 0;
                    regularPrice = data.product.satisFiyatiStr || null;
                    offerPrice = data.product.indirimliFiyatiStr || null;
                } else {
                    return { success: false, error: "Unknown JSON structure" };
                }

                return {
                    success: true,
                    stocks: stocks,
                    regularPrice: regularPrice,
                    offerPrice: offerPrice
                };

            } catch (e) {
                return { success: false, error: "JSON Parse Error: " + e.message };
            }
        });

        await page.close();

        if (!result.success) {
            return { success: false, error: result.error };
        }

        const normalizedStocks = {};
        for (const [rawSize, stock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) {
                normalizedStocks[normalized] = stock;
            }
        }

        const regular = parseTurkishPrice(result.regularPrice);
        let offer = parseTurkishPrice(result.offerPrice);

        if (regular && offer && offer >= regular) {
            offer = null;
        }

        console.log(`  ✅ ${urlLabel} Success: ${Object.keys(normalizedStocks).length} variants found.`);

        return {
            success: true,
            stocks: normalizedStocks,
            regular_price: regular,
            offer_price: offer
        };

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
 * پردازش هوشمند محصول (ادغام سایزها و قیمت)
 */
async function processProduct(browser, product) {
    let primaryData = { success: false, error: "No Primary URL", stocks: {} };
    let secondaryData = { success: false, error: "No Secondary URL", stocks: {} };

    // 1. بررسی سایت اصلی
    if (product.url && !product.url.toLowerCase().includes('decathlon')) {
        primaryData = await scrapeProduct(browser, { id: product.id, url: product.url }, false);
    } else if (product.url && product.url.toLowerCase().includes('decathlon')) {
        primaryData.error = "Skipped: Decathlon Primary URL";
    }

    // 2. بررسی سایت دوم
    if (product.secondary_url && !product.secondary_url.toLowerCase().includes('decathlon')) {
        secondaryData = await scrapeProduct(browser, { id: product.id, url: product.secondary_url }, true);
    } else if (product.secondary_url && product.secondary_url.toLowerCase().includes('decathlon')) {
        secondaryData.error = "Skipped: Decathlon Secondary URL";
    }

    const primarySuccess = primaryData.success;
    const secondarySuccess = secondaryData.success;

    // اگر هر دو سایت خطا دادند
    if (!primarySuccess && !secondarySuccess) {
        return {
            id: product.id,
            success: false,
            error: `Primary: ${primaryData.error} | Secondary: ${secondaryData.error}`,
            lastUpdated: new Date().toISOString()
        };
    }

    // 3. انتخاب قیمت پایه (سایتی که گران‌تر است برنده قیمت می‌شود)
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

    // 4. ادغام هوشمندانه موجودی سایزها (Variant-Level Merging)
    const mergedStocks = {};
    const allSizes = new Set([
        ...Object.keys(primaryData.stocks || {}),
        ...Object.keys(secondaryData.stocks || {})
    ]);

    allSizes.forEach(size => {
        const stock1 = (primaryData.stocks && primaryData.stocks[size]) || 0;
        const stock2 = (secondaryData.stocks && secondaryData.stocks[size]) || 0;
        
        if (stock1 > 0) {
            // اگر در سایت اصلی موجود بود، همون رو برمیداریم
            mergedStocks[size] = stock1;
        } else if (stock2 > 0) {
            // اگر سایت اصلی ناموجود بود ولی سایت دوم داشت، از سایت دوم برمیداریم!
            mergedStocks[size] = stock2;
        } else {
            // در هر دو سایت ناموجود است
            mergedStocks[size] = 0;
        }
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

/**
 * اجرای اصلی
 */
async function main() {
    const args = getArgs();
    const targetIds = args.ids ? args.ids.split(',').map(id => id.trim()) : null;

    console.log('='.repeat(60));
    console.log(targetIds ? `Stock Scraper - Batch Mode (${targetIds.length} items)` : 'Stock Scraper - Full Mode');
    console.log('='.repeat(60));

    let products = [];
    let currentData = {};

    try {
        products = JSON.parse(fs.readFileSync('products.json', 'utf8'));
        
        if (fs.existsSync('stock-data.json')) {
            const raw = fs.readFileSync('stock-data.json', 'utf8');
            try { currentData = JSON.parse(raw); } catch(e) { currentData = {}; }
        }
    } catch (error) {
        console.error('❌ Error loading files:', error);
        return;
    }

    if (targetIds) {
        products = products.filter(p => targetIds.includes(String(p.id)));
        if (products.length === 0) {
            console.log('⚠️ No matching products found for the provided IDs.');
            return;
        }
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--proxy-server=http://45.145.20.148:3128'
        ]
    });

    const results = { ...currentData };
    
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    for (const product of products) {
        const result = await processProduct(browser, product);
        
        const isSkipped = result.error && result.error.toString().includes('Skipped');

        if (isSkipped) {
            if (results[product.id]) {
                delete results[product.id];
            }
            console.log(`⏩ Skipped & Removed: ${product.id}`);
            skippedCount++;
        } else {
            results[product.id] = result;

            if (result.success) {
                successCount++;
            } else {
                failCount++;
                console.log(`⚠️ Failed: ${product.id} -> ${result.error}`);
            }
        }
        
        const delay = isSkipped ? 0 : CONFIG.BATCH_DELAY;
        await new Promise(r => setTimeout(r, delay));
    }

    await browser.close();

    fs.writeFileSync('stock-data.json', JSON.stringify(results, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('✅ Scraping Complete!');
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`Skipped (Removed): ${skippedCount}`);
    console.log('='.repeat(60));
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
