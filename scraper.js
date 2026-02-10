const puppeteer = require('puppeteer');
const fs = require('fs');

// تنظیمات
const CONFIG = {
    CONCURRENT_SCRAPES: 2,
    BATCH_SIZE: 10,
    BATCH_DELAY: 3000,
    PAGE_TIMEOUT: 30000,
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
 * استخراج موجودی و قیمت از یک URL
 */
async function scrapeProduct(browser, product) {
    console.log(`Scraping product ${product.id}: ${product.url}`);
    
    const page = await browser.newPage();
    
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
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
                
                const stockMap = {};
                if (data.products && Array.isArray(data.products)) {
                    data.products.forEach(p => {
                        if (p.id !== undefined && p.stokAdedi !== undefined) {
                            stockMap[p.id] = parseInt(p.stokAdedi);
                        }
                    });
                }
                
                const stocks = {};
                if (data.productVariantData && Array.isArray(data.productVariantData)) {
                    data.productVariantData.forEach(variant => {
                        if (variant.tanim && variant.urunID !== undefined) {
                            stocks[variant.tanim] = stockMap[variant.urunID] || 0;
                        }
                    });
                }
                
                // استخراج قیمت اصلی و تخفیف‌دار
                let regularPrice = null;
                let offerPrice = null;
                
                if (data.products && data.products.length > 0) {
                    const p = data.products[0];
                
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
                
                    // قیمت اصلی
                    regularPrice = parseTurkishPrice(p.satisFiyatiStr);
                
                    // قیمت تخفیف‌دار
                    offerPrice = parseTurkishPrice(p.indirimliFiyatiStr);
                
                    // اگر تخفیف واقعی وجود نداشت
                    if (regularPrice && offerPrice && offerPrice >= regularPrice) {
                        offerPrice = null;
                    }
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
            console.log(`  ❌ Failed: ${result ? result.error : 'No data'}`);
            return null;
        }
        
        const normalizedStocks = {};
        for (const [rawSize, stock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) {
                normalizedStocks[normalized] = stock;
            }
        }
        
        console.log(`  ✅ Success: ${Object.keys(normalizedStocks).length} variants, Price: ${result.price || 'N/A'}`);
        
        return {
            stocks: normalizedStocks,
            price: result.price
        };
        
    } catch (error) {
        await page.close();
        console.log(`  ❌ Error: ${error.message}`);
        return null;
    }
}

/**
 * پردازش یک محصول با دو URL (primary و secondary)
 */
async function processProductWithDualSource(browser, product) {
    const result = {
        id: product.id,
        url: product.url,
        success: false,
        stocks: {},
        price: null,
        lastUpdated: new Date().toISOString()
    };
    
    // مرحله 1: دریافت از URL اصلی
    const primaryData = await scrapeProduct(browser, product);
    
    if (!primaryData) {
        result.error = 'Failed to fetch from primary URL';
        return result;
    }
    
    result.stocks = { ...primaryData.stocks };
    result.price = primaryData.price; // قیمت را از تامین‌کننده اول می‌گیریم
    result.success = true;
    
    // مرحله 2: بررسی سایزهای ناموجود و چک کردن URL دوم
    if (product.secondary_url) {
        const outOfStockSizes = [];
        
        for (const [size, stock] of Object.entries(primaryData.stocks)) {
            if (stock === 0) {
                outOfStockSizes.push(size);
            }
        }
        
        if (outOfStockSizes.length > 0) {
            console.log(`  🔄 Checking secondary URL for ${outOfStockSizes.length} out-of-stock sizes`);
            
            const secondaryData = await scrapeProduct(browser, {
                id: product.id,
                url: product.secondary_url
            });
            
            if (secondaryData) {
                let foundInSecondary = 0;
                
                for (const size of outOfStockSizes) {
                    if (secondaryData.stocks[size] && secondaryData.stocks[size] > 0) {
                        result.stocks[size] = secondaryData.stocks[size];
                        foundInSecondary++;
                    }
                }
                
                if (foundInSecondary > 0) {
                    console.log(`  ✅ Found ${foundInSecondary} sizes in stock from secondary URL`);
                }
                
                // قیمت را فقط از تامین‌کننده اول می‌گیریم، secondary را نادیده می‌گیریم
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
    
    // خواندن لیست محصولات
    let products = [];
    try {
        const data = fs.readFileSync('products.json', 'utf8');
        products = JSON.parse(data);
        console.log(`✅ Loaded ${products.length} products from products.json`);
    } catch (error) {
        console.error('❌ Error loading products.json:', error.message);
        console.log('ℹ️  Creating empty stock-data.json');
        fs.writeFileSync('stock-data.json', JSON.stringify({}, null, 2));
        return;
    }
    
    if (products.length === 0) {
        console.log('⚠️  No products to scrape');
        fs.writeFileSync('stock-data.json', JSON.stringify({}, null, 2));
        return;
    }
    
    // شمارش محصولاتی که secondary URL دارند
    const withSecondary = products.filter(p => p.secondary_url).length;
    console.log(`ℹ️  ${withSecondary} products have secondary URL for fallback`);
    
    // راه‌اندازی مرورگر
    console.log('\n🚀 Launching browser...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    });
    
    const results = {};
    let successCount = 0;
    let failCount = 0;
    let priceCount = 0;
    
    // پردازش به صورت دسته‌ای
    for (let i = 0; i < products.length; i += CONFIG.BATCH_SIZE) {
        const batch = products.slice(i, i + CONFIG.BATCH_SIZE);
        const batchNum = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(products.length / CONFIG.BATCH_SIZE);
        
        console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} products)`);
        
        for (const product of batch) {
            const result = await processProductWithDualSource(browser, product);
            
            if (result.success) {
                results[product.id] = result;
                successCount++;
                if (result.price) {
                    priceCount++;
                }
            } else {
                failCount++;
            }
            
            // تأخیر کوچک بین محصولات
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // تأخیر بین دسته‌ها
        if (i + CONFIG.BATCH_SIZE < products.length) {
            console.log(`⏳ Waiting ${CONFIG.BATCH_DELAY}ms before next batch...`);
            await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
        }
    }
    
    await browser.close();
    
    // ذخیره نتایج
    console.log('\n💾 Saving results...');
    fs.writeFileSync('stock-data.json', JSON.stringify(results, null, 2));
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Scraping Complete!');
    console.log(`   Success:      ${successCount} products`);
    console.log(`   With Price:   ${priceCount} products`);
    console.log(`   Failed:       ${failCount} products`);
    console.log(`   Total:        ${products.length} products`);
    console.log('='.repeat(60));
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
