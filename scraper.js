const puppeteer = require('puppeteer');
const fs = require('fs');

// تنظیمات
const CONFIG = {
    CONCURRENT_SCRAPES: 2,  // تعداد صفحاتی که همزمان باز می‌شوند
    BATCH_SIZE: 10,         // تعداد محصولات در هر دسته
    BATCH_DELAY: 3000,      // تأخیر بین هر دسته (میلی‌ثانیه)
    PAGE_TIMEOUT: 30000,    // Timeout هر صفحه
    WAIT_AFTER_LOAD: 4000   // صبر بعد از لود صفحه
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
 * استخراج موجودی از یک URL
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
                
                return { success: true, stocks: stocks };
                
            } catch (e) {
                return { success: false, error: e.message };
            }
        });
        
        await page.close();
        
        if (!result || !result.success) {
            console.log(`  ❌ Failed: ${result ? result.error : 'No data'}`);
            return {
                id: product.id,
                success: false,
                error: result ? result.error : 'No data found'
            };
        }
        
        const normalizedStocks = {};
        for (const [rawSize, stock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) {
                normalizedStocks[normalized] = stock;
            }
        }
        
        console.log(`  ✅ Success: ${Object.keys(normalizedStocks).length} variants`);
        
        return {
            id: product.id,
            url: product.url,
            success: true,
            stocks: normalizedStocks,
            lastUpdated: new Date().toISOString()
        };
        
    } catch (error) {
        await page.close();
        console.log(`  ❌ Error: ${error.message}`);
        return {
            id: product.id,
            success: false,
            error: error.message
        };
    }
}

/**
 * اجرای اصلی
 */
async function main() {
    console.log('='.repeat(60));
    console.log('Stock Scraper Started');
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
    
    // پردازش به صورت دسته‌ای
    for (let i = 0; i < products.length; i += CONFIG.BATCH_SIZE) {
        const batch = products.slice(i, i + CONFIG.BATCH_SIZE);
        const batchNum = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(products.length / CONFIG.BATCH_SIZE);
        
        console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} products)`);
        
        for (const product of batch) {
            const result = await scrapeProduct(browser, product);
            
            if (result.success) {
                results[product.id] = result;
                successCount++;
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
    console.log(`   Success: ${successCount} products`);
    console.log(`   Failed:  ${failCount} products`);
    console.log(`   Total:   ${products.length} products`);
    console.log('='.repeat(60));
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
