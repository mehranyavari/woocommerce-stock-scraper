const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

// ==========================================
// ⚙️ تنظیمات
// ==========================================
let useProxy = true;

const CONFIG = {
    PAGE_TIMEOUT: 60000,
    DOM_WAIT_MS: 10000,
    DELAY_BETWEEN_PRODUCTS_MS: 2000
};

function normalizeSize(rawSize, hostname) {
    const trimmed = String(rawSize).trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower === 's-m') return 'S/M';
    if (lower === 'm-l') return 'M/L';
    if (lower === 'standart' || lower === 'one size' || lower === 'os') return 'Standart';

    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) return rangeMatch[1] + '-' + rangeMatch[2];

    const fractionMatch = trimmed.match(/(\d+)\s*(-?\s*\d+\/\d+)/);
    if (fractionMatch) {
        return (fractionMatch[1] + ' ' + fractionMatch[2].replace('-', '')).replace(/\s+/g, ' ');
    }

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
    const plain = parseFloat(str);
    if (!isNaN(plain) && !str.includes(',') && !str.includes('₺') && !str.includes('TL')) {
        return plain > 0 ? Math.ceil(plain) : null;
    }

    let clean = str.replace(/[^\d,\.]/g, '');
    const commaIdx = clean.lastIndexOf(',');
    const dotIdx = clean.lastIndexOf('.');

    if (dotIdx > commaIdx && commaIdx !== -1) {
        clean = clean.replace(/,/g, '');
    } else if (commaIdx > dotIdx && dotIdx !== -1) {
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
    } else if (commaIdx !== -1 && dotIdx === -1) {
        clean = clean.replace(/,/g, '.');
    } else if (dotIdx !== -1 && commaIdx === -1) {
        if (clean.length - dotIdx === 4) {
            clean = clean.replace(/\./g, '');
        }
    }

    const num = parseFloat(clean);
    if (isNaN(num) || num <= 0) return null;
    return Math.ceil(num);
}

function detectBrowserPath() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    const possiblePaths = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];
    for (const p of possiblePaths) {
        if (p && fs.existsSync(p)) return p;
    }
    return undefined;
}

// ==========================================
// 👟 اسکرپر دقیق DOM برای Korayspor
// ==========================================
async function scrapeKoraysporProduct(browser, url) {
    console.log(`  🔄 در حال بارگذاری صفحه: ${url}`);
    
    const page = await browser.newPage();
    
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.PAGE_TIMEOUT });
        console.log(`     ⏳ ۱۰ ثانیه انتظار برای رندر کامل دکمه‌ها و کلودفلر...`);
        await new Promise(r => setTimeout(r, CONFIG.DOM_WAIT_MS));

        const hostname = new URL(page.url()).hostname;

        // استخراج مستقیم از دکمه‌های رندر شده در DOM
        const domResult = await page.evaluate(() => {
            const sizeData = {};
            const buttons = document.querySelectorAll('button[data-test-id="available_size"], button[data-test-id="out_of_stock"], button[data-test-id^="prd_size_"], div[data-test-id="product_size_select"] ~ div button, .prd-detail-middle button');
            
            buttons.forEach(btn => {
                const clone = btn.cloneNode(true);
                clone.querySelectorAll('svg, span').forEach(el => el.remove());
                const sizeText = clone.textContent.trim();
                
                if (sizeText && sizeText.length <= 10 && !sizeText.includes('Beden') && !sizeText.includes('Hemen') && !sizeText.includes('Sepet') && !sizeText.includes('Listeye')) {
                    const testId = btn.getAttribute('data-test-id') || '';
                    const isOutOfStock = testId === 'out_of_stock' || 
                                         btn.classList.contains('disabled') || 
                                         btn.hasAttribute('disabled') || 
                                         btn.innerHTML.includes('after:rotate') || 
                                         btn.querySelector('svg.lucide-bell') !== null;
                    
                    sizeData[sizeText] = isOutOfStock ? 0 : 1;
                }
            });

            let nextProduct = null;
            try {
                const scriptNode = document.getElementById('__NEXT_DATA__');
                if (scriptNode) {
                    const nextData = JSON.parse(scriptNode.innerHTML);
                    nextProduct = nextData.props?.pageProps?.data?.response?.product || null;
                }
            } catch(e) {}

            return { domSizes: sizeData, nextProduct };
        });

        await page.close();

        let extractedStocks = domResult.domSizes || {};
        let regularPrice = null;
        let discountPrice = null;

        if (domResult.nextProduct) {
            const p = domResult.nextProduct;
            regularPrice = p.basePrice || p.salesPrice || null;
            discountPrice = p.discountPrice || null;

            // فال‌بک بارکدها در صورت خالی بودن دکمه‌های DOM
            if (Object.keys(extractedStocks).length === 0 && p.barcodes) {
                p.barcodes.forEach(bc => {
                    if (bc.stockTypeValues && bc.stockTypeValues[0]) {
                        const rawSize = bc.stockTypeValues[0].name;
                        let stockVal = 0;
                        if (p.stocksByBarcode) {
                            if (p.stocksByBarcode[bc.barcode] !== undefined) stockVal = p.stocksByBarcode[bc.barcode];
                            else if (p.stocksByBarcode[bc.id] !== undefined) stockVal = p.stocksByBarcode[bc.id];
                            else if (p.stocksByBarcode[bc.barcodeId] !== undefined) stockVal = p.stocksByBarcode[bc.barcodeId];
                            else if (bc.stock !== undefined) stockVal = bc.stock;
                        } else if (bc.stock !== undefined) {
                            stockVal = bc.stock;
                        }
                        extractedStocks[rawSize] = stockVal > 0 ? stockVal : 0;
                    }
                });
            }
        }

        const normalizedStocks = {};
        for (const [key, val] of Object.entries(extractedStocks)) {
            const normKey = normalizeSize(key, hostname);
            if (normKey) normalizedStocks[normKey] = val;
        }

        if (Object.keys(normalizedStocks).length === 0) {
            return { success: false, error: "دکمه‌های سایز یا بارکد یافت نشد" };
        }

        const regular = parseTurkishPrice(regularPrice);
        let offer = parseTurkishPrice(discountPrice);
        if (regular && offer && offer >= regular) offer = null;

        return {
            success: true,
            stocks: normalizedStocks,
            regular_price: regular,
            offer_price: offer,
            lastUpdated: new Date().toISOString()
        };

    } catch (err) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: err.message };
    }
}

// ==========================================
// 🚀 اجرای اصلی اسکریپت
// ==========================================
async function main() {
    useProxy = !process.argv.includes('--no-proxy');

    const productsFile = 'products_tennis24shop_com.json';
    const stockFile = 'stock-data_tennis24shop_com.json';

    if (!fs.existsSync(productsFile)) {
        console.error(`❌ فایل محصولات (${productsFile}) یافت نشد.`);
        process.exit(1);
    }

    const allProducts = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
    let stockData = {};
    if (fs.existsSync(stockFile)) {
        stockData = JSON.parse(fs.readFileSync(stockFile, 'utf8'));
    }

    // فیلتر تمام محصولاتی که لینک اول یا دوم آن‌ها korayspor است
    const korayProducts = allProducts.filter(p => {
        const u1 = (p.url || '').toLowerCase();
        const u2 = (p.secondary_url || '').toLowerCase();
        return u1.includes('korayspor') || u2.includes('korayspor');
    });

    console.log('='.repeat(70));
    console.log('  👟 اسکرپ اختصاصی و بروزرسانی موجودی‌های Korayspor');
    console.log('='.repeat(70));
    console.log(`📦 تعداد کل محصولات کاتالوگ: ${allProducts.length}`);
    console.log(`🎯 تعداد کل محصولات متصل به Korayspor: ${korayProducts.length}`);
    console.log(`🔌 وضعیت پروکسی: ${useProxy ? 'فعال' : 'غیرفعال'}`);
    console.log('='.repeat(70));

    if (korayProducts.length === 0) {
        console.log('ℹ️ هیچ محصولی با لینک Korayspor یافت نشد.');
        return;
    }

    const launchArgs = [];
    if (useProxy) {
        launchArgs.push('--proxy-server=http://45.145.20.148:3128');
    }

    const browserPath = detectBrowserPath();
    if (browserPath) {
        console.log(`🌐 مرورگر شناسایی شد: ${browserPath}`);
        process.env.CHROME_PATH = browserPath;
    }

    console.log('\n🚀 در حال راه‌اندازی مرورگر ضد کلودفلر (Puppeteer Real Browser)...');
    
    const connectOptions = {
        headless: false,
        turnstile: true,
        disableXvfb: false,
        args: launchArgs
    };
    if (browserPath) {
        connectOptions.customConfig = { executablePath: browserPath };
    }

    const { browser } = await connect(connectOptions);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < korayProducts.length; i++) {
        const item = korayProducts[i];
        
        // پیدا کردن لینک Korayspor (اول یا دوم)
        let korayUrl = item.url;
        if (!korayUrl || !korayUrl.toLowerCase().includes('korayspor')) {
            korayUrl = item.secondary_url;
        }

        console.log(`\n📌 [${i + 1}/${korayProducts.length}] بررسی محصول #${item.id}: ${item.title || ''}`);
        
        try {
            const result = await scrapeKoraysporProduct(browser, korayUrl);
            
            if (result.success) {
                // بروزرسانی موجودی و قیمت محصول در stock-data
                stockData[String(item.id)] = {
                    id: item.id,
                    success: true,
                    stocks: result.stocks,
                    regular_price: result.regular_price,
                    offer_price: result.offer_price,
                    lastUpdated: result.lastUpdated
                };

                console.log(`     ✅ موفق! قیمت: ${result.regular_price || '-'} ₺ | سایزها:`);
                Object.entries(result.stocks).forEach(([sz, st]) => {
                    console.log(`        ${st > 0 ? '🟢' : '🔴'} سایز ${sz.padEnd(6)} : ${st > 0 ? `موجود (${st})` : 'ناموجود (0)'}`);
                });

                successCount++;
            } else {
                console.log(`     ⚠️ خطا در استخراج #${item.id}: ${result.error}`);
                if (!stockData[String(item.id)]) {
                    stockData[String(item.id)] = {
                        id: item.id,
                        success: false,
                        error: `Korayspor: ${result.error}`,
                        lastUpdated: new Date().toISOString()
                    };
                }
                failCount++;
            }

            // ذخیره مرحله به مرحله در فایل JSON برای جلوگیری از اتلاف داده‌ها
            fs.writeFileSync(stockFile, JSON.stringify(stockData, null, 2), 'utf8');
            console.log(`     💾 فایل ${stockFile} آپدیت شد.`);

        } catch (err) {
            console.error(`     ❌ خطای غیرمنتظره در محصول #${item.id}:`, err.message);
            failCount++;
        }

        if (i < korayProducts.length - 1) {
            await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_PRODUCTS_MS));
        }
    }

    await browser.close();

    console.log('\n' + '='.repeat(70));
    console.log(`🏁 پایان فرآیند اسکرپ Korayspor!`);
    console.log(`✅ موفق: ${successCount} | ❌ ناموفق: ${failCount}`);
    console.log(`📁 فایل ذخیره نهایی: ${stockFile}`);
    console.log('='.repeat(70));
}

main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
});
