const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

let useProxy = true;

// تنظیمات
const CONFIG = {
    CONCURRENT_SCRAPES: 2,
    BATCH_SIZE: 10,
    BATCH_DELAY: 3000,
    PAGE_TIMEOUT: 90000,
    WAIT_AFTER_LOAD: 5000
};

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
    if (rawPrice === null || rawPrice === undefined || rawPrice === '') return null;
    if (typeof rawPrice === 'number') {
        return rawPrice > 0 ? Math.round(rawPrice) : null;
    }

    const str = String(rawPrice).trim();
    if (/^\d+$/.test(str)) {
        const val = parseInt(str, 10);
        return val > 0 ? val : null;
    }

    let clean = str.replace(/[^\d,\.]/g, '');
    if (!clean) return null;

    const commaIdx = clean.lastIndexOf(',');
    const dotIdx = clean.lastIndexOf('.');

    if (dotIdx !== -1 && commaIdx !== -1 && commaIdx > dotIdx) {
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
    } else if (dotIdx !== -1 && commaIdx !== -1 && dotIdx > commaIdx) {
        clean = clean.replace(/,/g, '');
    } else if (commaIdx !== -1 && dotIdx === -1) {
        clean = clean.replace(/,/g, '.');
    } else if (dotIdx !== -1 && commaIdx === -1) {
        const afterDot = clean.slice(dotIdx + 1);
        if (afterDot.length === 3) {
            clean = clean.replace(/\./g, '');
        }
    }

    const num = parseFloat(clean);
    if (isNaN(num) || num <= 0) return null;
    return Math.round(num);
}

// ==========================================
// 🚀 اسکرپر مخصوص دکتلون
// ==========================================
async function scrapeDecathlon(browser, url) {
    const page = await browser.newPage();
    try {
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
        });

        await page.emulateTimezone('Europe/Istanbul');
        await page.setViewport({ width: 1920, height: 1080 });

        console.log(`  🔄 Visiting Decathlon homepage first...`);
        await page.goto('https://www.decathlon.com.tr', {
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

        await page.close();

        if (!dktString) return { success: false, error: "Decathlon __DKT not found (Cloudflare Blocked)" };

        const dktData = JSON.parse(dktString);
        const supermodelNode = dktData._ctx.data.find(item => item.type === 'Supermodel');

        if (!supermodelNode || !supermodelNode.data || !supermodelNode.data.models) {
            return { success: false, error: "Product models not found in Decathlon JSON" };
        }

        const urlObj = new URL(url);
        const targetModelId = urlObj.searchParams.get('mc');
        const targetModel = supermodelNode.data.models.find(m => m.modelId === targetModelId) || supermodelNode.data.models[0];

        let extractedStocks = {};
        let finalPrice = null;

        targetModel.skus.forEach(sku => {
            if (!finalPrice && sku.price) finalPrice = sku.price;
            const isOut = sku.isNotAvailable === true || sku.isNotAvailableOnline === true;
            extractedStocks[sku.size] = isOut ? 0 : 5;
        });

        const normalizedStocks = {};
        const hostname = urlObj.hostname;
        for (const [key, val] of Object.entries(extractedStocks)) {
            const normKey = normalizeSize(key, hostname);
            if (normKey) normalizedStocks[normKey] = val;
        }

        const price = parseTurkishPrice(finalPrice);
        console.log(`  ✅ Decathlon URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: price, offer_price: price };

    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Decathlon Error: " + error.message };
    }
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
async function scrapeKorayspor(browser, url) {
    const page = await browser.newPage();
    try {
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
        });

        await page.emulateTimezone('Europe/Istanbul');
        await page.setViewport({ width: 1920, height: 1080 });

        if (useProxy) {
            await page.authenticate({
                username: 'mehran',
                password: 'mehran75'
            });
        }

        console.log(`  🔄 Navigating to product page...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log(`  ⏳ Waiting 10s to let Cloudflare pass and DOM render...`);
        await new Promise(r => setTimeout(r, 10000));

        const hostname = new URL(page.url()).hostname;

        // ۱. استخراج مستقیم و ۱۰۰٪ دقیق از دکمه‌های سایز رندر شده در صفحه (DOM Evaluation)
        const domResult = await page.evaluate(() => {
            const sizeData = {};
            
            // پیدا کردن تمام دکمه‌های انتخاب سایز
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

            // استخراج داده‌های NEXT_DATA برای قیمت یا فال‌بک
            let nextProduct = null;
            try {
                const scriptNode = document.getElementById('__NEXT_DATA__');
                if (scriptNode) {
                    const nextData = JSON.parse(scriptNode.innerHTML);
                    nextProduct = nextData.props?.pageProps?.data?.response?.product || null;
                }
            } catch(e) {}

            return {
                domSizes: sizeData,
                nextProduct: nextProduct
            };
        });

        await page.close();

        let extractedStocks = domResult.domSizes || {};
        let regularPrice = null;
        let discountPrice = null;

        if (domResult.nextProduct) {
            const p = domResult.nextProduct;
            regularPrice = p.basePrice || p.salesPrice || null;
            discountPrice = p.discountPrice || null;

            // اگر دکمه‌های DOM به هر دلیلی خالی بودند، از ساختار بارکدهای NEXT_DATA استفاده کن
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
            return { success: false, error: "Korayspor: No size buttons or barcodes found" };
        }

        const regular = parseTurkishPrice(regularPrice);
        let offer = parseTurkishPrice(discountPrice);
        if (regular && offer && offer >= regular) offer = null;

        console.log(`  ✅ Korayspor URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };

    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Korayspor Error: " + error.message };
    }
}

// ==========================================
// 🛒 اسکرپر استاندارد (سایر سایت‌ها)
// ==========================================
async function scrapeProduct(browser, productObj, isSecondary = false) {
    const urlLabel = isSecondary ? "Secondary URL" : "Primary URL";
    console.log(`Scraping ${urlLabel} for product ${productObj.id}: ${productObj.url}`);

    const page = await browser.newPage();

    try {
        if (useProxy) {
            await page.authenticate({
                username: 'mehran',
                password: 'mehran75'
            });
        }

        try {
            await page.goto(productObj.url, { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_TIMEOUT });
        } catch (navError) {
            throw new Error(`Navigation Error: ${navError.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, CONFIG.WAIT_AFTER_LOAD));

        const hostname = new URL(page.url()).hostname;

        const result = await page.evaluate(() => {
            const match = document.body.innerHTML.match(/var productDetailModel = (.*?);/);
            if (!match) return { success: false, error: "Variable 'productDetailModel' NOT found" };

            try {
                const data = JSON.parse(match[1]);
                const stocks = {};

                let regularPrice = null;
                let offerPrice = null;

                const anaUrun = (data.products && data.products.find(p => p.anaUrun === true)) || (data.products && data.products[0]) || data.product || {};

                // استخراج قیمت‌ها از ساختار استاندارد Ticimax
                const satis = anaUrun.satisFiyatiStr || (anaUrun.satisFiyati && anaUrun.satisKDV ? (anaUrun.satisFiyati + anaUrun.satisKDV) : anaUrun.satisFiyati);
                const indirimli = anaUrun.indirimliFiyatiStr || (anaUrun.indirimliFiyati && anaUrun.indirimliKDV ? (anaUrun.indirimliFiyati + anaUrun.indirimliKDV) : anaUrun.indirimliFiyati);
                const piyasa = anaUrun.piyasaFiyatiStr || (anaUrun.piyasaFiyati && anaUrun.piyasaFiyatiKDV ? (anaUrun.piyasaFiyati + anaUrun.piyasaFiyatiKDV) : anaUrun.piyasaFiyati);

                if (anaUrun.indirimliFiyati && anaUrun.satisFiyati && anaUrun.indirimliFiyati > 0 && anaUrun.indirimliFiyati < anaUrun.satisFiyati) {
                    regularPrice = satis;
                    offerPrice = indirimli;
                } else if (anaUrun.piyasaFiyati && anaUrun.satisFiyati && anaUrun.piyasaFiyati > anaUrun.satisFiyati && anaUrun.satisFiyati > 0) {
                    regularPrice = piyasa;
                    offerPrice = satis;
                } else {
                    regularPrice = satis || data.productPriceKDVIncluded || data.productPriceStr;
                    offerPrice = null;
                }

                // فال‌بک از ساختار DOM در صورت نیاز
                if (!regularPrice) {
                    const priceEl = document.querySelector('#fiyat .spanFiyat, .PiyasafiyatiContent .spanFiyat, .spanFiyat');
                    const discountEl = document.querySelector('#indirimliFiyat .spanFiyat, .IndirimliFiyatContent .spanFiyat, .indirimliFiyat .spanFiyat');
                    if (priceEl && discountEl) {
                        regularPrice = priceEl.innerText.trim();
                        offerPrice = discountEl.innerText.trim();
                    } else if (priceEl) {
                        regularPrice = priceEl.innerText.trim();
                    }
                }

                if (data.productVariantData && Array.isArray(data.productVariantData) && data.productVariantData.length > 0) {
                    const stockMap = {};
                    if (data.products && Array.isArray(data.products)) {
                        data.products.forEach(p => {
                            if (p.id !== undefined && p.stokAdedi !== undefined) stockMap[p.id] = parseInt(p.stokAdedi);
                        });
                    }
                    data.productVariantData.forEach(variant => {
                        if (variant.tanim && variant.urunID !== undefined) stocks[variant.tanim] = stockMap[variant.urunID] || 0;
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
        if (offer && regular && offer >= regular) offer = null;

        console.log(`  ✅ ${urlLabel} Success: ${Object.keys(normalizedStocks).length} variants found. Price: ${regular} ₺`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
    } catch (error) {
        try { await page.close(); } catch(e){}
        return { success: false, error: error.message };
    }
}

async function scrapeTenisBurada(browser, url) {
    const page = await browser.newPage();
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 15000));
        
        const hostname = new URL(page.url()).hostname;
        
        const result = await page.evaluate(() => {
            let basePrice = 0;
            let salePrice = 0;
            const stockData = {};
            
            if (typeof window.PRODUCT_DATA !== 'undefined' && window.PRODUCT_DATA.length > 0) {
                const product = window.PRODUCT_DATA[0];
                basePrice = product.total_base_price || product.price || 0;
                salePrice = product.total_sale_price || product.sale_price || 0;
                
                if (window.PRODUCT_DATA.length > 1) {
                    window.PRODUCT_DATA.forEach(p => {
                        const size = p.variant1 || p.variant2 || p.subproduct_name || 'Standart';
                        stockData[size] = p.quantity > 0;
                    });
                } else if (typeof window.sub_products !== 'undefined' && window.sub_products.length > 0) {
                    window.sub_products.forEach(sp => {
                        const size = sp.variant1 || sp.variant2 || sp.name || sp.value || 'Standart';
                        stockData[size] = sp.stock > 0 || sp.quantity > 0;
                    });
                } else {
                    stockData['Standart'] = product.quantity > 0;
                }
            }
            
            if (Object.keys(stockData).length === 0 || (Object.keys(stockData).length === 1 && stockData['Standart'] !== undefined)) {
                let domFound = false;
                const variantLinks = document.querySelectorAll('a[data-id], .variant a, .size a, .beden a, .variantItem, [data-toggle="variant"]');
                variantLinks.forEach(a => {
                    const size = a.getAttribute('data-type') || a.innerText.trim();
                    const isOutOfStock = a.classList.contains('passive') || a.classList.contains('out-of-stock') || a.classList.contains('disabled') || a.getAttribute('data-instock') === '0' || a.getAttribute('data-stock') === '0';
                    if (size && size.length < 30) {
                        stockData[size.trim()] = !isOutOfStock;
                        domFound = true;
                    }
                });
                if (domFound) delete stockData['Standart'];
            }
            
            return { success: true, price: basePrice, offerPrice: salePrice, stocks: stockData };
        });
        
        await page.close();
        
        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;
        
        console.log(`  ✅ Tenisburada URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "TenisBurada Error: " + error.message };
    }
}

// ==========================================
// 🎾 اسکرپر مخصوص اوپسار اسپورت (OpsarSport)
// ==========================================
async function scrapeOpsarSport(browser, url) {
    const page = await browser.newPage();
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 15000));
        
        const hostname = new URL(page.url()).hostname;
        
        const result = await page.evaluate(() => {
            let basePrice = 0;
            let salePrice = 0;
            const stockData = {};
            
            // Try to get price from pageParams (IdeaSoft)
            if (typeof pageParams !== 'undefined' && pageParams.product) {
                // In IdeaSoft, price is sometimes without tax, so we calculate it just in case
                const taxMultiplier = 1 + ((pageParams.product.tax || 0) / 100);
                const p1 = parseFloat(pageParams.product.priceWithCurrency || 0) * taxMultiplier;
                const p2 = parseFloat(pageParams.product.salePrice || 0) * taxMultiplier;
                
                if (p2 < p1 && p2 > 0) {
                    basePrice = p1;
                    salePrice = p2;
                } else {
                    basePrice = p1;
                    salePrice = 0; // No discount
                }
            }
            
            // Get sizes from DOM
            let domFound = false;
            const variantSpans = document.querySelectorAll('.variant-list .variant-text, .product-options .variant-text');
            variantSpans.forEach(span => {
                const size = span.innerText.trim();
                const isOutOfStock = span.classList.contains('passive') || span.classList.contains('disabled') || span.classList.contains('out-of-stock');
                if (size && size.length < 30) {
                    stockData[size] = !isOutOfStock;
                    domFound = true;
                }
            });
            
            if (!domFound && typeof pageParams !== 'undefined' && pageParams.product && pageParams.product.quantity) {
                stockData['Standart'] = pageParams.product.quantity > 0;
            }
            
            return { success: true, price: basePrice, offerPrice: salePrice, stocks: stockData };
        });
        
        await page.close();
        
        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;
        
        console.log(`  ✅ OpsarSport URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "OpsarSport Error: " + error.message };
    }
}

// ==========================================
// 🏓 اسکرپر مخصوص راکت‌چی (Raketci)
// ==========================================
async function scrapeRaketci(browser, url) {
    const page = await browser.newPage();
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 10000));
        
        const hostname = new URL(page.url()).hostname;
        
        const result = await page.evaluate(() => {
            let basePrice = null;
            let salePrice = null;
            let stockData = {};
            
            // WooCommerce Variations Form Data
            const form = document.querySelector('form.variations_form');
            if (form) {
                const varData = form.getAttribute('data-product_variations');
                if (varData) {
                    try {
                        const variations = JSON.parse(varData);
                        variations.forEach(v => {
                            let size = '';
                            for (let key in v.attributes) {
                                if (v.attributes[key]) {
                                    size = v.attributes[key];
                                    break;
                                }
                            }
                            if (size) {
                                size = size.replace('-', '.');
                                stockData[size] = v.is_in_stock;
                            }
                            
                            // Prices from the first valid variation
                            if (basePrice === null) {
                                basePrice = v.display_regular_price || null;
                                salePrice = v.display_price || null;
                            }
                        });
                    } catch (e) {}
                }
            }
            
            // Fallback to WooCommerce DOM (Swatches)
            if (Object.keys(stockData).length === 0) {
                const lis = document.querySelectorAll('li.variable-item');
                lis.forEach(li => {
                    const title = li.getAttribute('data-title') || li.getAttribute('title');
                    let size = li.getAttribute('data-value') || title;
                    if (!size) {
                        const span = li.querySelector('.variable-item-span');
                        if (span) size = span.innerText.trim();
                    }
                    if (size) {
                        size = size.replace('-', '.');
                        const isOut = li.classList.contains('disabled');
                        stockData[size] = !isOut;
                    }
                });
            }
            
            // Fallback for simple products
            if (Object.keys(stockData).length === 0) {
                const outOfStockEl = document.querySelector('.out-of-stock');
                stockData['Standart'] = !outOfStockEl;
            }
            
            // Fallback for Price from DOM
            if (basePrice === null) {
                const priceWrapper = document.querySelector('.summary .price, .product-info .price, .price');
                if (priceWrapper) {
                    const del = priceWrapper.querySelector('del .amount');
                    const ins = priceWrapper.querySelector('ins .amount');
                    if (del && ins) {
                        basePrice = del.innerText;
                        salePrice = ins.innerText;
                    } else {
                        const amt = priceWrapper.querySelector('.amount');
                        if (amt) basePrice = amt.innerText;
                    }
                }
            }
            
            return { success: true, price: basePrice, offerPrice: salePrice, stocks: stockData };
        });
        
        await page.close();
        
        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (offer && regular && offer >= regular) offer = null;
        
        console.log(`  ✅ Raketci URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Raketci Error: " + error.message };
    }
}

// ==========================================
// 🏬 اسکرپر مخصوص اینتر اسپورت (Intersport)
// ==========================================
async function scrapeIntersport(browser, url) {
    console.log(`[${new Date().toISOString()}] Scraping Intersport: ${url}`);
    const page = await browser.newPage();
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // منتظر لود شدن و بایپس احتمالی کلودفلر
        await new Promise(r => setTimeout(r, 8000));

        const isBlocked = await page.evaluate(() => {
            const title = (document.title || '').toLowerCase();
            return title.includes('just a moment') || title.includes('attention required') || title.includes('cloudflare') || title.includes('bir dakika') || title.includes('lütfen');
        });

        if (isBlocked) {
            console.log(`  ⏳ Cloudflare challenge detected, waiting extra 10s...`);
            await new Promise(r => setTimeout(r, 10000));
        }

        // منتظر لود شدن کامپوننت‌های اکینون و داده‌ها
        await page.waitForFunction(() => {
            return document.querySelectorAll('pz-variant-option, script[type="application/ld+json"], .price, .product-price, pz-price, .option.-size').length > 0;
        }, { timeout: 15000 }).catch(() => {});

        const hostname = new URL(page.url()).hostname;
        
        const result = await page.evaluate(() => {
            let basePrice = null;
            let salePrice = null;
            const stockData = {};
            
            // 1. استخراج قیمت از Structured Data (LD+JSON) با textContent
            try {
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                scripts.forEach(s => {
                    const text = s.textContent || s.innerHTML;
                    if (!text) return;
                    try {
                        const data = JSON.parse(text);
                        if (data['@type'] === 'Product' && data.offers) {
                            const offers = Array.isArray(data.offers) ? data.offers[0] : data.offers;
                            if (offers && offers.price) {
                                basePrice = offers.price;
                                salePrice = basePrice;
                            }
                        }
                    } catch(e) {}
                });
            } catch(e) {}
            
            // 2. فال‌بک قیمت از ساختار DOM
            if (!basePrice) {
                const discountedEl = document.querySelector('.discounted-price');
                const currentEl = document.querySelector('.current-price');
                const pzPriceEl = document.querySelector('pz-price');
                const priceEl = document.querySelector('.price, .product-price, .price-row, .product-info__price, .price-info');
                
                if (discountedEl && currentEl) {
                    basePrice = discountedEl.innerText.trim();
                    salePrice = currentEl.innerText.trim();
                } else if (pzPriceEl) {
                    basePrice = pzPriceEl.innerText.trim();
                } else if (priceEl) {
                    basePrice = priceEl.innerText.trim();
                }
            }

            // 3. استخراج سایزها از ساختار Akinon (pz-variant-option)
            const variants = document.querySelectorAll('pz-variant-option');
            if (variants.length > 0) {
                variants.forEach(v => {
                    const size = v.getAttribute('label') || v.getAttribute('value') || v.innerText.trim();
                    if (!size) return;
                    
                    const urlAttr = v.getAttribute('url') || '';
                    const isSelectable = v.hasAttribute('selectable');
                    
                    let isStock = isSelectable;
                    
                    const currentPath = window.location.pathname.replace(/\/$/, '');
                    const variantPath = urlAttr.replace(/\/$/, '');
                    
                    if (!isSelectable && currentPath === variantPath) {
                         const addBtn = document.querySelector('pz-button[action="addProduct"], .js-add-to-basket, .add-to-cart, .btn-add-to-cart');
                         if (addBtn && !addBtn.hasAttribute('disabled')) {
                              isStock = true;
                         }
                    }
                    
                    if (stockData[size] === undefined || isStock) {
                        stockData[size] = isStock;
                    }
                });
            }

            // 4. فال‌بک سایزها از DOM عمومی
            if (Object.keys(stockData).length === 0) {
                const sizeButtons = document.querySelectorAll('.option.-size, .variant-size, .product-detail__variant, .size-selector option, label.size, button.size');
                sizeButtons.forEach(btn => {
                    const size = btn.getAttribute('data-label') || btn.getAttribute('data-size') || btn.innerText.trim();
                    if (size && size.length < 15) {
                        const isOutOfStock = btn.classList.contains('-disabled') || btn.classList.contains('disabled') || btn.classList.contains('passive') || btn.disabled || btn.getAttribute('data-stock') === '0';
                        if (stockData[size] === undefined || !isOutOfStock) {
                            stockData[size] = !isOutOfStock;
                        }
                    }
                });
            }
            
            return { success: true, price: basePrice, offerPrice: salePrice, stocks: stockData };
        });
        
        await page.close();

        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (offer && regular && offer >= regular) offer = null;
        
        console.log(`  ✅ Intersport URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Intersport Error: " + error.message };
    }
}

// ==========================================
// 🏃‍♂️ اسکرپر مخصوص اسپورت‌این (Sportinn)
// ==========================================
async function scrapeSportinn(browser, url) {
    const page = await browser.newPage();
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 10000));
        
        const hostname = new URL(page.url()).hostname;
        
        const result = await page.evaluate(() => {
            let basePrice = null;
            let salePrice = null;
            const stockData = {};
            
            // Sizes
            const variantLinks = document.querySelectorAll('a[data-variant], a[data-id]');
            variantLinks.forEach(a => {
                const size = a.getAttribute('data-variant') || a.innerText.trim();
                const isColor = !a.hasAttribute('data-group-id') && !a.classList.contains('box-border') && !a.querySelector('p');
                if (!isColor && size && size.length < 20) {
                    const isOutOfStock = a.classList.contains('passive') || a.classList.contains('disabled') || a.getAttribute('data-stock') === '0';
                    stockData[size] = !isOutOfStock;
                }
            });
            
            if (Object.keys(stockData).length === 0) {
                const isOutOfStock = !!document.querySelector('.out-of-stock');
                stockData['Standart'] = !isOutOfStock;
            }
            
            // Prices
            const priceEl = document.querySelector('.product-price');
            const discountEl = document.querySelector('.product-discount-price');
            const oldPriceEl = document.querySelector('.product-old-price');
            
            if (oldPriceEl && priceEl) {
                basePrice = oldPriceEl.innerText.trim();
                salePrice = priceEl.innerText.trim();
            } else if (discountEl && priceEl) {
                basePrice = priceEl.innerText.trim();
                salePrice = discountEl.innerText.trim();
            } else if (priceEl) {
                basePrice = priceEl.innerText.trim();
            }
            
            return { success: true, price: basePrice, offerPrice: salePrice, stocks: stockData };
        });
        
        await page.close();
        
        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;
        
        console.log(`  ✅ Sportinn URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Sportinn Error: " + error.message };
    }
}

// ==========================================
// 🏃‍♂️ اسکرپر مخصوص اسیکس (Asics)
// ==========================================
async function scrapeAsics(browser, url) {
    const page = await browser.newPage();
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction('typeof window.productDetailModel !== "undefined"', { timeout: 15000 }).catch(() => {});
        
        const hostname = new URL(page.url()).hostname;
        
        const result = await page.evaluate(() => {
            if (typeof window.productDetailModel === 'undefined' || !window.productDetailModel.products) {
                return { success: false, error: "productDetailModel not found" };
            }
            const d = window.productDetailModel;
            const stockData = {};
            
            d.products.forEach(p => {
                const variants = d.productVariantData.filter(v => v.urunID === p.id);
                variants.forEach(v => {
                    const size = v.tanim.trim();
                    const isColor = size.includes('/') || size.toLowerCase().includes('white') || size.toLowerCase().includes('black') || size.toLowerCase().includes('blue') || size.toLowerCase().includes('red');
                    if (!isColor && size.length < 20) {
                        stockData[size] = p.stokAdedi > 0;
                    }
                });
            });
            
            if (Object.keys(stockData).length === 0 && d.product) {
                stockData['Standart'] = d.product.stokAdedi > 0;
            }
            
            const basePrice = d.product.satisFiyatiStr || d.product.satisFiyati;
            const salePrice = d.product.indirimliFiyatiStr || d.product.indirimliFiyati;
            
            return { success: true, price: basePrice, offerPrice: salePrice, stocks: stockData };
        });
        
        await page.close();
        
        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;
        
        console.log(`  ✅ Asics URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Asics Error: " + error.message };
    }
}

// ==========================================
// 🏃‍♂️ اسکرپر مخصوص آدیداس (Adidas)
// ==========================================
async function scrapeAdidas(browser, url) {
    const page = await browser.newPage();
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction('document.getElementById("__NEXT_DATA__") !== null', { timeout: 15000 }).catch(() => {});
        
        const hostname = new URL(page.url()).hostname;
        
        const urlParts = url.split('/');
        let productId = urlParts[urlParts.length - 1].replace('.html', '').trim();
        if (!productId) productId = urlParts[urlParts.length - 2].replace('.html', '').trim();
        
        const result = await page.evaluate(async (productId) => {
            let basePrice = null;
            let salePrice = null;
            const stockData = {};
            
            // 1. Get Price from __NEXT_DATA__
            try {
                const nextDataEl = document.getElementById('__NEXT_DATA__');
                if (nextDataEl) {
                    const nextData = JSON.parse(nextDataEl.innerText);
                    let foundProduct = null;
                    function findProd(obj) {
                        if (!obj || typeof obj !== 'object' || foundProduct) return;
                        if (obj.id === productId && obj.pricing_information) {
                            foundProduct = obj;
                            return;
                        }
                        for (let k in obj) {
                            if (typeof obj[k] === 'object') findProd(obj[k]);
                        }
                    }
                    findProd(nextData);
                    
                    if (foundProduct && foundProduct.pricing_information) {
                        if (Array.isArray(foundProduct.pricing_information)) {
                            const original = foundProduct.pricing_information.find(p => p.type === 'original' || p.type === 'standard');
                            const sale = foundProduct.pricing_information.find(p => p.type === 'sale');
                            if (original) basePrice = original.value;
                            if (sale) salePrice = sale.value;
                        } else {
                            basePrice = foundProduct.pricing_information.standard_price;
                            salePrice = foundProduct.pricing_information.sale_price;
                        }
                    }
                }
            } catch(e) {}
            
            // 2. Fetch Availability via API
            try {
                const res = await fetch(`https://www.adidas.com.tr/api/products/${productId}/availability`);
                if (res.ok) {
                    const availData = await res.json();
                    if (availData && availData.variation_list) {
                        availData.variation_list.forEach(v => {
                            if (v.size) {
                                const isStock = v.availability_status === 'IN_STOCK' || v.availability > 0;
                                stockData[v.size] = isStock;
                            }
                        });
                    }
                }
            } catch(e) {}
            
            // 3. Fallback to DOM parsing for sizes
            if (Object.keys(stockData).length === 0) {
                const sizeButtons = document.querySelectorAll('button[class*="size"], button.gl-label, .size-selector button');
                sizeButtons.forEach(btn => {
                    const size = btn.innerText.trim();
                    if (size && size.length < 20) {
                        const isOutOfStock = btn.classList.contains('gl-label--disabled') || btn.disabled || btn.getAttribute('aria-disabled') === 'true';
                        stockData[size] = !isOutOfStock;
                    }
                });
            }
            
            // 4. Fallback for price from DOM
            if (!basePrice) {
                const priceEl = document.querySelector('.gl-price-item--crossed, .gl-price-item');
                const saleEl = document.querySelector('.gl-price-item--sale');
                if (priceEl && saleEl) {
                    basePrice = priceEl.innerText.trim();
                    salePrice = saleEl.innerText.trim();
                } else if (priceEl) {
                    basePrice = priceEl.innerText.trim();
                }
            }
            
            return { success: true, price: basePrice, offerPrice: salePrice, stocks: stockData };
        }, productId);
        
        await page.close();
        
        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;
        
        console.log(`  ✅ Adidas URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "Adidas Error: " + error.message };
    }
}

// ==========================================
// 🧱 اسکرپر مخصوص لگو (LEGO.tr)
// ==========================================
async function scrapeLegoTr(browser, url) {
    const page = await browser.newPage();
    try {
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
        });
        await page.setViewport({ width: 1920, height: 1080 });

        if (useProxy) {
            await page.authenticate({
                username: 'mehran',
                password: 'mehran75'
            });
        }

        console.log(`  🔄 Navigating to LEGO product page...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 6000));

        const hostname = new URL(page.url()).hostname;

        const result = await page.evaluate(() => {
            let regularPrice = 0;
            let offerPrice = null;
            const stockData = {};

            // 1. بررسی آبجکت PRODUCT_DATA
            let pd = null;
            const scriptElements = Array.from(document.querySelectorAll('script'));
            for (const s of scriptElements) {
                const text = s.innerHTML || '';
                const m = text.match(/PRODUCT_DATA\.push\(JSON\.parse\('([\s\S]+?)'\)\);/);
                if (m) {
                    try {
                        const decoded = m[1]
                            .replace(/\\'/g, "'")
                            .replace(/\\\\"/g, '"')
                            .replace(/\\"/g, '"')
                            .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
                            .replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
                        pd = JSON.parse(decoded);
                        break;
                    } catch(e) {}
                }
            }

            // 2. استخراج قیمت‌ها
            if (pd) {
                const baseP = pd.total_base_price || pd.old_price || pd.base_price || pd.total_price || pd.price;
                const saleP = pd.total_sale_price || pd.sale_price;
                if (baseP && saleP && saleP < baseP) {
                    regularPrice = baseP;
                    offerPrice = saleP;
                } else {
                    regularPrice = baseP || saleP;
                    offerPrice = null;
                }
            }

            const notDiscountedEl = document.querySelector('.product-price-not-discounted');
            if (notDiscountedEl && notDiscountedEl.innerText.trim()) {
                regularPrice = notDiscountedEl.innerText.trim();
            }

            const vatIncludedEl = document.querySelector('#product-price-vat-include');
            if (vatIncludedEl && vatIncludedEl.value && !regularPrice) {
                regularPrice = vatIncludedEl.value;
            }

            const currentPriceEl = document.querySelector('.product-current-price .product-price, .product-price');
            if (currentPriceEl && currentPriceEl.innerText.trim()) {
                if (notDiscountedEl) {
                    offerPrice = currentPriceEl.innerText.trim();
                } else if (!regularPrice) {
                    regularPrice = currentPriceEl.innerText.trim();
                }
            }

            // 3. بررسی موجودی انبار
            if (pd) {
                const qty = typeof pd.quantity === 'number' ? pd.quantity : 0;
                const inStock = qty > 0 || pd.available === true || pd.available === 'true' || pd.available === 1;
                stockData['Standart'] = inStock ? (qty > 0 ? qty : 5) : 0;
            } else {
                const metaAvail = document.querySelector('meta[property="product:availability"]');
                const isMetaInStock = metaAvail && metaAvail.content && metaAvail.content.toLowerCase().includes('in stock');
                const isOutOfStock = !!document.querySelector('.out-of-stock, .tuken-btn, [data-stock="0"]');
                stockData['Standart'] = (!isOutOfStock || isMetaInStock) ? 5 : 0;
            }

            return {
                success: true,
                regularPrice,
                offerPrice,
                stocks: stockData
            };
        });

        await page.close();

        if (!result.success) return { success: false, error: "LEGO.tr Extraction Failed" };

        const normalizedStocks = {};
        for (const [rawSize, qty] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = qty;
        }

        const regular = parseTurkishPrice(result.regularPrice);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;

        console.log(`  ✅ LEGO.tr URL Scraped: Regular: ${regular}₺, Offer: ${offer || '-'}₺, Stock: ${JSON.stringify(normalizedStocks)}`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };

    } catch (error) {
        try { await page.close(); } catch(e) {}
        return { success: false, error: "LEGO.tr Error: " + error.message };
    }
}

function getEffectivePrice(scrapeData) {
    if (!scrapeData || !scrapeData.success) return 0;
    const reg = typeof scrapeData.regular_price === 'number' ? scrapeData.regular_price : parseFloat(scrapeData.regular_price) || 0;
    const off = typeof scrapeData.offer_price === 'number' ? scrapeData.offer_price : parseFloat(scrapeData.offer_price) || 0;
    return Math.max(reg, off);
}

async function processProduct(browser, product) {
    let primaryData = { success: false, error: "No Primary URL", stocks: {} };
    let secondaryData = { success: false, error: "No Secondary URL", stocks: {} };

    if (product.url) {
        if (product.url.toLowerCase().includes('decathlon')) {
            console.log(`Scraping Primary URL for product ${product.id} (Decathlon Engine)`);
            primaryData = await scrapeDecathlon(browser, product.url);
        } else if (product.url.toLowerCase().includes('korayspor')) {
            console.log(`Scraping Primary URL for product ${product.id} (Korayspor Engine)`);
            primaryData = await scrapeKorayspor(browser, product.url);
        } else if (product.url.toLowerCase().includes('lego.tr')) {
            console.log(`Scraping Primary URL for product ${product.id} (LEGO.tr Engine)`);
            primaryData = await scrapeLegoTr(browser, product.url);
        } else if (product.url.toLowerCase().includes('tenisburada.com')) {
            console.log(`Scraping Primary URL for product ${product.id} (Tenisburada Engine)`);
            primaryData = await scrapeTenisBurada(browser, product.url);
        } else if (product.url.toLowerCase().includes('opsarsport.com')) {
            console.log(`Scraping Primary URL for product ${product.id} (OpsarSport Engine)`);
            primaryData = await scrapeOpsarSport(browser, product.url);
        } else if (product.url.toLowerCase().includes('raketci.com')) {
            console.log(`Scraping Primary URL for product ${product.id} (Raketci Engine)`);
            primaryData = await scrapeRaketci(browser, product.url);
        } else if (product.url.toLowerCase().includes('sportinn.com.tr')) {
            console.log(`Scraping Primary URL for product ${product.id} (Sportinn Engine)`);
            primaryData = await scrapeSportinn(browser, product.url);
        } else if (product.url.toLowerCase().includes('asics.com.tr')) {
            console.log(`Scraping Primary URL for product ${product.id} (Asics Engine)`);
            primaryData = await scrapeAsics(browser, product.url);
        } else if (product.url.toLowerCase().includes('intersport.com.tr')) {
            console.log(`Scraping Primary URL for product ${product.id} (Intersport Engine)`);
            primaryData = await scrapeIntersport(browser, product.url);
        } else if (product.url.toLowerCase().includes('adidas.com.tr')) {
            console.log(`Scraping Primary URL for product ${product.id} (Adidas Engine)`);
            primaryData = await scrapeAdidas(browser, product.url);
        } else {
            primaryData = await scrapeProduct(browser, { id: product.id, url: product.url }, false);
        }
    }

    if (product.secondary_url) {
        if (product.secondary_url.toLowerCase().includes('decathlon')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Decathlon Engine)`);
            secondaryData = await scrapeDecathlon(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('korayspor')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Korayspor Engine)`);
            secondaryData = await scrapeKorayspor(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('lego.tr')) {
            console.log(`Scraping Secondary URL for product ${product.id} (LEGO.tr Engine)`);
            secondaryData = await scrapeLegoTr(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('tenisburada.com')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Tenisburada Engine)`);
            secondaryData = await scrapeTenisBurada(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('opsarsport.com')) {
            console.log(`Scraping Secondary URL for product ${product.id} (OpsarSport Engine)`);
            secondaryData = await scrapeOpsarSport(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('raketci.com')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Raketci Engine)`);
            secondaryData = await scrapeRaketci(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('sportinn.com.tr')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Sportinn Engine)`);
            secondaryData = await scrapeSportinn(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('asics.com.tr')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Asics Engine)`);
            secondaryData = await scrapeAsics(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('intersport.com.tr')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Intersport Engine)`);
            secondaryData = await scrapeIntersport(browser, product.secondary_url);
        } else if (product.secondary_url.toLowerCase().includes('adidas.com.tr')) {
            console.log(`Scraping Secondary URL for product ${product.id} (Adidas Engine)`);
            secondaryData = await scrapeAdidas(browser, product.secondary_url);
        } else {
            secondaryData = await scrapeProduct(browser, { id: product.id, url: product.secondary_url }, true);
        }
    }

    const primarySuccess = primaryData.success;
    const secondarySuccess = secondaryData.success;

    if (!primarySuccess && !secondarySuccess) {
        return {
            id: product.id,
            success: false,
            error: `Primary: ${primaryData.error} | Secondary: ${secondaryData.error}`,
            lastUpdated: new Date().toISOString()
        };
    }

    let priceWinner = null;
    if (primarySuccess && secondarySuccess) {
        const price1 = getEffectivePrice(primaryData);
        const price2 = getEffectivePrice(secondaryData);
        priceWinner = (price2 > price1) ? secondaryData : primaryData;
        console.log(`  ⚖️ Comparing Prices: Primary=${price1}₺, Secondary=${price2}₺ -> Selected higher price (${Math.max(price1, price2)}₺).`);
    } else if (primarySuccess) {
        priceWinner = primaryData;
    } else {
        priceWinner = secondaryData;
    }

    const mergedStocks = {};
    const allSizes = new Set([
        ...Object.keys(primaryData.stocks || {}),
        ...Object.keys(secondaryData.stocks || {})
    ]);

    allSizes.forEach(size => {
        const stock1 = (primaryData.stocks && primaryData.stocks[size]) || 0;
        const stock2 = (secondaryData.stocks && secondaryData.stocks[size]) || 0;

        if (stock1 > 0) mergedStocks[size] = stock1;
        else if (stock2 > 0) mergedStocks[size] = stock2;
        else mergedStocks[size] = 0;
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

async function main() {
    const args = getArgs();
    useProxy = args.proxy !== 'false' && !process.argv.includes('--no-proxy');
    const targetIds = args.ids ? args.ids.split(',').map(id => id.trim()) : null;

    const files = fs.readdirSync('.').filter(fn => fn.startsWith('products_') && fn.endsWith('.json'));

    if (files.length === 0) {
        console.log('⚠️ هیچ فایلی با فرمت products_*.json یافت نشد.');
        return;
    }

    console.log(`🔌 Proxy Enabled: ${useProxy}`);

    const launchArgs = [];
    if (useProxy) {
        launchArgs.push('--proxy-server=http://45.145.20.148:3128');
    }

    const browserPath = detectBrowserPath();
    if (browserPath) {
        console.log(`🌐 مرورگر شناسایی شد: ${browserPath}`);
        process.env.CHROME_PATH = browserPath;
    }

    console.log('🚀 Launching puppeteer-real-browser...');
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

    for (const file of files) {
        const siteName = file.replace('products_', '').replace('.json', '');
        const outputFile = `stock-data_${siteName}.json`;

        console.log('\n' + '='.repeat(60));
        console.log(`🌍 در حال اسکرپ سایت: ${siteName}`);
        console.log('='.repeat(60));

        let products = [];
        let currentData = {};

        try {
            products = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (fs.existsSync(outputFile)) {
                currentData = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
            }
        } catch (error) {
            console.error(`❌ خطا در خواندن فایل‌های سایت ${siteName}:`, error);
            continue;
        }

        if (targetIds) {
            products = products.filter(p => targetIds.includes(String(p.id)));
            if (products.length === 0) continue;
        }

        const results = { ...currentData };
        let successCount = 0;
        let failCount = 0;
        let skippedCount = 0;

        const CONCURRENCY = 3;

        for (let i = 0; i < products.length; i += CONCURRENCY) {
            const chunk = products.slice(i, i + CONCURRENCY);
            console.log(`\n⏳ پردازش همزمان محصولات ${i + 1} تا ${i + chunk.length} از ${products.length}...`);

            const chunkPromises = chunk.map(async (product) => {
                const result = await processProduct(browser, product);
                const isSkipped = result.error && result.error.toString().includes('Skipped');

                if (isSkipped) {
                    if (results[product.id]) delete results[product.id];
                    console.log(`⏩ Skipped & Removed: ${product.id}`);
                    skippedCount++;
                } else {
                    results[product.id] = result;
                    if (result.success) successCount++;
                    else {
                        failCount++;
                        console.log(`⚠️ Failed: ${product.id} -> ${result.error}`);
                    }
                }
            });

            await Promise.all(chunkPromises);
            await new Promise(r => setTimeout(r, 2000));
        }

        fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

        console.log(`\n✅ پایان اسکرپ سایت: ${siteName}`);
        console.log(`موفق: ${successCount} | ناموفق: ${failCount} | رد شده: ${skippedCount}`);
        console.log(`فایل ذخیره شد: ${outputFile}\n`);
    }

    await browser.close();
    console.log('🎉 تمام سایت‌ها با موفقیت پردازش شدند.');
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
