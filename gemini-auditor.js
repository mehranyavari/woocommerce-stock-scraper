#!/usr/bin/env node
/**
 * ==============================================================================
 * 🤖 Gemini AI Product & Supplier Auditor (نسخه پیشرفته - مقایسه دوطرفه + اسکرین‌شات)
 * ==============================================================================
 * سیستم حسابرس و مقایسه‌گر هوشمند محصولات فروشگاه با سایت‌های تامین‌کننده
 * 
 * 🔍 قابلیت‌های کلیدی:
 * ۱. مقایسه دوطرفه سایزها و قیمت‌های سایت شما در برابر تامین‌کننده
 * ۲. تشخیص سایزهای گمشده در سایت شما (فرصت فروش)
 * ۳. تشخیص سایزهای ناموجود در تامین‌کننده که در سایت شما هنوز روشن است (خطر لغو سفارش)
 * ۴. بررسی اختلاف قیمت لیر با قیمت روز یا تخفیف‌دار تامین‌کننده
 * ۵. تصویربرداری خودکار (Screenshot) از سایت‌های مسدود یا غیرقابل اسکرپ (مثل اسیکس، دکلتون)
 * ۶. نمایش اسکرین‌شات با لایت‌باکس پاپ‌آپ داخل داشبورد HTML
 * ۷. گزارش و تحلیل مدیریتی با هوش مصنوعی Google Gemini (gemini-flash-lite-latest)
 * ==============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ==========================================
// ⚙️ تنظیمات و بارگذاری کانفیگ
// ==========================================

const CONFIG_PATH = path.join(__dirname, 'gemini-config.json');
let CONFIG = {
    api_key: process.env.GEMINI_API_KEY || '',
    default_model: 'gemini-flash-lite-latest',
    fallback_model: 'gemini-2.5-flash',
    rate_limit: {
        requests_per_minute: 30,
        delay_between_batches_ms: 1500,
        batch_size: 10
    },
    audit_thresholds: {
        price_change_significant_percent: 5,
        low_stock_threshold: 2
    },
    screenshots: {
        enable_for_failed_products: true,
        max_screenshots_per_run: 15
    }
};

if (fs.existsSync(CONFIG_PATH)) {
    try {
        const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        CONFIG = { ...CONFIG, ...fileCfg };
    } catch (e) {
        console.error('⚠️ Could not load gemini-config.json:', e.message);
    }
}

if (process.env.GEMINI_API_KEY) {
    CONFIG.api_key = process.env.GEMINI_API_KEY;
}

const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ==========================================
// 🌐 موتور فراخوانی Google Gemini API
// ==========================================

async function callGemini(promptText, modelName = CONFIG.default_model) {
    if (!CONFIG.api_key) {
        throw new Error('کلید API جمنای (GEMINI_API_KEY) یافت نشد.');
    }

    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
                temperature: 0.2,
                topP: 0.8,
                maxOutputTokens: 2048
            }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${modelName}:generateContent?key=${CONFIG.api_key}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        resolve(text);
                    } catch (e) {
                        reject(new Error('خطا در پارس پاسخ جمنای: ' + e.message));
                    }
                } else if (res.statusCode === 429 || res.statusCode === 404) {
                    if (modelName !== CONFIG.fallback_model) {
                        console.log(`  🔄 سوئیچ از مدل ${modelName} به ${CONFIG.fallback_model}...`);
                        callGemini(promptText, CONFIG.fallback_model).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`Gemini HTTP ${res.statusCode}: ${data}`));
                    }
                } else {
                    reject(new Error(`Gemini HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ==========================================
// 📸 ماژول تصویربرداری از صفحات مسدود/خطادار (Puppeteer)
// ==========================================

function findBrowserExecutable() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

async function captureScreenshotsForItems(items) {
    if (!items || items.length === 0) return;
    console.log(`\n📸 در حال تصویربرداری زنده از صفحات تامین‌کننده برای ${items.length} محصول با خطای اسکرپ...`);

    let puppeteer;
    try {
        puppeteer = require('puppeteer-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        puppeteer.use(StealthPlugin());
    } catch (e) {
        try { puppeteer = require('puppeteer'); } catch (err) {
            console.log('⚠️ ماژول Puppeteer یافت نشد.');
            return;
        }
    }

    const execPath = findBrowserExecutable();
    const launchOpts = {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    if (execPath) launchOpts.executablePath = execPath;

    let browser;
    try {
        browser = await puppeteer.launch(launchOpts);
    } catch (err) {
        console.log('⚠️ خطا در راه‌اندازی مرورگر برای اسکرین‌شات:', err.message);
        return;
    }

    const screenshotsDir = path.join(OUTPUT_DIR, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.primary_url) continue;

        console.log(`  📸 [${i + 1}/${items.length}] تصویربرداری از محصول #${item.id} (${item.domain})...`);
        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 900 });

            const filename = `${item.id}.jpg`;
            const filePath = path.join(screenshotsDir, filename);

            await page.goto(item.primary_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3500));
            await page.screenshot({ path: filePath, type: 'jpeg', quality: 75 });
            
            const b64 = fs.readFileSync(filePath).toString('base64');
            item.screenshot_file = `screenshots/${filename}`;
            item.screenshot_base64 = `data:image/jpeg;base64,${b64}`;
            console.log(`     ✅ اسکرین‌شات با موفقیت ذخیره شد: ${filename}`);
            await page.close();
        } catch (err) {
            console.log(`     ⚠️ خطا در ثبت اسکرین‌شات #${item.id}: ${err.message}`);
        }
    }

    await browser.close();
}

// ==========================================
// 🔍 لایه ۱: تحلیل و مقایسه دوطرفه
// ==========================================

function performAlgorithmicAudit(products, stockData) {
    console.log('🔍 در حال مقایسه دوطرفه محصولات سایت با دیتای تامین‌کنندگان...');
    const auditResults = [];

    products.forEach(product => {
        const id = String(product.id);
        const supplierInfo = stockData[id];
        const primaryUrl = product.url || '';
        const secondaryUrl = product.secondary_url || '';

        let domain = 'Unknown';
        try {
            if (primaryUrl) domain = new URL(primaryUrl).hostname.replace('www.', '');
        } catch (e) {}

        const ourPrice = product.our_price_lir ? parseFloat(product.our_price_lir) : null;
        const ourSizes = product.our_sizes || {};
        const ourTitle = product.title || `محصول #${product.id}`;
        const ourSku = product.sku || '';
        const ourStockStatus = product.our_stock_status || 'instock';
        
        let ourUrl = product.our_url || '';
        let ourEditUrl = product.our_edit_url || '';

        if (!ourUrl && product.id) {
            ourUrl = `https://tennis24shop.com/?p=${product.id}`;
        }
        if (!ourEditUrl && product.id) {
            ourEditUrl = `https://tennis24shop.com/wp-admin/post.php?post=${product.id}&action=edit`;
        }

        const itemAudit = {
            id: product.id,
            title: ourTitle,
            sku: ourSku,
            primary_url: primaryUrl,
            secondary_url: secondaryUrl,
            our_url: ourUrl,
            our_edit_url: ourEditUrl,
            domain: domain,
            
            // وضعیت در سایت ما
            our_data: {
                price_lir: ourPrice,
                stock_status: ourStockStatus,
                sizes: ourSizes,
                url: ourUrl,
                edit_url: ourEditUrl
            },

            // وضعیت در سایت تامین‌کننده
            supplier_data: {
                success: false,
                regular_price: null,
                offer_price: null,
                effective_price: null,
                has_discount: false,
                discount_percent: 0,
                stocks: {},
                in_stock_sizes: [],
                out_of_stock_sizes: []
            },

            screenshot_file: null,
            screenshot_base64: null,

            // نتایج مقایسه
            discrepancies: [],
            missing_sizes_in_store: [],    // در تامین‌کننده هست ولی تو سایت ما نیست یا ۰ هست
            phantom_sizes_in_store: [],    // در سایت ما هست ولی تامین‌کننده تموم کرده (خطر لغو سفارش)
            price_discrepancy: null,       // اختلاف قیمت
            status_tag: 'OK',             // OK, CRITICAL, WARNING, INFO, ERROR
            severity: 'NORMAL',
            ai_summary: '',
            recommended_action: ''
        };

        // ۱. بررسی عدم وجود دیتای اسکرپ
        if (!supplierInfo) {
            itemAudit.discrepancies.push({
                type: 'NOT_SCRAPED',
                message: 'داده‌ای در فایل اسکرپر برای این محصول یافت نشد.'
            });
            itemAudit.status_tag = 'ERROR';
            itemAudit.severity = 'WARNING';
            itemAudit.ai_summary = 'این محصول هنوز توسط اسکرپر پایش نشده است.';
            itemAudit.recommended_action = 'اسکرپر را برای این محصول اجرا کنید.';
            auditResults.push(itemAudit);
            return;
        }

        // ۲. بررسی خطای صفحه یا بلاک تامین‌کننده
        if (!supplierInfo.success) {
            const errMsg = supplierInfo.error || 'خطای دسترسی به صفحه تامین‌کننده';
            itemAudit.supplier_data.error = errMsg;
            
            let isDeadOrRedirect = errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('Redirect');
            let isBlocked = errMsg.includes('Cloudflare') || errMsg.includes('Blocked') || errMsg.includes('DKT') || errMsg.includes('productDetailModel');

            itemAudit.discrepancies.push({
                type: isDeadOrRedirect ? 'SUPPLIER_PAGE_DEAD' : (isBlocked ? 'CLOUDFLARE_OR_SCRAPE_BLOCKED' : 'SCRAPER_ERROR'),
                message: isDeadOrRedirect 
                    ? 'صفحه محصول در سایت تامین‌کننده حذف یا ریدایرکت شده است (404).'
                    : `خطای اسکرپر در تامین‌کننده (${itemAudit.domain}): ${errMsg}`
            });

            itemAudit.status_tag = isDeadOrRedirect ? 'CRITICAL' : 'WARNING';
            itemAudit.severity = isDeadOrRedirect ? 'CRITICAL' : 'WARNING';
            itemAudit.ai_summary = isDeadOrRedirect 
                ? 'صفحه تامین‌کننده در دسترس نیست یا محصول حذف شده است.' 
                : 'عدم امکان اسکرپ مستقیم صفحه تامین‌کننده (تصویر زنده صفحه ثبت شده است).';
            itemAudit.recommended_action = isDeadOrRedirect 
                ? 'لینک تامین‌کننده را در سایت اصلاح یا در صورت اتمام، محصول را ناموجود کنید.' 
                : 'تصویر زنده تامین‌کننده را بررسی کرده و در صورت نیاز مقادیر را دستی اعمال کنید.';
            auditResults.push(itemAudit);
            return;
        }

        // ۳. پر کردن دیتای تامین‌کننده
        itemAudit.supplier_data.success = true;
        itemAudit.supplier_data.regular_price = supplierInfo.regular_price || null;
        itemAudit.supplier_data.offer_price = supplierInfo.offer_price || null;
        itemAudit.supplier_data.stocks = supplierInfo.stocks || {};

        const regPrice = supplierInfo.regular_price;
        const offPrice = supplierInfo.offer_price;
        const effectivePrice = offPrice ? offPrice : regPrice;
        itemAudit.supplier_data.effective_price = effectivePrice;

        if (regPrice && offPrice && regPrice > offPrice) {
            itemAudit.supplier_data.has_discount = true;
            itemAudit.supplier_data.discount_percent = Math.round(((regPrice - offPrice) / regPrice) * 100);
        }

        const supplierStockEntries = Object.entries(itemAudit.supplier_data.stocks);
        supplierStockEntries.forEach(([size, qty]) => {
            const numQty = typeof qty === 'boolean' ? (qty ? 1 : 0) : parseInt(qty) || 0;
            if (numQty > 0) {
                itemAudit.supplier_data.in_stock_sizes.push({ size, qty: numQty });
            } else {
                itemAudit.supplier_data.out_of_stock_sizes.push(size);
            }
        });

        // ==========================================
        // ⚖️ مقایسه دوطرفه
        // ==========================================

        const ourSizeKeys = Object.keys(ourSizes);
        const hasOurSizes = ourSizeKeys.length > 0;

        // الف) سایزهای گمشده (فرصت فروش)
        itemAudit.supplier_data.in_stock_sizes.forEach(suppSize => {
            const sName = suppSize.size;
            const ourQty = ourSizes[sName];

            if (hasOurSizes) {
                if (ourQty === undefined) {
                    itemAudit.missing_sizes_in_store.push({ size: sName, supplier_qty: suppSize.qty, reason: 'در سایت شما تعریف نشده' });
                } else if (ourQty <= 0) {
                    itemAudit.missing_sizes_in_store.push({ size: sName, supplier_qty: suppSize.qty, reason: 'در سایت شما ۰ ثبت شده' });
                }
            }
        });

        if (itemAudit.missing_sizes_in_store.length > 0) {
            const missingList = itemAudit.missing_sizes_in_store.map(m => `${m.size} (${m.reason})`).join(', ');
            itemAudit.discrepancies.push({
                type: 'MISSING_SIZES_OPPORTUNITY',
                message: `فرصت فروش از دست رفته: سایزهای [${missingList}] در تامین‌کننده موجود است اما در سایت شما در دسترس نیست!`
            });
            if (itemAudit.severity === 'NORMAL') itemAudit.severity = 'WARNING';
        }

        // ب) موجودی کاذب (خطر لغو سفارش)
        if (hasOurSizes) {
            ourSizeKeys.forEach(ourSize => {
                const ourQty = ourSizes[ourSize];
                if (ourQty > 0) {
                    const suppQty = itemAudit.supplier_data.stocks[ourSize];
                    const numSuppQty = typeof suppQty === 'boolean' ? (suppQty ? 1 : 0) : parseInt(suppQty) || 0;

                    if (suppQty === undefined || numSuppQty <= 0) {
                        itemAudit.phantom_sizes_in_store.push({ size: ourSize, our_qty: ourQty });
                    }
                }
            });
        }

        if (itemAudit.phantom_sizes_in_store.length > 0) {
            const phantomList = itemAudit.phantom_sizes_in_store.map(p => p.size).join(', ');
            itemAudit.discrepancies.push({
                type: 'PHANTOM_STOCK_CRITICAL',
                message: `🔴 خطر سفارش ناموجود: سایزهای [${phantomList}] در سایت شما موجود است اما تامین‌کننده این سایزها را تمام کرده است!`
            });
            itemAudit.severity = 'CRITICAL';
        }

        // ج) ناموجودی کل
        if (supplierStockEntries.length > 0 && itemAudit.supplier_data.in_stock_sizes.length === 0) {
            if (ourStockStatus === 'instock') {
                itemAudit.discrepancies.push({
                    type: 'TOTAL_OUT_OF_STOCK_MISMATCH',
                    message: '🔴 تامین‌کننده تمام سایزها را ناموجود کرده است اما محصول در سایت شما هنوز فعال/موجود است.'
                });
                itemAudit.severity = 'CRITICAL';
            } else {
                itemAudit.discrepancies.push({
                    type: 'SUPPLIER_OUT_OF_STOCK',
                    message: 'محصول در سایت تامین‌کننده کاملاً ناموجود است (در سایت شما نیز ناموجود است).'
                });
                if (itemAudit.severity === 'NORMAL') itemAudit.severity = 'INFO';
            }
        }

        // د) اختلاف قیمت
        if (ourPrice && effectivePrice) {
            const diff = Math.round(effectivePrice - ourPrice);
            const diffPct = Math.round((Math.abs(diff) / ourPrice) * 100);

            if (Math.abs(diffPct) >= (CONFIG.audit_thresholds.price_change_significant_percent || 5)) {
                if (effectivePrice > ourPrice) {
                    itemAudit.price_discrepancy = {
                        type: 'PRICE_INCREASED_BY_SUPPLIER',
                        diff_lir: diff,
                        diff_percent: diffPct,
                        message: `قیمت تامین‌کننده (${effectivePrice}₺) از قیمت سایت شما (${ourPrice}₺) بیشتر شده است (+${diffPct}%). خطر ضرر در فروش!`
                    };
                    itemAudit.discrepancies.push(itemAudit.price_discrepancy);
                    itemAudit.severity = 'CRITICAL';
                } else if (effectivePrice < ourPrice) {
                    itemAudit.price_discrepancy = {
                        type: 'PRICE_DECREASED_OR_OFFER',
                        diff_lir: diff,
                        diff_percent: diffPct,
                        message: `تامین‌کننده قیمت را به ${effectivePrice}₺ کاهش داده (${ourPrice}₺ در سایت شما). فرصت تخفیف برای افزایش فروش.`
                    };
                    itemAudit.discrepancies.push(itemAudit.price_discrepancy);
                    if (itemAudit.severity === 'NORMAL') itemAudit.severity = 'WARNING';
                }
            }
        }

        // هـ) بررسی محصول کاملاً هماهنگ
        if (itemAudit.discrepancies.length === 0) {
            itemAudit.status_tag = 'OK';
            itemAudit.severity = 'NORMAL';
            itemAudit.ai_summary = '✅ همه چیز اکیه؛ سایزها، موجودی و قیمت کاملاً با تامین‌کننده هماهنگ هستند.';
            itemAudit.recommended_action = 'نیازی به اقدامی نیست.';
        } else {
            itemAudit.status_tag = itemAudit.severity;
        }

        auditResults.push(itemAudit);
    });

    return auditResults;
}

// ==========================================
// 🤖 لایه ۲: تحلیل کیفی و هوشمند توسط Gemini
// ==========================================

async function performAIAudit(discrepantItems, modelName) {
    console.log(`\n🤖 شروع تحلیل هوشمند دوطرفه با مدل ${modelName} برای ${discrepantItems.length} محصول منتخب...`);

    const chunks = [];
    const batchSize = CONFIG.rate_limit.batch_size || 10;
    for (let i = 0; i < discrepantItems.length; i += batchSize) {
        chunks.push(discrepantItems.slice(i, i + batchSize));
    }

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`  ⏳ پردازش بسته هوش مصنوعی ${i + 1} از ${chunks.length} (${chunk.length} محصول)...`);

        const promptPayload = chunk.map(item => ({
            id: item.id,
            title: item.title,
            domain: item.domain,
            our_store: {
                price_lir: item.our_data.price_lir,
                sizes_in_our_store: Object.keys(item.our_data.sizes).filter(s => item.our_data.sizes[s] > 0)
            },
            supplier: {
                effective_price: item.supplier_data.effective_price,
                sizes_in_supplier: item.supplier_data.in_stock_sizes.map(s => `${s.size} (${s.qty}عدد)`),
                error: item.supplier_data.error || null,
                has_live_screenshot: item.screenshot_base64 ? true : false
            },
            discrepancies: item.discrepancies.map(d => d.message),
            missing_sizes: item.missing_sizes_in_store.map(m => m.size),
            phantom_sizes: item.phantom_sizes_in_store.map(p => p.size)
        }));

        const prompt = `شما کارشناس هوش مصنوعی مانیتورینگ فروشگاه اینترنتی هستید.
مقایسه دقیق وضعیت محصولات "سایت ما" در برابر "سایت تامین‌کننده" در قالب JSON ارسال شده است.

لطفاً برای هر محصول:
1. "severity": یکی از مقادیر ("CRITICAL", "WARNING", "INFO", "OK")
2. "ai_summary": تحلیل بسیار دقیق و خلاصه به زبان فارسی روان (مثلا: "سایز ۴۲ در تامین‌کننده موجود است ولی در سایت ندارید. قیمت لیر تامین‌کننده هم ۱۵٪ بالا رفته.")
3. "recommended_action": دستور اقدام صریح و عملیاتی برای مدیر سایت

پاسخ را فقط و فقط به صورت JSON معتبر ارسال کن:
[
  {
    "id": 1234,
    "severity": "CRITICAL",
    "ai_summary": "...",
    "recommended_action": "..."
  }
]

داده‌های ورودی:
${JSON.stringify(promptPayload, null, 2)}`;

        try {
            const rawResponse = await callGemini(prompt, modelName);
            const cleanJson = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
            const aiResults = JSON.parse(cleanJson);

            aiResults.forEach(aiItem => {
                const target = chunk.find(c => String(c.id) === String(aiItem.id));
                if (target) {
                    if (aiItem.severity) target.severity = aiItem.severity;
                    target.ai_summary = aiItem.ai_summary || target.ai_summary;
                    target.recommended_action = aiItem.recommended_action || target.recommended_action;
                }
            });
        } catch (err) {
            console.error(`  ⚠️ خطای دریافت تحلیل هوش مصنوعی برای این بسته: ${err.message}`);
        }

        await new Promise(r => setTimeout(r, CONFIG.rate_limit.delay_between_batches_ms || 1500));
    }

    console.log('📝 در حال تدوین گزارش مدیریتی کل فروشگاه توسط Gemini...');
    let executiveSummary = 'گزارش حسابرسی هوشمند آماده شد.';
    try {
        const statsSummary = {
            total_audited: discrepantItems.length,
            critical_risk_items: discrepantItems.filter(d => d.severity === 'CRITICAL').length,
            missing_sizes_opportunity: discrepantItems.filter(d => d.missing_sizes_in_store.length > 0).length,
            phantom_stock_risk: discrepantItems.filter(d => d.phantom_sizes_in_store.length > 0).length,
            price_discrepancies: discrepantItems.filter(d => d.price_discrepancy !== null).length,
            dead_supplier_links: discrepantItems.filter(d => !d.supplier_data.success).length,
            all_ok_items: discrepantItems.filter(d => d.severity === 'NORMAL' || d.status_tag === 'OK').length
        };

        const summaryPrompt = `به عنوان مشاور ارشد سیستم‌های تجارت الکترونیک، بر اساس آمار مقایسه دوطرفه محصولات سایت با تامین‌کنندگان یک گزارش مدیریتی حرفه‌ای، شفاف و کوتاه در ۳ پاراگراف بنویس.
آمار مانیتورینگ:
${JSON.stringify(statsSummary, null, 2)}

شامل:
۱. تحلیل وضعیت سلامت موجودی و قیمت‌های سایت
۲. نقاط خطر فوری (خطر لغو سفارش یا ضرر مالی قیمت‌ها)
۳. ۳ توصیه عملیاتی و فوری به مدیر سایت با ایموجی‌های مناسب.`;

        executiveSummary = await callGemini(summaryPrompt, modelName);
    } catch (e) {
        executiveSummary = 'خلاصه وضعیت: تحلیل دوطرفه انجام شد و مغایرت‌ها در جدول زیر مشخص شده‌اند.';
    }

    return executiveSummary;
}

// ==========================================
// 📊 تولید گزارش گرافیکی HTML با مقایسه Side-by-Side + لایت‌باکس اسکرین‌شات
// ==========================================

function generateHtmlDashboard(auditResults, executiveSummary, outputFile) {
    const total = auditResults.length;
    const okCount = auditResults.filter(r => r.severity === 'NORMAL' || r.status_tag === 'OK').length;
    const criticalCount = auditResults.filter(r => r.severity === 'CRITICAL').length;
    const warningCount = auditResults.filter(r => r.severity === 'WARNING').length;
    const missingSizesCount = auditResults.filter(r => r.missing_sizes_in_store.length > 0).length;
    const phantomSizesCount = auditResults.filter(r => r.phantom_sizes_in_store.length > 0).length;
    const priceMismatchCount = auditResults.filter(r => r.price_discrepancy !== null).length;
    const screenshotsCount = auditResults.filter(r => r.screenshot_base64 || r.screenshot_file).length;

    const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <title>پایش هوشمند محصولات | AI Auditor</title>
    <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #090d16;
            --surface: #121827;
            --surface-hover: #1a2236;
            --border: #1f293d;
            --text: #f1f5f9;
            --muted: #94a3b8;
            --primary: #8b5cf6;
            --primary-glow: rgba(139,92,246,0.15);
            --critical: #ef4444;
            --warning: #f59e0b;
            --success: #10b981;
            --info: #38bdf8;
            --pink: #ec4899;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Vazirmatn', -apple-system, sans-serif; }
        body { background: var(--bg); color: var(--text); padding: 15px; font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
        .container { max-width: 1400px; margin: 0 auto; }

        /* نوار بالای صفحه */
        .top-bar { display: flex; justify-content: space-between; align-items: center; background: var(--surface); padding: 12px 18px; border-radius: 10px; border: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap; gap: 10px; }
        .logo-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 800; color: #fff; }
        .logo-badge { background: linear-gradient(135deg, #8b5cf6, #3b82f6); color: #fff; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
        .meta-tag { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }

        /* کارت‌های آماری فشرده */
        .quick-stats { display: flex; gap: 8px; margin-bottom: 12px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
        .quick-stats::-webkit-scrollbar { display: none; }
        .q-card { background: var(--surface); border: 1px solid var(--border); padding: 8px 14px; border-radius: 8px; white-space: nowrap; display: flex; align-items: center; gap: 8px; flex-shrink: 0; font-size: 12px; cursor: pointer; transition: all 0.2s; }
        .q-card:hover { border-color: var(--primary); transform: translateY(-1px); }
        .q-num { font-weight: 800; font-size: 14px; }

        /* گزارش مدیریتی جمع‌وجور */
        .ai-box { background: var(--primary-glow); border: 1px solid rgba(139,92,246,0.3); border-radius: 10px; padding: 14px 18px; margin-bottom: 12px; }
        .ai-header { font-size: 13px; font-weight: 700; color: #c084fc; display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
        .ai-text { font-size: 12px; color: #cbd5e1; white-space: pre-line; line-height: 1.7; }

        /* نوار فیلتر و جستجو */
        .toolbar { display: flex; justify-content: space-between; align-items: center; background: var(--surface); padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 12px; gap: 10px; flex-wrap: wrap; position: sticky; top: 10px; z-index: 100; backdrop-filter: blur(10px); }
        .filter-group { display: flex; gap: 6px; flex-wrap: wrap; }
        .f-btn { background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--muted); padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
        .f-btn.active, .f-btn:hover { background: var(--primary); color: #fff; border-color: var(--primary); }
        .search-box { background: var(--bg); border: 1px solid var(--border); color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; width: 220px; outline: none; transition: border-color 0.2s; }
        .search-box:focus { border-color: var(--primary); }

        /* جدول محصولات (دسکتاپ) */
        .table-card { background: var(--surface); border-radius: 10px; border: 1px solid var(--border); overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
        table { width: 100%; border-collapse: collapse; text-align: right; font-size: 12px; }
        th { background: #0c1220; color: var(--muted); padding: 10px 12px; font-weight: 600; border-bottom: 1px solid var(--border); white-space: nowrap; }
        td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
        tr:hover { background: var(--surface-hover); }

        /* تگ‌ها و بج‌ها */
        .pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; white-space: nowrap; }
        .pill-ok { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
        .pill-critical { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
        .pill-warning { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }

        .tag-size { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; margin: 1px; }
        .tag-size.in { background: rgba(16,185,129,0.12); color: #34d399; }
        .tag-size.out { background: rgba(239,68,68,0.1); color: #f87171; opacity: 0.6; }
        .tag-size.missing { background: rgba(245,158,11,0.2); color: #fbbf24; font-weight: bold; border: 1px solid rgba(245,158,11,0.4); }
        .tag-size.phantom { background: rgba(239,68,68,0.25); color: #fca5a5; font-weight: bold; border: 1px solid rgba(239,68,68,0.5); }

        .price-chip { font-size: 12px; font-weight: bold; }
        .price-old { color: #f87171; text-decoration: line-through; margin-left: 4px; font-size: 10px; }
        .price-new { color: #34d399; }
        .price-mine { color: #38bdf8; }

        .action-chip { background: rgba(255,255,255,0.03); border-right: 2px solid var(--primary); padding: 4px 8px; font-size: 11px; color: #cbd5e1; border-radius: 0 4px 4px 0; margin-top: 4px; }

        .action-links { display: flex; gap: 4px; flex-wrap: wrap; }
        .a-btn { background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: #94a3b8; padding: 3px 7px; border-radius: 4px; font-size: 10px; text-decoration: none; display: inline-flex; align-items: center; gap: 3px; font-weight: 600; transition: all 0.15s; }
        .a-btn:hover { background: var(--surface-hover); color: #fff; border-color: #475569; }
        .a-btn.primary { color: #38bdf8; border-color: rgba(56,189,248,0.3); }
        .a-btn.edit { color: #fbbf24; border-color: rgba(251,191,36,0.3); }
        .a-btn.photo { color: #f472b6; border-color: rgba(236,72,153,0.3); cursor: pointer; }

        /* نسخه موبایل (کارت‌های مدرن) */
        .mobile-cards { display: none; }

        @media (max-width: 900px) {
            .table-card { display: none; }
            .mobile-cards { display: flex; flex-direction: column; gap: 10px; }
            .m-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
            .m-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.05); }
            .m-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 6px; }
            .m-label { font-size: 10px; color: var(--muted); font-weight: 600; }
            .toolbar { flex-direction: column; align-items: stretch; }
            .search-box { width: 100%; }
        }

        /* لایت‌باکس اسکرین‌شات */
        .modal { display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(5px); justify-content: center; align-items: center; padding: 15px; }
        .modal-content { max-width: 95%; max-height: 90vh; border-radius: 10px; border: 1px solid #475569; }
        .modal-close { position: absolute; top: 15px; right: 20px; font-size: 28px; color: #fff; cursor: pointer; }
    </style>
</head>
<body>
<div class="container">
    <!-- هدر جمع‌وجور -->
    <div class="top-bar">
        <div class="logo-title">
            <span>🤖 پایش هوشمند محصولات</span>
            <span class="logo-badge">Gemini 2.5 Flash</span>
        </div>
        <div class="meta-tag">
            <span>🕒 بروزرسانی: ${new Date().toLocaleDateString('fa-IR')}</span>
            <span>•</span>
            <span>📦 ${total} محصول پایش‌شده</span>
        </div>
    </div>

    <!-- نوارهای آماری فشرده -->
    <div class="quick-stats">
        <div class="q-card" onclick="setFilter('ALL')">
            <span>کل:</span> <span class="q-num">${total}</span>
        </div>
        <div class="q-card" style="border-color: rgba(16,185,129,0.4);" onclick="setFilter('OK')">
            <span style="color:var(--success)">🟢 هماهنگ:</span> <span class="q-num" style="color:var(--success)">${okCount}</span>
        </div>
        <div class="q-card" style="border-color: rgba(239,68,68,0.4);" onclick="setFilter('CRITICAL')">
            <span style="color:var(--critical)">🔴 بحرانی:</span> <span class="q-num" style="color:var(--critical)">${criticalCount}</span>
        </div>
        <div class="q-card" style="border-color: rgba(245,158,11,0.4);" onclick="setFilter('MISSING_SIZES')">
            <span style="color:var(--warning)">👟 سایز گمشده:</span> <span class="q-num" style="color:var(--warning)">${missingSizesCount}</span>
        </div>
        <div class="q-card" style="border-color: rgba(239,68,68,0.4);" onclick="setFilter('PHANTOM_STOCK')">
            <span style="color:var(--critical)">⚠️ سایز کاذب:</span> <span class="q-num" style="color:var(--critical)">${phantomSizesCount}</span>
        </div>
        <div class="q-card" onclick="setFilter('PRICE')">
            <span style="color:var(--info)">💰 اختلاف قیمت:</span> <span class="q-num" style="color:var(--info)">${priceMismatchCount}</span>
        </div>
        <div class="q-card" style="border-color: rgba(236,72,153,0.4);" onclick="setFilter('SCREENSHOT')">
            <span style="color:var(--pink)">📸 اسکرین‌شات:</span> <span class="q-num" style="color:var(--pink)">${screenshotsCount}</span>
        </div>
    </div>

    <!-- فیلترها و سرچ -->
    <div class="toolbar">
        <div class="filter-group">
            <button class="f-btn active" data-filter="ALL">همه (${total})</button>
            <button class="f-btn" data-filter="OK">🟢 اکی (${okCount})</button>
            <button class="f-btn" data-filter="CRITICAL">🔴 بحرانی (${criticalCount})</button>
            <button class="f-btn" data-filter="MISSING_SIZES">👟 سایز گمشده (${missingSizesCount})</button>
            <button class="f-btn" data-filter="PHANTOM_STOCK">⚠️ سایز کاذب (${phantomSizesCount})</button>
            <button class="f-btn" data-filter="PRICE">💰 قیمت (${priceMismatchCount})</button>
            <button class="f-btn" data-filter="SCREENSHOT">📸 اسکرین‌شات (${screenshotsCount})</button>
        </div>
        <input type="text" id="searchInput" class="search-box" placeholder="🔍 جستجو (شناسه، نام، تامین‌کننده)...">
    </div>

    <!-- جدول دسکتاپ -->
    <div class="table-card">
        <table id="auditTable">
            <thead>
                <tr>
                    <th style="width:70px;">محصول</th>
                    <th style="width:90px;">وضعیت</th>
                    <th style="width:260px;">🏪 در سایت شما</th>
                    <th style="width:260px;">🏬 در تامین‌کننده</th>
                    <th style="width:130px;">دسترسی سریع</th>
                </tr>
            </thead>
            <tbody>
                ${auditResults.map(item => `
                <tr class="product-item"
                    data-severity="${item.severity}" 
                    data-is-ok="${item.status_tag === 'OK'}"
                    data-has-missing="${item.missing_sizes_in_store.length > 0}"
                    data-has-phantom="${item.phantom_sizes_in_store.length > 0}"
                    data-has-price="${item.price_discrepancy !== null}"
                    data-has-screenshot="${Boolean(item.screenshot_base64 || item.screenshot_file)}">
                    
                    <td>
                        <strong style="color:#fff;">#${item.id}</strong><br>
                        <span style="font-size:10px; color:var(--muted);">${item.domain}</span>
                    </td>
                    <td>
                        ${item.status_tag === 'OK' 
                            ? '<span class="pill pill-ok">🟢 اکی</span>'
                            : `<span class="pill pill-${item.severity.toLowerCase()}">${item.severity}</span>`
                        }
                    </td>
                    <td>
                        <div class="price-chip">
                            قیمت: ${item.our_data.price_lir ? `<span class="price-mine">${item.our_data.price_lir} ₺</span>` : '<span style="color:#64748b; font-size:11px;">تنظیم نشده</span>'}
                        </div>
                        <div style="margin-top:3px;">
                            ${Object.keys(item.our_data.sizes).length > 0 
                                ? Object.entries(item.our_data.sizes).map(([s, q]) => `
                                    <span class="tag-size ${q > 0 ? (item.phantom_sizes_in_store.some(p => p.size === s) ? 'phantom' : 'in') : 'out'}">
                                        ${s}${q > 0 ? `(${q})` : ''}
                                    </span>
                                `).join('')
                                : '<span style="color:#64748b; font-size:10px;">تنوعی ثبت نشده</span>'
                            }
                        </div>
                    </td>
                    <td>
                        <div class="price-chip">
                            ${item.supplier_data.success 
                                ? (item.supplier_data.has_discount 
                                    ? `<span class="price-old">${item.supplier_data.regular_price}₺</span> <span class="price-new">${item.supplier_data.offer_price}₺</span>`
                                    : `<span class="price-new">${item.supplier_data.regular_price} ₺</span>`
                                  )
                                : '<span style="color:var(--critical); font-size:11px;">عدم دسترسی</span>'
                            }
                        </div>
                        <div style="margin-top:3px;">
                            ${item.supplier_data.success 
                                ? (item.supplier_data.in_stock_sizes.length > 0 
                                    ? item.supplier_data.in_stock_sizes.map(s => `
                                        <span class="tag-size ${item.missing_sizes_in_store.some(m => m.size === s.size) ? 'missing' : 'in'}">
                                            ✓ ${s.size}${s.qty > 1 ? `(${s.qty})` : ''}
                                        </span>
                                      `).join('')
                                    : '<span style="color:var(--critical); font-size:10px;">کل سایزها ناموجود</span>'
                                  )
                                : '<span style="color:var(--pink); font-size:10px;">📸 تصویر زنده ثبت شد</span>'
                            }
                        </div>
                    </td>
                    <td>
                        <div class="action-links">
                            ${item.our_url ? `<a href="${item.our_url}" target="_blank" class="a-btn primary">🛍️ سایت</a>` : ''}
                            ${item.our_edit_url ? `<a href="${item.our_edit_url}" target="_blank" class="a-btn edit">✏️ ویرایش</a>` : ''}
                            ${item.primary_url ? `<a href="${item.primary_url}" target="_blank" class="a-btn">🏬 منبع</a>` : ''}
                            ${(item.screenshot_base64 || item.screenshot_file) ? `
                                <button class="a-btn photo" onclick="openModal('${item.screenshot_base64 || item.screenshot_file}')">📸 عکس</button>
                            ` : ''}
                        </div>
                    </td>
                </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

    <!-- نسخه کارت‌های موبایل -->
    <div class="mobile-cards">
        ${auditResults.map(item => `
        <div class="m-card product-item"
            data-severity="${item.severity}" 
            data-is-ok="${item.status_tag === 'OK'}"
            data-has-missing="${item.missing_sizes_in_store.length > 0}"
            data-has-phantom="${item.phantom_sizes_in_store.length > 0}"
            data-has-price="${item.price_discrepancy !== null}"
            data-has-screenshot="${Boolean(item.screenshot_base64 || item.screenshot_file)}">
            
            <div class="m-card-header">
                <div>
                    <strong>#${item.id}</strong> <span style="font-size:11px; color:var(--muted);">(${item.domain})</span>
                </div>
                <div>
                    ${item.status_tag === 'OK' 
                        ? '<span class="pill pill-ok">🟢 اکی</span>'
                        : `<span class="pill pill-${item.severity.toLowerCase()}">${item.severity}</span>`
                    }
                </div>
            </div>

            <div class="m-grid">
                <div>
                    <div class="m-label">🏪 در سایت شما:</div>
                    <div class="price-mine" style="font-weight:bold;">${item.our_data.price_lir ? item.our_data.price_lir + ' ₺' : 'تنظیم نشده'}</div>
                    <div style="margin-top:2px;">
                        ${Object.keys(item.our_data.sizes).length > 0 
                            ? Object.entries(item.our_data.sizes).map(([s, q]) => `<span class="tag-size ${q > 0 ? 'in' : 'out'}">${s}</span>`).join('')
                            : '<span style="color:#64748b; font-size:10px;">-</span>'
                        }
                    </div>
                </div>
                <div>
                    <div class="m-label">🏬 در تامین‌کننده:</div>
                    <div class="price-new" style="font-weight:bold;">${item.supplier_data.effective_price ? item.supplier_data.effective_price + ' ₺' : 'نامشخص'}</div>
                    <div style="margin-top:2px;">
                        ${item.supplier_data.in_stock_sizes.length > 0 
                            ? item.supplier_data.in_stock_sizes.map(s => `<span class="tag-size in">${s.size}</span>`).join('')
                            : '<span style="color:var(--critical); font-size:10px;">ناموجود</span>'
                        }
                    </div>
                </div>
            </div>

            <div class="action-links">
                ${item.our_url ? `<a href="${item.our_url}" target="_blank" class="a-btn primary">🛍️ سایت ما</a>` : ''}
                ${item.our_edit_url ? `<a href="${item.our_edit_url}" target="_blank" class="a-btn edit">✏️ ویرایش</a>` : ''}
                ${item.primary_url ? `<a href="${item.primary_url}" target="_blank" class="a-btn">🏬 تامین‌کننده</a>` : ''}
                ${(item.screenshot_base64 || item.screenshot_file) ? `
                    <button class="a-btn photo" onclick="openModal('${item.screenshot_base64 || item.screenshot_file}')">📸 اسکرین‌شات</button>
                ` : ''}
            </div>
        </div>
        `).join('')}
    </div>
</div>

<!-- Modal Lightbox -->
<div id="imageModal" class="modal" onclick="closeModal()">
    <span class="modal-close" onclick="closeModal()">&times;</span>
    <img id="modalImg" class="modal-content" src="" alt="Screenshot">
</div>

<script>
    function openModal(src) {
        document.getElementById('modalImg').src = src;
        document.getElementById('imageModal').style.display = 'flex';
    }

    function closeModal() {
        document.getElementById('imageModal').style.display = 'none';
    }

    const filterBtns = document.querySelectorAll('.f-btn');
    const searchInput = document.getElementById('searchInput');
    const items = document.querySelectorAll('.product-item');

    let currentFilter = 'ALL';

    function setFilter(f) {
        currentFilter = f;
        filterBtns.forEach(b => {
            if (b.getAttribute('data-filter') === f) b.classList.add('active');
            else b.classList.remove('active');
        });
        applyFilters();
    }

    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setFilter(btn.getAttribute('data-filter'));
        });
    });

    searchInput.addEventListener('input', applyFilters);

    function applyFilters() {
        const query = searchInput.value.toLowerCase().trim();

        items.forEach(item => {
            const severity = item.getAttribute('data-severity');
            const isOk = item.getAttribute('data-is-ok') === 'true';
            const hasMissing = item.getAttribute('data-has-missing') === 'true';
            const hasPhantom = item.getAttribute('data-has-phantom') === 'true';
            const hasPrice = item.getAttribute('data-has-price') === 'true';
            const hasScreenshot = item.getAttribute('data-has-screenshot') === 'true';
            const itemText = item.innerText.toLowerCase();

            let matchesFilter = false;
            if (currentFilter === 'ALL') matchesFilter = true;
            else if (currentFilter === 'OK' && isOk) matchesFilter = true;
            else if (currentFilter === 'CRITICAL' && severity === 'CRITICAL') matchesFilter = true;
            else if (currentFilter === 'MISSING_SIZES' && hasMissing) matchesFilter = true;
            else if (currentFilter === 'PHANTOM_STOCK' && hasPhantom) matchesFilter = true;
            else if (currentFilter === 'PRICE' && hasPrice) matchesFilter = true;
            else if (currentFilter === 'SCREENSHOT' && hasScreenshot) matchesFilter = true;

            const matchesSearch = query === '' || itemText.includes(query);

            if (matchesFilter && matchesSearch) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        });
    }
</script>
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`\n💾 داشبورد فشرده و ریسپانسیو ذخیره شد: ${outputFile}`);
}

// ==========================================
// 🚀 اجرای فرآیند اصلی
// ==========================================

async function main() {
    const args = process.argv.slice(2);

    let productsFile = 'products_tennis24shop_com.json';
    let stockFile = 'stock-data_tennis24shop_com.json';
    let modelName = CONFIG.default_model;
    let limit = Infinity; // پیش‌فرض: بررسی تمام محصولات
    let runAI = true;
    let takeScreenshots = true;

    args.forEach(arg => {
        if (arg.startsWith('--products=')) productsFile = arg.split('=')[1];
        else if (arg.startsWith('--stock=')) stockFile = arg.split('=')[1];
        else if (arg.startsWith('--model=')) modelName = arg.split('=')[1];
        else if (arg.startsWith('--key=')) CONFIG.api_key = arg.split('=')[1];
        else if (arg.startsWith('--limit=')) {
            const raw = arg.split('=')[1].trim();
            if (raw && !isNaN(parseInt(raw)) && parseInt(raw) > 0) {
                limit = parseInt(raw);
            } else {
                limit = Infinity;
            }
        }
        else if (arg === '--no-ai') runAI = false;
        else if (arg === '--no-screenshots') takeScreenshots = false;
        else if (arg === '--all') limit = Infinity;
    });

    if (!fs.existsSync(productsFile)) {
        const found = fs.readdirSync('.').find(f => f.startsWith('products_') && f.endsWith('.json')) || 'products.json';
        if (fs.existsSync(found)) productsFile = found;
    }

    if (!fs.existsSync(stockFile)) {
        const found = fs.readdirSync('.').find(f => f.startsWith('stock-data_') && f.endsWith('.json')) || 'stock-data.json';
        if (fs.existsSync(found)) stockFile = found;
    }

    console.log('='.repeat(70));
    console.log('  🤖 Gemini AI Auditor (مقایسه دوطرفه + اسکرین‌شات زنده)');
    console.log('='.repeat(70));
    console.log(`📂 فایل محصولات ووکامرس: ${productsFile}`);
    console.log(`📂 فایل دیتای اسکرپ شده : ${stockFile}`);
    console.log(`🧠 مدل انتخابی جمنای    : ${runAI ? modelName : 'غیرفعال (--no-ai)'}`);
    console.log(`📸 ثبت خودکار اسکرین‌شات: ${takeScreenshots ? 'فعال' : 'غیرفعال'}`);
    console.log(`🎯 حداکثر تعداد بررسی  : ${limit === Infinity ? 'همه محصولات' : limit}`);

    if (!fs.existsSync(productsFile) || !fs.existsSync(stockFile)) {
        console.error('❌ فایل‌های ورودی یافت نشدند.');
        process.exit(1);
    }

    const rawProducts = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
    const products = (Array.isArray(rawProducts) ? rawProducts : Object.values(rawProducts)).slice(0, limit);
    const stockData = JSON.parse(fs.readFileSync(stockFile, 'utf8'));

    // مرحله ۱: تحلیل دوطرفه
    const auditResults = performAlgorithmicAudit(products, stockData);

    // مرحله ۲: ثبت اسکرین‌شات از سایت‌های ناموفق (مثل اسیکس، دکلتون)
    if (takeScreenshots) {
        const failedItems = auditResults.filter(r => !r.supplier_data.success && r.primary_url);
        const toCapture = failedItems.slice(0, CONFIG.screenshots.max_screenshots_per_run || 10);
        if (toCapture.length > 0) {
            await captureScreenshotsForItems(toCapture);
        }
    }

    // مرحله ۳: تحلیل هوش مصنوعی Gemini
    let executiveSummary = 'حسابرسی دوطرفه با موفقیت انجام شد.';
    if (runAI) {
        const itemsForAI = auditResults.filter(r => r.discrepancies.length > 0 || !r.supplier_data.success);
        if (itemsForAI.length > 0) {
            executiveSummary = await performAIAudit(itemsForAI.slice(0, 30), modelName);
        } else {
            executiveSummary = '🎉 تبریک! تمام محصولات بررسی شده ۱۰۰٪ با تامین‌کنندگان هماهنگ بوده و هیچ مغایرتی در سایز یا قیمت مشاهده نشد.';
        }
    }

    // ذخیره خروجی‌ها
    const jsonOutput = path.join(OUTPUT_DIR, 'audit-report.json');
    const htmlOutput = path.join(OUTPUT_DIR, 'audit-report.html');
    const csvOutput = path.join(OUTPUT_DIR, 'audit-report.csv');

    fs.writeFileSync(jsonOutput, JSON.stringify({
        generated_at: new Date().toISOString(),
        executive_summary: executiveSummary,
        total_audited: auditResults.length,
        results: auditResults
    }, null, 2), 'utf8');

    // خروجی CSV
    const csvRows = [
        ['ID', 'Title', 'Domain', 'Status', 'Severity', 'Our Price (TRY)', 'Supplier Price (TRY)', 'Missing Sizes in Store', 'Phantom Sizes in Store', 'Has Screenshot', 'AI Summary', 'Action'].join(',')
    ];
    auditResults.forEach(r => {
        csvRows.push([
            r.id,
            `"${(r.title || '').replace(/"/g, '""')}"`,
            `"${r.domain}"`,
            r.status_tag,
            r.severity,
            r.our_data.price_lir || '',
            r.supplier_data.effective_price || '',
            `"${r.missing_sizes_in_store.map(s => s.size).join(' ')}"`,
            `"${r.phantom_sizes_in_store.map(s => s.size).join(' ')}"`,
            Boolean(r.screenshot_base64 || r.screenshot_file) ? 'YES' : 'NO',
            `"${(r.ai_summary || '').replace(/"/g, '""')}"`,
            `"${(r.recommended_action || '').replace(/"/g, '""')}"`
        ].join(','));
    });
    fs.writeFileSync(csvOutput, csvRows.join('\n'), 'utf8');

    generateHtmlDashboard(auditResults, executiveSummary, htmlOutput);

    console.log('\n' + '='.repeat(70));
    console.log('🏁 حسابرسی دوطرفه هوشمند با موفقیت پایان یافت!');
    console.log(`📄 گزارش JSON: ${jsonOutput}`);
    console.log(`📊 گزارش CSV : ${csvOutput}`);
    console.log(`🌐 داشبورد HTML: ${htmlOutput}`);
    console.log('='.repeat(70));
}

main().catch(err => {
    console.error('💥 Fatal Error:', err.message);
    process.exit(1);
});
