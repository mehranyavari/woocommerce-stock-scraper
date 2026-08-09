#!/usr/bin/env node
/**
 * ==============================================================================
 * 🎾 Raketspor Price Scraper (اسکرپر اختصاصی قیمت محصولات راکت اسپور)
 * ==============================================================================
 * 
 * این اسکریپت به صورت اختصاصی برای استخراج قیمت‌های سایت Raketspor طراحی شده است.
 * قیمت عادی (Regular Price) و قیمت با تخفیف (Offer Price) را با احتساب KDV استخراج می‌کند.
 * 
 * نحوه استفاده:
 * 1. اسکرپ از روی فایل products_tennis24shop_com.json:
 *    node raketspor-price-scraper.js --json=products_tennis24shop_com.json
 * 
 * 2. اسکرپ خودکار تمام فایل‌های محصولات موجود در پروژه (products_*.json و products.json):
 *    node raketspor-price-scraper.js
 * 
 * 3. اسکرپ تک محصول یا چند محصول:
 *    node raketspor-price-scraper.js "https://www.raketspor.com.tr/..."
 * 
 * 4. اسکرپ از روی فایل متنی حاوی لینک‌ها:
 *    node raketspor-price-scraper.js --file=urls.txt
 * 
 * 5. اسکرپ کلیه محصولات از روی سایت مپ راکت اسپور:
 *    node raketspor-price-scraper.js --sitemap --limit=50
 * 
 * آپشن‌های اختیاری:
 *    --concurrency=5   (تعداد درخواست‌های همزمان - پیش‌فرض: 5)
 *    --limit=100       (حداکثر تعداد محصولات)
 *    --out=output.json (نام فایل خروجی JSON)
 *    --csv             (ذخیره خروجی به فرمت CSV علاوه بر JSON)
 * ==============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ==========================================
// 🛠️ توابع کمکی پارس و استخراج قیمت
// ==========================================

function parseTurkishPrice(rawPrice) {
    if (!rawPrice) return null;
    const str = String(rawPrice).trim();

    // عدد خالص
    const plain = parseFloat(str);
    if (!isNaN(plain) && !str.includes(',') && !str.includes('₺') && !str.includes('TL')) {
        return plain > 0 ? Math.ceil(plain) : null;
    }

    // فرمت ترکی: 1.234,56 -> 1234.56
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

function fetchPage(url, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
        try {
            const u = new URL(url);
            const options = {
                hostname: u.hostname,
                path: u.pathname + u.search,
                timeout: timeoutMs,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            };

            const req = https.get(options, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let redirectUrl = res.headers.location;
                    if (redirectUrl.startsWith('/')) {
                        redirectUrl = `${u.protocol}//${u.hostname}${redirectUrl}`;
                    }
                    return fetchPage(redirectUrl, timeoutMs).then(resolve).catch(reject);
                }

                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
            });

            req.on('error', reject);
        } catch (e) {
            reject(e);
        }
    });
}

function extractRaketsporPrice(html, itemObj) {
    const url = typeof itemObj === 'string' ? itemObj : itemObj.url;
    const wooId = typeof itemObj === 'object' ? itemObj.id : null;

    // 1. بررسی وجود productDetailModel
    const match = html.match(/var productDetailModel = (.*?);/);
    if (match) {
        try {
            const data = JSON.parse(match[1]);
            const anaUrun = (data.products && data.products.find(p => p.anaUrun === true)) || 
                            (data.products && data.products[0]) || 
                            data.product || {};
            
            const title = anaUrun.urunAdi || data.productName || '';
            const sku = anaUrun.stokKodu || data.stockCode || '';
            const brand = data.brandName || '';
            const inStock = (data.totalStockAmount > 0) || (anaUrun.stokAdedi > 0);
            
            // استخراج قیمت‌ها
            const satis = anaUrun.satisFiyatiStr || 
                          (anaUrun.satisFiyati && anaUrun.satisKDV ? (anaUrun.satisFiyati + anaUrun.satisKDV) : anaUrun.satisFiyati);
            const indirimli = anaUrun.indirimliFiyatiStr || 
                              (anaUrun.indirimliFiyati && anaUrun.indirimliKDV ? (anaUrun.indirimliFiyati + anaUrun.indirimliKDV) : anaUrun.indirimliFiyati);
            const piyasa = anaUrun.piyasaFiyatiStr || 
                           (anaUrun.piyasaFiyati && anaUrun.piyasaFiyatiKDV ? (anaUrun.piyasaFiyati + anaUrun.piyasaFiyatiKDV) : anaUrun.piyasaFiyati);
            
            let rawRegular = null;
            let rawOffer = null;
            
            if (anaUrun.indirimliFiyati && anaUrun.satisFiyati && anaUrun.indirimliFiyati > 0 && anaUrun.indirimliFiyati < anaUrun.satisFiyati) {
                rawRegular = satis;
                rawOffer = indirimli;
            } else if (anaUrun.piyasaFiyati && anaUrun.satisFiyati && anaUrun.piyasaFiyati > anaUrun.satisFiyati && anaUrun.satisFiyati > 0) {
                rawRegular = piyasa;
                rawOffer = satis;
            } else {
                rawRegular = satis || data.productPriceKDVIncluded || data.productPriceStr;
                rawOffer = null;
            }
            
            const regular = parseTurkishPrice(rawRegular);
            let offer = parseTurkishPrice(rawOffer);
            if (offer && regular && offer >= regular) offer = null;
            
            const effective = offer || regular;
            const discountPercent = (regular && offer && regular > offer) ? Math.round(((regular - offer) / regular) * 100) : 0;
            
            return {
                success: true,
                id: wooId,
                url,
                title,
                sku,
                brand,
                in_stock: inStock,
                regular_price: regular,
                offer_price: offer,
                effective_price: effective,
                discount_percent: discountPercent,
                currency: 'TRY',
                scraped_at: new Date().toISOString()
            };
        } catch (e) {
            // ادامه به فال‌بک DOM
        }
    }

    // 2. فال‌بک از DOM
    const priceMatch = html.match(/<span[^>]*class="spanFiyat"[^>]*>(.*?)<\/span>/gi) || [];
    if (priceMatch.length > 0) {
        const prices = priceMatch.map(p => p.replace(/<[^>]+>/g, '').trim());
        const regular = parseTurkishPrice(prices[0]);
        let offer = prices.length > 1 ? parseTurkishPrice(prices[1]) : null;
        if (offer && regular && offer >= regular) offer = null;

        const titleMatch = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        return {
            success: true,
            id: wooId,
            url,
            title,
            sku: '',
            brand: '',
            in_stock: true,
            regular_price: regular,
            offer_price: offer,
            effective_price: offer || regular,
            discount_percent: (regular && offer && regular > offer) ? Math.round(((regular - offer) / regular) * 100) : 0,
            currency: 'TRY',
            scraped_at: new Date().toISOString()
        };
    }

    return { success: false, id: wooId, url, error: 'Product price data not found' };
}

// ==========================================
// 📂 بارگذاری لینک‌های محصولات از فایل‌های JSON
// ==========================================

function loadProductsFromJSON(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        console.log(`📂 Scanning file: ${filePath}`);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const items = Array.isArray(data) ? data : Object.values(data);
        const targetItems = [];

        items.forEach(item => {
            if (item.url && item.url.includes('raketspor.com.tr')) {
                targetItems.push({
                    id: item.id || null,
                    url: item.url
                });
            }
            if (item.secondary_url && item.secondary_url.includes('raketspor.com.tr')) {
                targetItems.push({
                    id: item.id || null,
                    url: item.secondary_url
                });
            }
        });

        console.log(`   ↳ Found ${targetItems.length} Raketspor products in ${filePath}`);
        return targetItems;
    } catch (e) {
        console.error(`⚠️ Error reading ${filePath}: ${e.message}`);
        return [];
    }
}

// ==========================================
// 🗺️ دریافت لیست لینک‌ها از Sitemap
// ==========================================

async function fetchRaketsporSitemapUrls(limit = Infinity) {
    console.log('📡 Fetching Raketspor sitemap index...');
    const indexXml = await fetchPage('https://www.raketspor.com.tr/sitemap.xml');
    const sitemapMatches = indexXml.match(/https:\/\/www\.raketspor\.com\.tr\/sitemap\/products\/\d+\.xml/g) || [];
    
    console.log(`📑 Found ${sitemapMatches.length} product sub-sitemaps.`);
    const allUrls = [];

    for (const subSitemapUrl of sitemapMatches) {
        if (allUrls.length >= limit) break;
        console.log(`  🔄 Reading ${subSitemapUrl}...`);
        try {
            const subXml = await fetchPage(subSitemapUrl);
            const locMatches = subXml.match(/<loc>(https:\/\/www\.raketspor\.com\.tr\/[^<]+)<\/loc>/g) || [];
            for (const loc of locMatches) {
                const cleanUrl = loc.replace(/<\/?loc>/g, '').trim();
                allUrls.push({ id: null, url: cleanUrl });
                if (allUrls.length >= limit) break;
            }
        } catch (err) {
            console.error(`  ⚠️ Failed to fetch ${subSitemapUrl}: ${err.message}`);
        }
    }

    return allUrls;
}

// ==========================================
// 🚀 موتور اسکرپ با مدیریت Concurrency
// ==========================================

async function scrapeRaketsporProducts(items, concurrency = 5) {
    console.log(`\n🚀 Starting price scrape for ${items.length} Raketspor products (Concurrency: ${concurrency})...\n`);
    
    const results = [];
    let currentIndex = 0;
    let successCount = 0;
    let discountCount = 0;

    async function worker(workerId) {
        while (currentIndex < items.length) {
            const index = currentIndex++;
            const item = items[index];
            const url = item.url;
            const progress = `[${index + 1}/${items.length}]`;
            
            try {
                const html = await fetchPage(url);
                const data = extractRaketsporPrice(html, item);
                
                if (data.success) {
                    successCount++;
                    if (data.offer_price) discountCount++;
                    
                    const priceStr = data.offer_price 
                        ? `💰 ${data.regular_price} ₺ ➔ 🔥 ${data.offer_price} ₺ (-${data.discount_percent}%)`
                        : `💰 ${data.regular_price} ₺`;
                    
                    const idPrefix = data.id ? `(#${data.id}) ` : '';
                    console.log(`✅ ${progress} ${idPrefix}${data.title.slice(0, 40).padEnd(40)} | ${priceStr}`);
                    results.push(data);
                } else {
                    console.log(`❌ ${progress} ${url} | Error: ${data.error}`);
                    results.push(data);
                }
            } catch (err) {
                console.log(`❌ ${progress} ${url} | Error: ${err.message}`);
                results.push({ success: false, id: item.id || null, url, error: err.message });
            }

            // تاخیر کوتاه جهت مدیریت ترافیک
            await new Promise(r => setTimeout(r, 120));
        }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker(i + 1));
    }

    await Promise.all(workers);

    return { results, successCount, discountCount };
}

// ==========================================
// 📊 ذخیره خروجی
// ==========================================

function saveResults(results, outputFile, saveCsv = false) {
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n💾 Results saved to JSON: ${outputFile}`);

    if (saveCsv) {
        const csvFile = outputFile.replace(/\.json$/i, '') + '.csv';
        const headers = ['ID', 'URL', 'Title', 'SKU', 'Brand', 'Regular Price (TRY)', 'Offer Price (TRY)', 'Effective Price (TRY)', 'Discount %', 'In Stock', 'Status'];
        
        const rows = results.map(r => {
            if (r.success) {
                return [
                    r.id || '',
                    `"${r.url}"`,
                    `"${(r.title || '').replace(/"/g, '""')}"`,
                    `"${r.sku || ''}"`,
                    `"${r.brand || ''}"`,
                    r.regular_price || '',
                    r.offer_price || '',
                    r.effective_price || '',
                    r.discount_percent || '0',
                    r.in_stock ? 'Yes' : 'No',
                    'Success'
                ].join(',');
            } else {
                return [r.id || '', `"${r.url}"`, '', '', '', '', '', '', '', '', `Error: ${r.error || 'Failed'}`].join(',');
            }
        });

        fs.writeFileSync(csvFile, [headers.join(','), ...rows].join('\n'), 'utf8');
        console.log(`💾 Results saved to CSV:  ${csvFile}`);
    }
}

// ==========================================
// 🏁 اجرای برنامه
// ==========================================

async function main() {
    const args = process.argv.slice(2);
    
    let targetItems = [];
    let concurrency = 5;
    let limit = Infinity;
    let outputFile = 'raketspor-prices.json';
    let saveCsv = false;
    let customJsonSpecified = false;

    // پارس آرگومان‌ها
    for (const arg of args) {
        if (arg.startsWith('--concurrency=')) {
            concurrency = parseInt(arg.split('=')[1]) || 5;
        } else if (arg.startsWith('--limit=')) {
            limit = parseInt(arg.split('=')[1]) || Infinity;
        } else if (arg.startsWith('--out=')) {
            outputFile = arg.split('=')[1];
        } else if (arg === '--csv') {
            saveCsv = true;
        } else if (arg.startsWith('--file=')) {
            const filePath = arg.split('=')[1];
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n').map(l => l.trim()).filter(l => l.includes('raketspor.com.tr'));
                lines.forEach(url => targetItems.push({ id: null, url }));
            }
        } else if (arg.startsWith('--json=')) {
            const filePath = arg.split('=')[1];
            customJsonSpecified = true;
            targetItems.push(...loadProductsFromJSON(filePath));
        } else if (arg.startsWith('http')) {
            targetItems.push({ id: null, url: arg });
        }
    }

    const isSitemap = args.includes('--sitemap') || args.includes('--all');

    if (isSitemap) {
        targetItems = await fetchRaketsporSitemapUrls(limit);
    }

    // اگر فایل مشخص نشده بود، ابتدا در products_tennis24shop_com.json و سایر فایل‌های products_*.json جستجو کن
    if (!customJsonSpecified && !isSitemap && targetItems.length === 0) {
        const candidateFiles = [];
        
        // اولویت اول: products_tennis24shop_com.json
        if (fs.existsSync('products_tennis24shop_com.json')) {
            candidateFiles.push('products_tennis24shop_com.json');
        }

        // سایر فایل‌های products_*.json و products.json
        const dirFiles = fs.readdirSync('.').filter(fn => 
            (fn.startsWith('products_') || fn === 'products.json') && 
            fn.endsWith('.json') && 
            !candidateFiles.includes(fn)
        );
        candidateFiles.push(...dirFiles);

        for (const file of candidateFiles) {
            targetItems.push(...loadProductsFromJSON(file));
        }
    }

    // اگر همچنان هیچ محصولی پیدا نشد، نمونه آزمایشی اجرا شود
    if (targetItems.length === 0) {
        console.log('ℹ️ No Raketspor URLs found in products JSON files. Running sample URLs...');
        targetItems = [
            { id: 14403, url: 'https://www.raketspor.com.tr/nikecourt-fn0530-001-lite-4-toprak-kort-erkek-tenis-ayakkabisi-siyah-14403' },
            { id: 11795, url: 'https://www.raketspor.com.tr/nike-fd5384-010-victory-dri-fit-erkek-tenis-sort-siyah-11795' },
            { id: 11796, url: 'https://www.raketspor.com.tr/joma-tm10lw2515c-master-1000-2515-kadin-yesil-toprak-kort-tenis-ayakkabi-11796' }
        ];
    }

    // یکتا سازی لینک‌ها و اعمال محدودیت تعداد
    const uniqueMap = new Map();
    targetItems.forEach(item => {
        if (!uniqueMap.has(item.url)) {
            uniqueMap.set(item.url, item);
        }
    });
    targetItems = Array.from(uniqueMap.values()).slice(0, limit);

    const startTime = Date.now();
    const { results, successCount, discountCount } = await scrapeRaketsporProducts(targetItems, concurrency);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n' + '='.repeat(60));
    console.log(`🏁 FINISHED IN ${duration}s`);
    console.log(`📊 Total Products:   ${targetItems.length}`);
    console.log(`✅ Success:          ${successCount}`);
    console.log(`🔥 Discounted Items: ${discountCount}`);
    console.log(`❌ Failed:           ${targetItems.length - successCount}`);
    console.log('='.repeat(60));

    saveResults(results, outputFile, saveCsv);
}

main().catch(err => {
    console.error('💥 Fatal Error:', err.message);
    process.exit(1);
});
