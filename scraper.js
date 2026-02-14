const puppeteer = require('puppeteer');
const fs = require('fs');

// تنظیمات
const CONFIG = {
    CONCURRENT_SCRAPES: 2,
    BATCH_SIZE: 10,
    BATCH_DELAY: 3000,
    PAGE_TIMEOUT: 60000, // افزایش تایم‌اوت برای اطمینان بیشتر
    WAIT_AFTER_LOAD: 4000
};

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
        if (hostname === 'www.meritspor.com.tr') {
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
        .replace(/\./g, '') // حذف هزارگان
        .replace(',', '.'); // اعشار

    const num = parseFloat(clean);
    if (isNaN(num)) return null;

    return Math.ceil(num); // رند به بالا
}

/**
 * استخراج موجودی و قیمت از یک URL
 */
async function scrapeProduct(browser, product) {
    console.log(`Scraping product ${product.id}: ${product.url}`);

    const page = await browser.newPage();

    try {
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        await page.setViewport({ width: 1920, height: 1080 });

        await page.goto(product.url, {
            waitUntil: 'networkidle2',
            timeout: CONFIG.PAGE_TIMEOUT
        });

        await page.waitForTimeout(CONFIG.WAIT_AFTER_LOAD);

        const hostname = new URL(product.url).hostname;

        const result = await page.evaluate(() => {
            const match = document.body.innerHTML.match(/var productDetailModel = (.*?);/);
            if (!match) return null;

            try {
                const data = JSON.parse(match[1]);
                const stocks = {};
                let regularPrice = null;
                let offerPrice = null;

                // حالت ۱: محصول دارای واریانت (مثل سایز کفش)
                if (data.productVariantData && Array.isArray(data.productVariantData) && data.productVariantData.length > 0) {
                    const stockMap = {};
                    
                    if (data.products && Array.isArray(data.products)) {
                        data.products.forEach(p => {
                            if (p.id !== undefined && p.stokAdedi !== undefined) {
                                stockMap[p.id] = parseInt(p.stokAdedi);
                            }
                        });

                        // قیمت‌ها را از اولین محصول لیست برمی‌داریم
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
                // حالت ۲: محصول تکی (مثل مچ‌بند یا محصولات فری‌سایز)
                else if (data.product) {
                    // تمام موجودی را به یک سایز فرضی "Standart" اختصاص می‌دهیم
                    const qty = parseInt(data.product.stokAdedi) || 0;
                    stocks['Standart'] = qty;

                    regularPrice = data.product.satisFiyatiStr || null;
                    offerPrice = data.product.indirimliFiyatiStr || null;
                }

                return {
                    success: true,
                    stocks: stocks,
                    regularPrice: regularPrice,
                    offerPrice: offerPrice
                };

            } catch (e) {
                return { success: false, error: e.message };
            }
        });

        await page.close();

        if (!result || !result.success) {
            console.log(`  ❌ Failed (Data extraction failed)`);
            return null;
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

        // اگر قیمت تخفیف‌خورده با قیمت اصلی برابر یا بیشتر بود، یعنی تخفیفی نداریم
        if (regular && offer && offer >= regular) {
            offer = null;
        }

        console.log(
            `  ✅ Success: ${Object.keys(normalizedStocks).length} variants, ` +
            `Regular: ${regular || 'N/A'}, Offer: ${offer || 'N/A'}`
        );

        return {
            stocks: normalizedStocks,
            regular_price: regular,
            offer_price: offer
        };

    } catch (error) {
        await page.close();
        console.log(`  ❌ Error: ${error.message}`);
        return null;
    }
}

/**
 * پردازش محصول با primary و secondary
 */
async function processProductWithDualSource(browser, product) {
    const result = {
        id: product.id,
        url: product.url,
        success: false,
        stocks: {},
        regular_price: null,
        offer_price: null,
        lastUpdated: new Date().toISOString()
    };

    const primaryData = await scrapeProduct(browser, product);

    if (!primaryData) {
        result.error = 'Failed to fetch from primary URL';
        return result;
    }

    result.stocks = { ...primaryData.stocks };
    result.regular_price = primaryData.regular_price;
    result.offer_price = primaryData.offer_price;
    result.success = true;

    if (product.secondary_url) {
        const outOfStockSizes = [];

        // بررسی سایزهای ناموجود در لینک اول
        for (const [size, stock] of Object.entries(primaryData.stocks)) {
            if (stock === 0) {
                outOfStockSizes.push(size);
            }
        }

        if (outOfStockSizes.length > 0) {
            console.log(`  🔄 Checking secondary URL for ${outOfStockSizes.length} sizes`);

            const secondaryData = await scrapeProduct(browser, {
                id: product.id,
                url: product.secondary_url
            });

            if (secondaryData) {
                for (const size of outOfStockSizes) {
                    // اگر در لینک دوم موجودی داشت، جایگزین کن
                    if (secondaryData.stocks[size] && secondaryData.stocks[size] > 0) {
                        result.stocks[size] = secondaryData.stocks[size];
                    }
                }
            }
        }
    }

    return result;
}

/**
 * اجرای اصلی
 */
async function main() {
    console.log('='.repeat(60));
    console.log('Stock Scraper Started (Dual Source + Price Support)');
    console.log('='.repeat(60));

    let products = [];
    try {
        const data = fs.readFileSync('products.json', 'utf8');
        products = JSON.parse(data);
        console.log(`✅ Loaded ${products.length} products`);
    } catch (error) {
        console.error('❌ Error loading products.json');
        fs.writeFileSync('stock-data.json', JSON.stringify({}, null, 2));
        return;
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const results = {};
    let successCount = 0;
    let failCount = 0;
    let priceCount = 0;

    for (const product of products) {
        const result = await processProductWithDualSource(browser, product);

        // تغییر مهم: همیشه نتیجه را ذخیره کن، چه موفق چه ناموفق
        results[product.id] = result;

        if (result.success) {
            successCount++;
            if (result.regular_price || result.offer_price) {
                priceCount++;
            }
        } else {
            failCount++;
            // لاگ کردن خطای محصول برای بررسی راحت‌تر در گیت‌هاب
            console.log(`⚠️ Product ${product.id} Failed: ${result.error || 'Unknown Error'}`);
        }

        await new Promise(r => setTimeout(r, 1000));
    }

    await browser.close();

    fs.writeFileSync('stock-data.json', JSON.stringify(results, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('✅ Scraping Complete!');
    console.log(`Success: ${successCount}`);
    console.log(`With Price: ${priceCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`Total: ${products.length}`);
    console.log('='.repeat(60));
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
