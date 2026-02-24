const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-etegi-beyaz-essentiel-100/_/R-p-305841?mc=8547381&c=BEYAZ";

// --- توابع کمکی ---
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
        return numbers[numbers.length - 1].replace(',', '.');
    }
    return trimmed;
}

async function debug() {
    console.log('🐞 Starting Advanced Debug Scraper (NO PROXY)...');
    console.log(`🎯 Target: ${TEST_URL}\n`);
    
    // ۱. اجرای مرورگر بدون پروکسی
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox'
        ]
    });

    const page = await browser.newPage();

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

        // ۲. روش ضدخطا برای بریدن متن جیسون از داخل HTML
        console.log('📥 Extracting __DKT data directly from HTML source...');
        const dktString = await page.evaluate(() => {
            const scriptNode = document.getElementById('__dkt');
            if (!scriptNode) return null;
            
            const html = scriptNode.innerHTML;
            const startStr = '__DKT = ';
            const endStr = '__CONF =';
            
            const startIdx = html.indexOf(startStr);
            const endIdx = html.indexOf(endStr);
            
            if (startIdx !== -1 && endIdx !== -1) {
                // بریدن دقیق متن از شروع جیسون تا قبل از کلمه __CONF
                let jsonText = html.substring(startIdx + startStr.length, endIdx).trim();
                if (jsonText.endsWith(';')) {
                    jsonText = jsonText.slice(0, -1);
                }
                return jsonText;
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

        // --- پردازش دیتا ---
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
