const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-etegi-beyaz-essentiel-100/_/R-p-305841?mc=8547381&c=BEYAZ";

// ... توابع کمکی (normalizeSize و parseTurkishPrice) ...

async function debug() {
    console.log('🐞 Starting Advanced Debug Scraper (NO PROXY)...');
    console.log(`🎯 Target: ${TEST_URL}\n`);
    
    // ۱. مرورگر بدون پروکسی اجرا می‌شود
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox'
            // '--proxy-server=...' // پروکسی غیرفعال شد
        ]
    });

    const page = await browser.newPage();

    // ۲. احراز هویت پروکسی هم غیرفعال شد
    /*
    await page.authenticate({
        username: 'mehran',
        password: 'mehran75'
    });
    */

    await page.setExtraHTTPHeaders({
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    await page.emulateTimezone('Europe/Istanbul');
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        console.log('🚀 Navigating to Decathlon...');
        await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log('⏳ Waiting for page to process (10 seconds)...');
        await new Promise(r => setTimeout(r, 10000));

        console.log('📥 Extracting __DKT data directly from HTML source...');
        const dktString = await page.evaluate(() => {
            const scriptNode = document.getElementById('__dkt');
            if (scriptNode) {
                const html = scriptNode.innerHTML;
                const match = html.match(/__DKT\s*=\s*(\{[\s\S]*?\});\s*__CONF/);
                return match ? match[1] : null;
            }
            return null;
        });

        if (!dktString) {
            console.error("❌ Critical: '__DKT' text NOT found!");
            console.log("📸 Taking a new screenshot to see what happened...");
            await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
            const html = await page.content();
            fs.writeFileSync('debug_source.html', html);
            await browser.close();
            return;
        }
        
        console.log("✅ Decathlon JSON string extracted successfully!");
        const dktData = JSON.parse(dktString);

        // --- پردازش دیتا (مثل قبل) ---
        const supermodelNode = dktData._ctx.data.find(item => item.type === 'Supermodel');
        const urlObj = new URL(TEST_URL);
        const targetModelId = urlObj.searchParams.get('mc'); 
        const targetModel = supermodelNode.data.models.find(m => m.modelId === targetModelId) || supermodelNode.data.models[0];
        
        console.log(`🎯 Target Model ID: ${targetModel.modelId}`);
        console.log(`🎨 Web Label: ${targetModel.webLabel}`);

        let extractedStocks = {};
        let finalPrice = null;

        targetModel.skus.forEach(sku => {
            if (!finalPrice && sku.price) finalPrice = sku.price;
            const isOut = sku.isNotAvailable === true || sku.isNotAvailableOnline === true;
            extractedStocks[sku.size] = isOut ? 0 : 5; 
        });

        console.log('\n--- EXTRACTED VALUES ---');
        console.log(`💰 Final Price: ${finalPrice} TL`);
        console.log('\n📦 Stocks (Raw):');
        console.table(extractedStocks);

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await browser.close();
        console.log('\n🏁 Debugging finished.');
    }
}

debug();
