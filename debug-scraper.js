const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

const TEST_URL = "https://www.decathlon.com.tr/p/erkek-yuruyus-ayakkabisi-nh500/_/R-p-325358?mc=8803926";

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
    console.log('🐞 Starting Advanced Debug Scraper (Anti-Cloudflare Mode)...');
    console.log(`🎯 Target: ${TEST_URL}\n`);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--flag-switches-begin',
            '--disable-site-isolation-trials',
            '--flag-switches-end'
        ],
        ignoreDefaultArgs: ['--enable-automation'], // 🔑 فلگ automation رو مخفی می‌کنه
    });

    const page = await browser.newPage();

    // ۱. Fingerprint کامل قبل از هر چیز
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const arr = [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                ];
                arr.__proto__ = PluginArray.prototype;
                return arr;
            }
        });
        Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        window.chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {}
        };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters);
    });

    // ۲. هدرهای کامل
    await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': '"Chromium";v="120", "Google Chrome";v="120", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
    });

    await page.emulateTimezone('Europe/Istanbul');
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        // ۳. اول صفحه اصلی (برای گرفتن کوکی cf_clearance)
        console.log('🏠 Step 1: Visiting Decathlon homepage to get Cloudflare cookies...');
        await page.goto('https://www.decathlon.com.tr', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        const homeDelay = 2000 + Math.random() * 2000;
        console.log(`⏳ Waiting ${Math.round(homeDelay / 1000)}s on homepage...`);
        await new Promise(r => setTimeout(r, homeDelay));

        // ۴. رفتن به صفحه محصول
        console.log('\n🚀 Step 2: Navigating to product page...');
        await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const productDelay = 8000 + Math.random() * 4000;
        console.log(`⏳ Waiting ${Math.round(productDelay / 1000)}s for Cloudflare challenge...`);
        await new Promise(r => setTimeout(r, productDelay));

        // ۵. چک Cloudflare
        const pageTitle = await page.title();
        console.log(`📄 Page title: "${pageTitle}"`);

        const isBlocked = pageTitle.toLowerCase().includes('just a moment') ||
                          pageTitle.toLowerCase().includes('attention required') ||
                          pageTitle.toLowerCase().includes('cloudflare');

        if (isBlocked) {
            console.log('⏳ Cloudflare challenge still active, waiting extra 10s...');
            await new Promise(r => setTimeout(r, 10000));
            const newTitle = await page.title();
            console.log(`📄 Page title after extra wait: "${newTitle}"`);
        }

        // ۶. استخراج داده
        console.log('\n📥 Step 3: Extracting __DKT data...');
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

        if (!dktString) {
            console.error("❌ Critical: '__DKT' text NOT found! Taking screenshot...");
            await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
            const html = await page.content();
            fs.writeFileSync('debug_source.html', html);
            console.log('📸 Saved: debug_screenshot.png & debug_source.html');
            await browser.close();
            return;
        }

        console.log("✅ Decathlon JSON extracted successfully!");
        const dktData = JSON.parse(dktString);

        const supermodelNode = dktData._ctx.data.find(item => item.type === 'Supermodel');
        if (!supermodelNode) {
            console.error("❌ Supermodel node not found in JSON");
            await browser.close();
            return;
        }

        const urlObj = new URL(TEST_URL);
        const targetModelId = urlObj.searchParams.get('mc');
        const targetModel = supermodelNode.data.models.find(m => m.modelId === targetModelId) || supermodelNode.data.models[0];

        console.log(`\n🎯 Model ID: ${targetModel.modelId}`);
        console.log(`🎨 Web Label: ${targetModel.webLabel}`);

        let extractedStocks = {};
        let finalPrice = null;

        targetModel.skus.forEach(sku => {
            if (!finalPrice && sku.price) finalPrice = sku.price;
            const isOut = sku.isNotAvailable === true || sku.isNotAvailableOnline === true;
            extractedStocks[sku.size] = isOut ? 0 : 5;
        });

        const hostname = urlObj.hostname;
        const normalizedStocks = {};
        for (const [key, val] of Object.entries(extractedStocks)) {
            const normKey = normalizeSize(key, hostname);
            if (normKey) normalizedStocks[normKey] = val;
        }

        console.log('\n--- RESULTS ---');
        console.log(`💰 Price: ${finalPrice} TL`);
        console.log('\n📦 Stocks (Raw):');
        console.table(extractedStocks);
        console.log('\n📦 Stocks (Normalized):');
        console.table(normalizedStocks);

    } catch (error) {
        console.error('❌ Error:', error);
        try {
            await page.screenshot({ path: 'debug_error_screenshot.png', fullPage: true });
            console.log('📸 Error screenshot saved.');
        } catch(e) {}
    } finally {
        await browser.close();
        console.log('\n🏁 Debugging finished.');
    }
}

debug();
