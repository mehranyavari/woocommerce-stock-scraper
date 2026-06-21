const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ==========================================
// 🔗 لینک تست
// ==========================================
const TEST_URL = "https://www.korayspor.com/asics-tenis-ayakkabisi-solution-speed-ff-3-1041a438-300/";

// ==========================================
// تنظیمات
// ==========================================
const CONFIG = {
    PAGE_TIMEOUT: 90000,
    WAIT_AFTER_LOAD: 5000
};

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

    // اگه عدد خالص float بود (از JSON، بدون فرمت‌بندی)
    const plain = parseFloat(str);
    if (!isNaN(plain) && !str.includes(',')) {
        return Math.ceil(plain);
    }

    // فرمت ترکی: 1.234,56 → 1234.56
    let clean = str.replace(/[^\d,\.]/g, '');

    const commaIdx = clean.lastIndexOf(',');
    const dotIdx = clean.lastIndexOf('.');

    if (commaIdx > dotIdx) {
        // فرمت ترکی: 1.234,56
        clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (dotIdx > commaIdx) {
        // فرمت انگلیسی یا float ساده: 1,234.56
        clean = clean.replace(/,/g, '');
    }

    const num = parseFloat(clean);
    if (isNaN(num)) return null;
    return Math.ceil(num);
}

// ==========================================
// 👟 اسکرپر مخصوص کورای اسپور
// ==========================================
async function scrapeKorayspor(browser, url) {
    console.log(`\n🔄 Scraping Korayspor: ${url}`);
    const page = await browser.newPage();

    try {
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

        await page.authenticate({ username: 'mehran', password: 'mehran75' });

        console.log(`  🔄 Visiting Korayspor homepage first...`);
        await page.goto('https://www.korayspor.com', {
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

        const hostname = new URL(page.url()).hostname;

        const nextDataString = await page.evaluate(() => {
            const scriptNode = document.getElementById('__NEXT_DATA__');
            return scriptNode ? scriptNode.innerHTML : null;
        });

        if (!nextDataString) {
            const bodyHtml = await page.evaluate(() => document.body ? document.body.innerHTML : '');
            const title = await page.title();
            fs.writeFileSync('korayspor_debug_dump.html', `<!-- Title: ${title} -->\n` + bodyHtml);
            await page.close();
            return { success: false, error: `Korayspor: __NEXT_DATA__ not found. Saved page source to korayspor_debug_dump.html. Title: ${title}` };
        }

        await page.close();

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

        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };

    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Korayspor Error: " + error.message };
    }
}

async function scrapeProduct(browser, url) {
    if (url.toLowerCase().includes('korayspor')) {
        return scrapeKorayspor(browser, url);
    }

    console.log(`\n🔄 Scraping: ${url}`);
    const page = await browser.newPage();

    try {
        await page.authenticate({ username: 'mehran', password: 'mehran75' });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_TIMEOUT });
        await new Promise(resolve => setTimeout(resolve, CONFIG.WAIT_AFTER_LOAD));

        const hostname = new URL(page.url()).hostname;

        const result = await page.evaluate(() => {
            const match = document.body.innerHTML.match(/var productDetailModel = (.*?);/);
            if (!match) return { success: false, error: "Variable 'productDetailModel' NOT found" };

            try {
                const data = JSON.parse(match[1]);
                const stocks = {};

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

                        const anaUrun = data.products.find(p => p.anaUrun === true) || data.products[0];
                        if (anaUrun && anaUrun.indirimliFiyati < anaUrun.satisFiyati) {
                            const ratio = anaUrun.indirimliFiyati / anaUrun.satisFiyati;
                            offerPrice = String(Math.ceil(data.productPriceKDVIncluded * ratio));
                        }
                    }
                    data.productVariantData.forEach(variant => {
                        if (variant.tanim && variant.urunID !== undefined)
                            stocks[variant.tanim] = stockMap[variant.urunID] || 0;
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

        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };

    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('🧪 TEST SINGLE PRODUCT');
    console.log('='.repeat(60));
    console.log('🔗 URL:', TEST_URL);

    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--proxy-server=http://45.145.20.148:3128'
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const result = await scrapeProduct(browser, TEST_URL);
    await browser.close();

    console.log('\n' + '='.repeat(60));
    if (!result.success) {
        console.log('❌ FAILED:', result.error);
        process.exit(1);
    }

    console.log('✅ SUCCESS!');
    console.log('💰 Regular Price:', result.regular_price, '₺');
    console.log('💰 Offer Price:  ', result.offer_price || 'N/A', result.offer_price ? '₺' : '');
    console.log('\n📦 Stocks:');
    Object.entries(result.stocks).forEach(([size, stock]) => {
        console.log(`   ${stock > 0 ? '✅' : '❌'}  ${size.padEnd(8)} → ${stock > 0 ? 'In Stock' : 'Out of Stock'}`);
    });

    fs.writeFileSync('debug_result.json', JSON.stringify(result, null, 2));
    console.log('\n💾 Result saved to: debug_result.json');
    console.log('='.repeat(60));
}

main().catch(err => {
    console.error('💥 Fatal Error:', err.message);
    process.exit(1);
});
