const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

let useProxy = true;

// ==========================================
// 🔗 لینک تست
// ==========================================
const TEST_URL = "https://www.adidas.com.tr/tr/barricade-14-tenis-ayakkabisi/KI3438.html";

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

    if (dotIdx > commaIdx && commaIdx !== -1) {
        // فرمت انگلیسی: 1,234.56
        clean = clean.replace(/,/g, '');
    } else if (commaIdx > dotIdx && dotIdx !== -1) {
        // فرمت ترکی: 1.234,56
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
    } else if (commaIdx !== -1 && dotIdx === -1) {
        // فقط کاما دارد: 1234,56
        clean = clean.replace(/,/g, '.');
    } else if (dotIdx !== -1 && commaIdx === -1) {
        // فقط نقطه دارد: 1234.56
        // در این حالت اگر فرمت ترکی بدون اعشار باشد (مثل 1.234)
        if (clean.length - dotIdx === 4) { // احتمالا هزارگان است
            clean = clean.replace(/\./g, '');
        }
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

async function scrapeTenisBurada(page, url) {
    console.log(`\n🔄 Scraping TenisBurada: ${url}`);
    
    try {
        if (useProxy) {
            await page.authenticate({ username: 'mehran', password: 'mehran75' });
        }

        console.log(`  🔄 Navigating to product page...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log(`  ⏳ Waiting 15s to let JS load...`);
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
async function scrapeOpsarSport(page, url) {
    console.log(`\n🔄 Scraping OpsarSport: ${url}`);
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
        return { success: false, error: "OpsarSport Error: " + error.message };
    }
}

// ==========================================
// 🏓 اسکرپر مخصوص راکت‌چی (Raketci)
// ==========================================
async function scrapeRaketci(page, url) {
    console.log(`\n🔄 Scraping Raketci: ${url}`);
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
                                // sometimes sizes are like 42-5 instead of 42.5
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
        
        if (!result.success) return { success: false, error: result.error || "Extraction failed" };
        
        const normalizedStocks = {};
        for (const [rawSize, isStock] of Object.entries(result.stocks)) {
            const normalized = normalizeSize(rawSize, hostname);
            if (normalized) normalizedStocks[normalized] = isStock ? 1 : 0;
        }
        
        const regular = parseTurkishPrice(result.price);
        let offer = parseTurkishPrice(result.offerPrice);
        if (regular && offer && offer >= regular) offer = null;
        
        console.log(`  ✅ Raketci URL Scraped: ${Object.keys(normalizedStocks).length} sizes found.`);
        return { success: true, stocks: normalizedStocks, regular_price: regular, offer_price: offer };
        
    } catch (error) {
        return { success: false, error: "Raketci Error: " + error.message };
    }
}

// ==========================================
// 🏃‍♂️ اسکرپر مخصوص اسپورت‌این (Sportinn)
// ==========================================
async function scrapeSportinn(page, url) {
    console.log(`\n🔄 Scraping Sportinn: ${url}`);
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
        return { success: false, error: "Sportinn Error: " + error.message };
    }
}

// ==========================================
// 🏃‍♂️ اسکرپر مخصوص اسیکس (Asics)
// ==========================================
async function scrapeAsics(page, url) {
    console.log(`\n🔄 Scraping Asics: ${url}`);
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
        return { success: false, error: "Asics Error: " + error.message };
    }
}

// ==========================================
// 🏃‍♂️ اسکرپر مخصوص آدیداس (Adidas)
// ==========================================
async function scrapeAdidas(page, url) {
    console.log(`\n🔄 Scraping Adidas: ${url}`);
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
        return { success: false, error: "Adidas Error: " + error.message };
    }
}

function getEffectivePrice(scrapeData) { }

async function scrapeProduct(page, url) {
    if (url.toLowerCase().includes('korayspor')) {
        return scrapeKorayspor(page, url);
    }
    
    if (url.toLowerCase().includes('tenisburada.com')) {
        return scrapeTenisBurada(page, url);
    }

    if (url.toLowerCase().includes('opsarsport.com')) {
        return scrapeOpsarSport(page, url);
    }

    if (url.toLowerCase().includes('raketci.com')) {
        return scrapeRaketci(page, url);
    }

    if (url.toLowerCase().includes('sportinn.com.tr')) {
        return scrapeSportinn(page, url);
    }

    if (url.toLowerCase().includes('asics.com.tr')) {
        return scrapeAsics(page, url);
    }

    if (url.toLowerCase().includes('adidas.com.tr')) {
        return scrapeAdidas(page, url);
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
