#!/usr/bin/env node
/**
 * ==============================================================================
 * 🤖 Gemini AI Product & Supplier Auditor (نسخه پیشرفته - مقایسه دوطرفه)
 * ==============================================================================
 * سیستم حسابرس و مقایسه‌گر هوشمند محصولات فروشگاه با سایت‌های تامین‌کننده
 * 
 * 🔍 موارد مورد بررسی:
 * ۱. مقایسه سایزهای موجود در تامین‌کننده با سایزهای تعریف‌شده در سایت شما
 * ۲. تشخیص سایزهای گمشده در سایت شما (فرصت فروش از دست رفته)
 * ۳. تشخیص سایزهای ناموجود در تامین‌کننده که در سایت شما هنوز روشن است (خطر لغو سفارش)
 * ۴. بررسی اختلاف قیمت لیر سایت شما با قیمت روز یا تخفیف‌دار تامین‌کننده
 * ۵. تشخیص صفحات حذف‌شده (404)، ریدایرکت‌شده یا مسدودشده تامین‌کننده
 * ۶. تایید و برچسب‌گذاری محصولات کاملاً هماهنگ و بدون نقص (All OK)
 * 
 * قدرت گرفته از هوش مصنوعی Google Gemini (gemini-flash-lite-latest)
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
// 🔍 لایه ۱: تحلیل و مقایسه دوطرفه (سایت ما vs تامین‌کننده)
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

        const itemAudit = {
            id: product.id,
            title: ourTitle,
            sku: ourSku,
            primary_url: primaryUrl,
            secondary_url: secondaryUrl,
            domain: domain,
            
            // وضعیت در سایت ما
            our_data: {
                price_lir: ourPrice,
                stock_status: ourStockStatus,
                sizes: ourSizes
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

        // ۱. بررسی خطای عدم وجود دیتای اسکرپ
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

        // ۲. بررسی خطای صفحه یا بلاک تامین‌کننده (404، Cloudflare، ...)
        if (!supplierInfo.success) {
            const errMsg = supplierInfo.error || 'خطای دسترسی به صفحه تامین‌کننده';
            itemAudit.supplier_data.error = errMsg;
            
            let isDeadOrRedirect = errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('Redirect');
            let isBlocked = errMsg.includes('Cloudflare') || errMsg.includes('Blocked') || errMsg.includes('DKT');

            itemAudit.discrepancies.push({
                type: isDeadOrRedirect ? 'SUPPLIER_PAGE_DEAD' : (isBlocked ? 'CLOUDFLARE_BLOCKED' : 'SCRAPER_ERROR'),
                message: isDeadOrRedirect 
                    ? 'صفحه محصول در سایت تامین‌کننده حذف یا ریدایرکت شده است (404).'
                    : `خطای اسکرپر در تامین‌کننده: ${errMsg}`
            });

            itemAudit.status_tag = isDeadOrRedirect ? 'CRITICAL' : 'ERROR';
            itemAudit.severity = isDeadOrRedirect ? 'CRITICAL' : 'WARNING';
            itemAudit.ai_summary = isDeadOrRedirect ? 'صفحه تامین‌کننده در دسترس نیست یا محصول حذف شده است.' : 'خطای دسترسی به تامین‌کننده رخ داده است.';
            itemAudit.recommended_action = isDeadOrRedirect ? 'لینک تامین‌کننده را در سایت اصلاح یا در صورت اتمام، محصول را ناموجود کنید.' : 'بررسی اتصال یا بایپس کلودفلر.';
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
        // ⚖️ مقایسه دوطرفه (Our Store vs Supplier)
        // ==========================================

        const ourSizeKeys = Object.keys(ourSizes);
        const hasOurSizes = ourSizeKeys.length > 0;

        // الف) بررسی سایزهای گمشده (تامین‌کننده موجود دارد، ولی در سایت ما نیست یا ۰ است)
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

        // ب) بررسی موجودی کاذب (سایت ما موجود نشان می‌دهد ولی تامین‌کننده تمام کرده)
        if (hasOurSizes) {
            ourSizeKeys.forEach(ourSize => {
                const ourQty = ourSizes[ourSize];
                if (ourQty > 0) {
                    // بررسی در تامین‌کننده
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

        // ج) بررسی ناموجودی کل در تامین‌کننده
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

        // د) بررسی اختلاف قیمت
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

        // هـ) بررسی محصول کاملاً هماهنگ و بدون مشکل (All OK)
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
                error: item.supplier_data.error || null
            },
            discrepancies: item.discrepancies.map(d => d.message),
            missing_sizes: item.missing_sizes_in_store.map(m => m.size),
            phantom_sizes: item.phantom_sizes_in_store.map(p => p.size)
        }));

        const prompt = `شما کارشناس هوش مصنوعی مانیتورینگ فروشگاه اینترنتی هستید.
مقایسه دقیق وضعیت محصولات "سایت ما" در برابر "سایت تامین‌کننده" در قالب JSON ارسال شده است.

لطفاً برای هر محصول:
1. "severity": یکی از مقادیر ("CRITICAL", "WARNING", "INFO", "OK")
   - CRITICAL: خطر سفارش ناموجود (سایزی که تامین‌کننده تمام کرده ولی در سایت ما موجود است)، افزایش شدید قیمت تامین‌کننده، یا حذف صفحه (404)
   - WARNING: فرصت فروش از دست رفته (سایزی که تامین‌کننده دارد ولی سایت ما ندارد)، تخفیف تامین‌کننده
   - INFO: اطلاع‌رسانی معمولی
   - OK: هماهنگی کامل
2. "ai_summary": تحلیل بسیار دقیق و خلاصه به زبان فارسی روان (مثلا: "سایز ۴۲ در تامین‌کننده موجود است ولی در سایت ندارید. قیمت لیر تامین‌کننده هم ۱۵٪ بالا رفته.")
3. "recommended_action": دستور اقدام صریح و عملیاتی برای مدیر سایت (مثلا: "سایز ۴۲ را به محصول اضافه کنید و قیمت لیر را به ۳۵۰۰ تغییر دهید.")

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

    // تولید گزارش کلان مدیریتی
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
۲. نقاط خطر فوری (خطر لغو سفارش به دلیل سایزهای ناموجود یا ضرر مالی قیمت‌ها)
۳. ۳ توصیه عملیاتی و فوری به مدیر سایت با ایموجی‌های مناسب.`;

        executiveSummary = await callGemini(summaryPrompt, modelName);
    } catch (e) {
        executiveSummary = 'خلاصه وضعیت: تحلیل دوطرفه انجام شد و مغایرت‌ها در جدول زیر مشخص شده‌اند.';
    }

    return executiveSummary;
}

// ==========================================
// 📊 تولید گزارش گرافیکی HTML با مقایسه Side-by-Side
// ==========================================

function generateHtmlDashboard(auditResults, executiveSummary, outputFile) {
    const total = auditResults.length;
    const okCount = auditResults.filter(r => r.severity === 'NORMAL' || r.status_tag === 'OK').length;
    const criticalCount = auditResults.filter(r => r.severity === 'CRITICAL').length;
    const warningCount = auditResults.filter(r => r.severity === 'WARNING').length;
    const missingSizesCount = auditResults.filter(r => r.missing_sizes_in_store.length > 0).length;
    const phantomSizesCount = auditResults.filter(r => r.phantom_sizes_in_store.length > 0).length;
    const priceMismatchCount = auditResults.filter(r => r.price_discrepancy !== null).length;
    const deadLinksCount = auditResults.filter(r => !r.supplier_data.success).length;

    const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>داشبورد حسابرسی دوطرفه محصولات | AI Product Auditor</title>
    <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: #151d30;
            --card-border: #243049;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --primary: #8b5cf6;
            --primary-gradient: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
            --critical: #ef4444;
            --warning: #f59e0b;
            --info: #3b82f6;
            --success: #10b981;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Vazirmatn', sans-serif; }
        body { background-color: var(--bg-color); color: var(--text-primary); padding: 30px 20px; line-height: 1.6; }
        .container { max-width: 1400px; margin: 0 auto; }

        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; flex-wrap: wrap; gap: 15px; }
        .header h1 { font-size: 24px; font-weight: 800; background: var(--primary-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .header .meta { font-size: 13px; color: var(--text-secondary); }

        /* کارت‌های آمار */
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 15px; margin-bottom: 25px; }
        .stat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 16px; display: flex; align-items: center; gap: 15px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); }
        .stat-icon { font-size: 26px; width: 48px; height: 48px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.05); }
        .stat-info .num { font-size: 20px; font-weight: 800; }
        .stat-info .label { font-size: 11px; color: var(--text-secondary); }

        /* گزارش مدیریتی */
        .ai-summary-box { background: linear-gradient(135deg, rgba(139,92,246,0.12) 0%, rgba(59,130,246,0.12) 100%); border: 1px solid rgba(139,92,246,0.35); border-radius: 12px; padding: 22px; margin-bottom: 25px; }
        .ai-summary-title { font-size: 16px; font-weight: 700; color: #c084fc; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
        .ai-summary-content { font-size: 14px; color: #e2e8f0; white-space: pre-line; line-height: 1.8; }

        /* فیلترها و جستجو */
        .controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 15px; background: var(--card-bg); padding: 15px; border-radius: 10px; border: 1px solid var(--card-border); }
        .filter-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
        .filter-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); color: var(--text-secondary); padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
        .filter-btn.active, .filter-btn:hover { background: var(--primary); color: #fff; border-color: var(--primary); font-weight: 600; }
        .search-input { background: #0b0f19; border: 1px solid var(--card-border); color: #fff; padding: 8px 15px; border-radius: 8px; font-size: 13px; width: 280px; outline: none; }
        .search-input:focus { border-color: var(--primary); }

        /* جدول Side-by-Side */
        .table-wrapper { background: var(--card-bg); border-radius: 12px; border: 1px solid var(--card-border); overflow-x: auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); }
        table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: right; }
        th, td { padding: 14px 16px; border-bottom: 1px solid var(--card-border); vertical-align: top; }
        th { background: #111827; color: var(--text-secondary); font-weight: 600; }
        tr:hover { background: rgba(255,255,255,0.02); }

        /* تگ‌ها و بج‌ها */
        .badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; }
        .badge-critical { background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid rgba(239,68,68,0.4); }
        .badge-warning { background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); }
        .badge-info { background: rgba(59,130,246,0.2); color: #60a5fa; border: 1px solid rgba(59,130,246,0.4); }
        .badge-normal, .badge-ok { background: rgba(16,185,129,0.2); color: #34d399; border: 1px solid rgba(16,185,129,0.4); }
        .badge-error { background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid rgba(239,68,68,0.4); }

        .compare-box { background: rgba(255,255,255,0.03); border-radius: 8px; padding: 10px; font-size: 12px; margin-bottom: 5px; }
        .compare-title { font-weight: 700; font-size: 11px; margin-bottom: 5px; color: var(--text-secondary); text-transform: uppercase; }

        .size-tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin: 2px; }
        .size-tag.in { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
        .size-tag.out { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
        .size-tag.missing { background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); font-weight: bold; }
        .size-tag.phantom { background: rgba(239,68,68,0.25); color: #fca5a5; border: 1px solid rgba(239,68,68,0.5); font-weight: bold; }

        .action-box { background: rgba(139,92,246,0.08); border-right: 3px solid var(--primary); padding: 8px 12px; border-radius: 0 6px 6px 0; font-size: 12px; color: #cbd5e1; margin-top: 6px; }

        a.btn-link { color: #818cf8; text-decoration: none; font-size: 12px; }
        a.btn-link:hover { text-decoration: underline; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>🤖 داشبورد حسابرسی دوطرفه محصولات (سایت شما vs تامین‌کننده)</h1>
            <div class="meta">بررسی دقیق سایزهای گمشده، خطرات اتمام موجودی، تغییرات قیمتی و لینک‌های حذف‌شده • تاریخ: ${new Date().toLocaleDateString('fa-IR')}</div>
        </div>
    </div>

    <!-- آمار سریع -->
    <div class="stats-grid">
        <div class="stat-card" style="border-color: rgba(16,185,129,0.4);">
            <div class="stat-icon" style="color: var(--success);">🟢</div>
            <div class="stat-info"><div class="num" style="color: var(--success);">${okCount}</div><div class="label">کاملاً هماهنگ و اکی</div></div>
        </div>
        <div class="stat-card" style="border-color: rgba(239,68,68,0.4);">
            <div class="stat-icon" style="color: var(--critical);">🔴</div>
            <div class="stat-info"><div class="num" style="color: var(--critical);">${criticalCount}</div><div class="label">بحرانی (خطر لغو سفارش یا ضرر)</div></div>
        </div>
        <div class="stat-card" style="border-color: rgba(245,158,11,0.4);">
            <div class="stat-icon" style="color: var(--warning);">👟</div>
            <div class="stat-info"><div class="num" style="color: var(--warning);">${missingSizesCount}</div><div class="label">سایز گمشده در سایت شما</div></div>
        </div>
        <div class="stat-card" style="border-color: rgba(239,68,68,0.4);">
            <div class="stat-icon" style="color: var(--critical);">⚠️</div>
            <div class="stat-info"><div class="num" style="color: var(--critical);">${phantomSizesCount}</div><div class="label">سایز کاذب (اتمام در تامین‌کننده)</div></div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">💰</div>
            <div class="stat-info"><div class="num">${priceMismatchCount}</div><div class="label">مغایرت قیمت لیر</div></div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">🚫</div>
            <div class="stat-info"><div class="num">${deadLinksCount}</div><div class="label">لینک حذف‌شده / خطای صفحه</div></div>
        </div>
    </div>

    <!-- خلاصه هوش مصنوعی -->
    <div class="ai-summary-box">
        <div class="ai-summary-title">🧠 گزارش و تحلیل مدیریتی هوش مصنوعی Gemini</div>
        <div class="ai-summary-content">${executiveSummary}</div>
    </div>

    <!-- ابزارهای فیلتر -->
    <div class="controls">
        <div class="filter-buttons">
            <button class="filter-btn active" data-filter="ALL">همه (${total})</button>
            <button class="filter-btn" data-filter="OK">🟢 کاملاً اکی (${okCount})</button>
            <button class="filter-btn" data-filter="CRITICAL">🔴 بحرانی (${criticalCount})</button>
            <button class="filter-btn" data-filter="MISSING_SIZES">👟 سایز گمشده (${missingSizesCount})</button>
            <button class="filter-btn" data-filter="PHANTOM_STOCK">⚠️ سایز کاذب (${phantomSizesCount})</button>
            <button class="filter-btn" data-filter="PRICE">💰 مغایرت قیمت (${priceMismatchCount})</button>
            <button class="filter-btn" data-filter="DEAD">🚫 لینک نامعتبر (${deadLinksCount})</button>
        </div>
        <input type="text" id="searchInput" class="search-input" placeholder="🔍 جستجو بر اساس ID، نام، دامنه...">
    </div>

    <!-- جدول نتایج دوطرفه -->
    <div class="table-wrapper">
        <table id="auditTable">
            <thead>
                <tr>
                    <th style="width: 100px;">محصول</th>
                    <th style="width: 110px;">وضعیت تطابق</th>
                    <th style="width: 250px;">🏪 در سایت شما (Our Site)</th>
                    <th style="width: 250px;">🏬 در تامین‌کننده (Supplier)</th>
                    <th>🧠 تحلیل هوش مصنوعی Gemini و راهکار</th>
                    <th style="width: 90px;">لینک</th>
                </tr>
            </thead>
            <tbody>
                ${auditResults.map(item => `
                <tr data-severity="${item.severity}" 
                    data-is-ok="${item.status_tag === 'OK'}"
                    data-has-missing="${item.missing_sizes_in_store.length > 0}"
                    data-has-phantom="${item.phantom_sizes_in_store.length > 0}"
                    data-has-price="${item.price_discrepancy !== null}"
                    data-has-dead="${!item.supplier_data.success}">
                    
                    <td>
                        <strong>#${item.id}</strong><br>
                        <span style="font-size:11px; color:#94a3b8;">${item.sku || item.domain}</span>
                    </td>
                    <td>
                        ${item.status_tag === 'OK' 
                            ? '<span class="badge badge-ok">🟢 هماهنگ (OK)</span>'
                            : `<span class="badge badge-${item.severity.toLowerCase()}">${item.severity}</span>`
                        }
                    </td>
                    <td>
                        <div class="compare-box">
                            <div class="compare-title">قیمت لیر سایت شما:</div>
                            <div style="font-weight:bold; font-size:13px; color:#38bdf8;">
                                ${item.our_data.price_lir ? item.our_data.price_lir + ' ₺' : '<span style="color:#64748b;">تنظیم نشده</span>'}
                            </div>
                            <div class="compare-title" style="margin-top:6px;">سایزهای موجود در سایت شما:</div>
                            <div>
                                ${Object.keys(item.our_data.sizes).length > 0 
                                    ? Object.entries(item.our_data.sizes).map(([s, q]) => `
                                        <span class="size-tag ${q > 0 ? (item.phantom_sizes_in_store.some(p => p.size === s) ? 'phantom' : 'in') : 'out'}">
                                            ${s} (${q})
                                        </span>
                                    `).join('')
                                    : '<span style="color:#64748b; font-size:11px;">تنوعی ثبت نشده</span>'
                                }
                            </div>
                        </div>
                    </td>
                    <td>
                        <div class="compare-box">
                            <div class="compare-title">قیمت تامین‌کننده (${item.domain}):</div>
                            <div style="font-weight:bold; font-size:13px;">
                                ${item.supplier_data.success 
                                    ? (item.supplier_data.has_discount 
                                        ? `<span style="text-decoration:line-through; color:#ef4444; font-size:11px;">${item.supplier_data.regular_price}₺</span> <span style="color:#10b981;">${item.supplier_data.offer_price}₺</span> <span style="color:#f87171; font-size:10px;">(-${item.supplier_data.discount_percent}%)</span>`
                                        : `<span style="color:#10b981;">${item.supplier_data.regular_price} ₺</span>`
                                      )
                                    : '<span style="color:#ef4444;">عدم دسترسی</span>'
                                }
                            </div>
                            <div class="compare-title" style="margin-top:6px;">سایزهای موجود در تامین‌کننده:</div>
                            <div>
                                ${item.supplier_data.success 
                                    ? (item.supplier_data.in_stock_sizes.length > 0 
                                        ? item.supplier_data.in_stock_sizes.map(s => `
                                            <span class="size-tag ${item.missing_sizes_in_store.some(m => m.size === s.size) ? 'missing' : 'in'}">
                                                ✓ ${s.size} (${s.qty})
                                            </span>
                                          `).join('')
                                        : '<span style="color:#ef4444; font-size:11px;">کل سایزها ناموجود</span>'
                                      )
                                    : `<span style="color:#ef4444; font-size:11px;">${item.supplier_data.error || 'خطا'}</span>`
                                }
                            </div>
                        </div>
                    </td>
                    <td>
                        <div style="font-size:13px; font-weight:600; color:#f1f5f9;">
                            ${item.ai_summary || (item.discrepancies.length > 0 ? item.discrepancies[0].message : 'همه موارد هماهنگ است.')}
                        </div>
                        ${item.discrepancies.length > 1 ? `
                            <ul style="font-size:11px; color:#94a3b8; margin: 4px 15px 0 0;">
                                ${item.discrepancies.slice(1).map(d => `<li>${d.message}</li>`).join('')}
                            </ul>
                        ` : ''}
                        ${item.recommended_action ? `<div class="action-box">💡 راهکار پیشنهادی: ${item.recommended_action}</div>` : ''}
                    </td>
                    <td>
                        ${item.primary_url ? `<a href="${item.primary_url}" target="_blank" class="btn-link">🔗 تامین‌کننده</a>` : ''}
                    </td>
                </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
</div>

<script>
    const filterBtns = document.querySelectorAll('.filter-btn');
    const searchInput = document.getElementById('searchInput');
    const rows = document.querySelectorAll('#auditTable tbody tr');

    let currentFilter = 'ALL';

    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.getAttribute('data-filter');
            applyFilters();
        });
    });

    searchInput.addEventListener('input', applyFilters);

    function applyFilters() {
        const query = searchInput.value.toLowerCase().trim();

        rows.forEach(row => {
            const severity = row.getAttribute('data-severity');
            const isOk = row.getAttribute('data-is-ok') === 'true';
            const hasMissing = row.getAttribute('data-has-missing') === 'true';
            const hasPhantom = row.getAttribute('data-has-phantom') === 'true';
            const hasPrice = row.getAttribute('data-has-price') === 'true';
            const hasDead = row.getAttribute('data-has-dead') === 'true';
            const rowText = row.innerText.toLowerCase();

            let matchesFilter = false;
            if (currentFilter === 'ALL') matchesFilter = true;
            else if (currentFilter === 'OK' && isOk) matchesFilter = true;
            else if (currentFilter === 'CRITICAL' && severity === 'CRITICAL') matchesFilter = true;
            else if (currentFilter === 'MISSING_SIZES' && hasMissing) matchesFilter = true;
            else if (currentFilter === 'PHANTOM_STOCK' && hasPhantom) matchesFilter = true;
            else if (currentFilter === 'PRICE' && hasPrice) matchesFilter = true;
            else if (currentFilter === 'DEAD' && hasDead) matchesFilter = true;

            const matchesSearch = query === '' || rowText.includes(query);

            if (matchesFilter && matchesSearch) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
    }
</script>
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`\n💾 داشبورد مقایسه‌ای ذخیره شد: ${outputFile}`);
}

// ==========================================
// 🚀 اجرای فرآیند اصلی
// ==========================================

async function main() {
    const args = process.argv.slice(2);

    let productsFile = 'products_tennis24shop_com.json';
    let stockFile = 'stock-data_tennis24shop_com.json';
    let modelName = CONFIG.default_model;
    let limit = 50;
    let runAI = true;

    args.forEach(arg => {
        if (arg.startsWith('--products=')) productsFile = arg.split('=')[1];
        else if (arg.startsWith('--stock=')) stockFile = arg.split('=')[1];
        else if (arg.startsWith('--model=')) modelName = arg.split('=')[1];
        else if (arg.startsWith('--key=')) CONFIG.api_key = arg.split('=')[1];
        else if (arg.startsWith('--limit=')) limit = parseInt(arg.split('=')[1]) || 50;
        else if (arg === '--no-ai') runAI = false;
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
    console.log('  🤖 Gemini AI Two-Way Auditor (سایت شما vs تامین‌کننده)');
    console.log('='.repeat(70));
    console.log(`📂 فایل محصولات ووکامرس: ${productsFile}`);
    console.log(`📂 فایل دیتای اسکرپ شده : ${stockFile}`);
    console.log(`🧠 مدل انتخابی جمنای    : ${runAI ? modelName : 'غیرفعال (--no-ai)'}`);
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

    // مرحله ۲: تحلیل هوش مصنوعی Gemini
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
        ['ID', 'Title', 'Domain', 'Status', 'Severity', 'Our Price (TRY)', 'Supplier Price (TRY)', 'Missing Sizes in Store', 'Phantom Sizes in Store', 'AI Summary', 'Action'].join(',')
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
