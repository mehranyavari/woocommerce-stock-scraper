const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

let useProxy = true;

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
async function scrapeKorayspor(page, url) {
    console.log(`\n🔄 Scraping Korayspor: ${url}`);

    try {
        // حذف setExtraHTTPHeaders و setViewport برای جلوگیری از خراب شدن فینگرپرینت PRB

        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
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

        if (!nextDataString) {
            const bodyHtml = await page.evaluate(() => document.body ? document.body.innerHTML : '');
            const title = await page.title();
            fs.writeFileSync('korayspor_debug_dump.html', `<!-- Title: ${title} -->\n` + bodyHtml);
            try { await page.screenshot({ path: 'korayspor_cloudflare_block.png', fullPage: true }); } catch (e) {}
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

async function scrapeProduct(page, url) {
    if (url.toLowerCase().includes('korayspor')) {
        return scrapeKorayspor(page, url);
    }

    console.log(`\n🔄 Scraping: ${url}`);

    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

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
    useProxy = !process.argv.includes('--no-proxy');
    console.log('='.repeat(60));
    console.log('🧪 TEST SINGLE PRODUCT');
    console.log('='.repeat(60));
    console.log('🔗 URL:', TEST_URL);
    console.log('🔌 Proxy Enabled:', useProxy);

    const launchArgs = [];
    if (useProxy) {
        launchArgs.push('--proxy-server=http://45.145.20.148:3128');
    }

    console.log('🚀 Launching puppeteer-real-browser...');
    const { browser, page } = await connect({
        headless: false,
        turnstile: true,
        disableXvfb: false,
        args: launchArgs
    });

    const result = await scrapeProduct(page, TEST_URL);
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
