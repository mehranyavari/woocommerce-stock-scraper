#!/usr/bin/env node
/**
 * ==============================================================================
 * 🤖 Gemini AI Product & Supplier Auditor
 * ==============================================================================
 * سیستم حسابرس و مقایسه‌گر هوشمند محصولات فروشگاه با سایت‌های تامین‌کننده
 * قدرت گرفته از هوش مصنوعی Google Gemini (gemini-flash-lite-latest)
 * 
 * نحوه استفاده:
 *   node gemini-auditor.js
 *   node gemini-auditor.js --products=products_tennis24shop_com.json --stock=stock-data_tennis24shop_com.json
 *   node gemini-auditor.js --limit=30 --model=gemini-flash-lite-latest
 *   node gemini-auditor.js --no-ai (فقط مقایسه الگوریتمی بدون مصرف سهمیه هوش مصنوعی)
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
        price_change_significant_percent: 10,
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

// اولویت با متغیر محیطی است
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
                    // تلاش با مدل جایگزین
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
// 🔍 لایه ۱: تحلیل الگوریتمی و مقایسه دقیق
// ==========================================

function performAlgorithmicAudit(products, stockData) {
    console.log('🔍 در حال تحلیل داده‌های محصولات و تامین‌کنندگان...');
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

        const itemAudit = {
            id: product.id,
            primary_url: primaryUrl,
            secondary_url: secondaryUrl,
            domain: domain,
            scrape_success: false,
            regular_price: null,
            offer_price: null,
            has_discount: false,
            discount_percent: 0,
            stocks: {},
            total_stock_count: 0,
            in_stock_sizes: [],
            out_of_stock_sizes: [],
            discrepancies: [],
            severity: 'NORMAL', // CRITICAL, WARNING, INFO, NORMAL
            ai_summary: '',
            recommended_action: ''
        };

        if (!supplierInfo) {
            itemAudit.discrepancies.push({
                type: 'MISSING_IN_SCRAPER_DATA',
                message: 'داده‌ای در فایل خروجی اسکرپر برای این محصول یافت نشد.'
            });
            itemAudit.severity = 'WARNING';
            auditResults.push(itemAudit);
            return;
        }

        if (!supplierInfo.success) {
            itemAudit.scrape_success = false;
            itemAudit.error = supplierInfo.error || 'خطای ناشناخته در اسکرپ';
            itemAudit.discrepancies.push({
                type: 'SCRAPER_ERROR',
                message: `خطای دریافت اطلاعات از تامین‌کننده: ${itemAudit.error}`
            });
            itemAudit.severity = (itemAudit.error.includes('Cloudflare') || itemAudit.error.includes('404')) ? 'WARNING' : 'INFO';
            auditResults.push(itemAudit);
            return;
        }

        itemAudit.scrape_success = true;
        itemAudit.regular_price = supplierInfo.regular_price || null;
        itemAudit.offer_price = supplierInfo.offer_price || null;
        itemAudit.stocks = supplierInfo.stocks || {};

        // بررسی تخفیف
        if (itemAudit.regular_price && itemAudit.offer_price && itemAudit.regular_price > itemAudit.offer_price) {
            itemAudit.has_discount = true;
            itemAudit.discount_percent = Math.round(((itemAudit.regular_price - itemAudit.offer_price) / itemAudit.regular_price) * 100);
            itemAudit.discrepancies.push({
                type: 'ACTIVE_DISCOUNT',
                message: `تخفیف فعال در تامین‌کننده: قیمت از ${itemAudit.regular_price}₺ به ${itemAudit.offer_price}₺ کاهش یافته (-${itemAudit.discount_percent}%)`
            });
        }

        // بررسی سایزها
        const sizeEntries = Object.entries(itemAudit.stocks);
        sizeEntries.forEach(([size, qty]) => {
            const numQty = typeof qty === 'boolean' ? (qty ? 1 : 0) : parseInt(qty) || 0;
            if (numQty > 0) {
                itemAudit.in_stock_sizes.push({ size, qty: numQty });
                itemAudit.total_stock_count += numQty;
            } else {
                itemAudit.out_of_stock_sizes.push(size);
            }
        });

        // سناریوهای وضعیت موجودی
        if (sizeEntries.length > 0 && itemAudit.in_stock_sizes.length === 0) {
            itemAudit.discrepancies.push({
                type: 'ALL_SIZES_OUT_OF_STOCK',
                message: 'تمام سایزهای این محصول در سایت تامین‌کننده ناموجود شده‌اند.'
            });
            itemAudit.severity = 'WARNING';
        } else if (itemAudit.in_stock_sizes.length > 0 && itemAudit.out_of_stock_sizes.length > 0) {
            itemAudit.discrepancies.push({
                type: 'PARTIAL_STOCK',
                message: `موجودی ناقص: سایزهای [${itemAudit.in_stock_sizes.map(s => s.size).join(', ')}] موجود و سایزهای [${itemAudit.out_of_stock_sizes.join(', ')}] ناموجود هستند.`
            });
            itemAudit.severity = itemAudit.severity === 'NORMAL' ? 'INFO' : itemAudit.severity;
        }

        // بررسی موجودی بسیار کم (خطر اتمام ناگهانی)
        const criticalLowSizes = itemAudit.in_stock_sizes.filter(s => s.qty === 1);
        if (criticalLowSizes.length > 0) {
            itemAudit.discrepancies.push({
                type: 'LOW_STOCK_RISK',
                message: `موجودی بحرانی (فقط ۱ عدد باقی‌مانده): سایزهای [${criticalLowSizes.map(s => s.size).join(', ')}]`
            });
            if (itemAudit.severity === 'NORMAL') itemAudit.severity = 'INFO';
        }

        // اگر تخفیف عمیق (>30%) یا خطای مهمی وجود داشت
        if (itemAudit.discount_percent >= 30) {
            itemAudit.severity = 'WARNING';
        }

        auditResults.push(itemAudit);
    });

    return auditResults;
}

// ==========================================
// 🤖 لایه ۲: تحلیل کیفی و هوشمند توسط Gemini
// ==========================================

async function performAIAudit(discrepantItems, modelName) {
    console.log(`\n🤖 شروع تحلیل هوشمند با مدل ${modelName} برای ${discrepantItems.length} محصول منتخب...`);

    const chunks = [];
    const batchSize = CONFIG.rate_limit.batch_size || 10;
    for (let i = 0; i < discrepantItems.length; i += batchSize) {
        chunks.push(discrepantItems.slice(i, i + batchSize));
    }

    let processed = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`  ⏳ پردازش بسته هوش مصنوعی ${i + 1} از ${chunks.length} (${chunk.length} محصول)...`);

        const promptPayload = chunk.map(item => ({
            id: item.id,
            domain: item.domain,
            regular_price: item.regular_price,
            offer_price: item.offer_price,
            discount_percent: item.discount_percent,
            in_stock_sizes: item.in_stock_sizes.map(s => `${s.size} (${s.qty} عدد)`),
            out_of_stock_sizes: item.out_of_stock_sizes,
            discrepancies: item.discrepancies.map(d => d.message),
            scrape_error: item.error || null
        }));

        const prompt = `شما یک کارشناس خبره مدیریت انبار و مانیتورینگ محصولات فروشگاه اینترنتی هستید.
اطلاعات مقایسه محصولات سایت با تامین‌کننده در قالب JSON زیر ارسال شده است.

لطفاً برای هر محصول:
1. "severity": یکی از مقادیر ("CRITICAL", "WARNING", "INFO")
   - CRITICAL: خطر ضرر مالی مستقیم، تخفیف بسیار بالا که در سایت اعمال نشده، یا ناموجودی کل محصول
   - WARNING: فرصت فروش از دست رفته، سایزهای ناموجود شده، خطای بلاک اسکرپر
   - INFO: اطلاع‌رسانی معمولی تغییرات یا موجودی ناقص
2. "ai_summary": تحلیل بسیار خلاصه و روان به زبان فارسی (حداکثر ۱ جمله)
3. "recommended_action": پیشنهاد عملیاتی صریح به مدیر فروشگاه (مثلاً "قیمت لیر را به فلان تغییر دهید" یا "سایزهای X و Y را ناموجود کنید")

فرمت پاسخ فقط و فقط یک JSON معتبر به شکل زیر باشد (بدون هیچ متن اضافی):
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
                    target.ai_summary = aiItem.ai_summary || '';
                    target.recommended_action = aiItem.recommended_action || '';
                }
            });
        } catch (err) {
            console.error(`  ⚠️ خطای دریافت تحلیل هوش مصنوعی برای این بسته: ${err.message}`);
        }

        processed += chunk.length;
        // تاخیر برای رعایت Rate-Limit
        await new Promise(r => setTimeout(r, CONFIG.rate_limit.delay_between_batches_ms || 1500));
    }

    // تولید خلاصه گزارش کلی مدیریتی
    console.log('📝 در حال تدوین گزارش مدیریتی کل فروشگاه توسط Gemini...');
    let executiveSummary = 'گزارش حسابرسی هوشمند آماده شد.';
    try {
        const statsSummary = {
            total_audited: discrepantItems.length,
            critical_count: discrepantItems.filter(d => d.severity === 'CRITICAL').length,
            warning_count: discrepantItems.filter(d => d.severity === 'WARNING').length,
            info_count: discrepantItems.filter(d => d.severity === 'INFO').length,
            discounted_items: discrepantItems.filter(d => d.has_discount).length,
            out_of_stock_items: discrepantItems.filter(d => d.in_stock_sizes.length === 0 && d.scrape_success).length
        };

        const summaryPrompt = `به عنوان مشاور ارشد فروشگاه اینترنتی، بر اساس آمار زیر یک گزارش مدیریتی کوتاه و حرفه‌ای به زبان فارسی در ۲ تا ۳ پاراگراف بنویس.
آمار مانیتورینگ محصولات:
${JSON.stringify(statsSummary, null, 2)}

نقاط قوت، تهدیدات فوری (مانند محصولات ناموجود یا ضرر قیمتی)، و ۳ توصیه اولویت‌دار به مدیر سایت را در گزارش ذکر کن. از ایموجی‌های مناسب استفاده کن.`;

        executiveSummary = await callGemini(summaryPrompt, modelName);
    } catch (e) {
        executiveSummary = 'خلاصه وضعیت: تحلیل کلی انجام شد و مغایرت‌ها در جدول زیر لیست شده‌اند.';
    }

    return executiveSummary;
}

// ==========================================
// 📊 تولید گزارش HTML داشبورد گرافیکی
// ==========================================

function generateHtmlDashboard(auditResults, executiveSummary, outputFile) {
    const total = auditResults.length;
    const criticalCount = auditResults.filter(r => r.severity === 'CRITICAL').length;
    const warningCount = auditResults.filter(r => r.severity === 'WARNING').length;
    const infoCount = auditResults.filter(r => r.severity === 'INFO').length;
    const discountCount = auditResults.filter(r => r.has_discount).length;
    const errorCount = auditResults.filter(r => !r.scrape_success).length;

    const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>داشبورد حسابرسی هوشمند محصولات | AI Product Auditor</title>
    <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --card-border: #334155;
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
        .container { max-width: 1350px; margin: 0 auto; }

        /* هدر */
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; flex-wrap: wrap; gap: 15px; }
        .header h1 { font-size: 24px; font-weight: 800; background: var(--primary-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .header .meta { font-size: 13px; color: var(--text-secondary); }

        /* کارت‌های آماری */
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px; }
        .stat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; display: flex; align-items: center; gap: 15px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); }
        .stat-icon { font-size: 28px; width: 50px; height: 50px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.05); }
        .stat-info .num { font-size: 22px; font-weight: 800; }
        .stat-info .label { font-size: 12px; color: var(--text-secondary); }

        /* خلاصه مدیریتی جمنای */
        .ai-summary-box { background: linear-gradient(135deg, rgba(139,92,246,0.1) 0%, rgba(59,130,246,0.1) 100%); border: 1px solid rgba(139,92,246,0.3); border-radius: 12px; padding: 22px; margin-bottom: 25px; position: relative; }
        .ai-summary-title { font-size: 16px; font-weight: 700; color: #c084fc; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
        .ai-summary-content { font-size: 14px; color: #e2e8f0; white-space: pre-line; line-height: 1.8; }

        /* فیلترها و سرچ */
        .controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 15px; background: var(--card-bg); padding: 15px; border-radius: 10px; border: 1px solid var(--card-border); }
        .filter-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
        .filter-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); color: var(--text-secondary); padding: 7px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; transition: all 0.2s; }
        .filter-btn.active, .filter-btn:hover { background: var(--primary); color: #fff; border-color: var(--primary); }
        .search-input { background: #0f172a; border: 1px solid var(--card-border); color: #fff; padding: 8px 15px; border-radius: 8px; font-size: 13px; width: 260px; outline: none; }
        .search-input:focus { border-color: var(--primary); }

        /* جدول محصولات */
        .table-wrapper { background: var(--card-bg); border-radius: 12px; border: 1px solid var(--card-border); overflow-x: auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); }
        table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: right; }
        th, td { padding: 14px 16px; border-bottom: 1px solid var(--card-border); }
        th { background: #182234; color: var(--text-secondary); font-weight: 600; }
        tr:hover { background: rgba(255,255,255,0.02); }

        /* برچسب‌ها */
        .badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; }
        .badge-critical { background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid rgba(239,68,68,0.4); }
        .badge-warning { background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); }
        .badge-info { background: rgba(59,130,246,0.2); color: #60a5fa; border: 1px solid rgba(59,130,246,0.4); }
        .badge-normal { background: rgba(16,185,129,0.2); color: #34d399; border: 1px solid rgba(16,185,129,0.4); }

        .price-badge { font-weight: bold; }
        .price-offer { color: #f87171; text-decoration: line-through; margin-left: 6px; }
        .price-final { color: #34d399; }
        
        .stock-tag { display: inline-block; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin: 2px; }
        .stock-tag.in { color: #34d399; }
        .stock-tag.out { color: #f87171; opacity: 0.6; }

        .action-box { background: rgba(255,255,255,0.03); border-right: 3px solid var(--primary); padding: 6px 10px; border-radius: 0 6px 6px 0; font-size: 12px; color: #cbd5e1; margin-top: 5px; }

        a.btn-link { color: #818cf8; text-decoration: none; font-size: 12px; }
        a.btn-link:hover { text-decoration: underline; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>🤖 داشبورد حسابرسی هوشمند محصولات با Gemini AI</h1>
            <div class="meta">تحلیل لحظه‌ای مغایرت‌های سایز، قیمت و موجودی فروشگاه با تامین‌کنندگان • تاریخ: ${new Date().toLocaleDateString('fa-IR')}</div>
        </div>
    </div>

    <!-- آمار سریع -->
    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-icon">📦</div>
            <div class="stat-info"><div class="num">${total}</div><div class="label">کل محصولات بررسی شده</div></div>
        </div>
        <div class="stat-card" style="border-color: rgba(239,68,68,0.4);">
            <div class="stat-icon" style="color: var(--critical);">🔴</div>
            <div class="stat-info"><div class="num" style="color: var(--critical);">${criticalCount}</div><div class="label">موارد بحرانی</div></div>
        </div>
        <div class="stat-card" style="border-color: rgba(245,158,11,0.4);">
            <div class="stat-icon" style="color: var(--warning);">🟡</div>
            <div class="stat-info"><div class="num" style="color: var(--warning);">${warningCount}</div><div class="label">هشدارها و فرصت‌ها</div></div>
        </div>
        <div class="stat-card" style="border-color: rgba(59,130,246,0.4);">
            <div class="stat-icon" style="color: var(--info);">🔥</div>
            <div class="stat-info"><div class="num" style="color: var(--info);">${discountCount}</div><div class="label">تخفیف‌های فعال تامین‌کننده</div></div>
        </div>
        <div class="stat-card">
            <div class="stat-icon">⚠️</div>
            <div class="stat-info"><div class="num">${errorCount}</div><div class="label">خطاهای اسکرپ / بلاک</div></div>
        </div>
    </div>

    <!-- خلاصه هوش مصنوعی -->
    <div class="ai-summary-box">
        <div class="ai-summary-title">🧠 گزارش و توصیه مدیریتی هوش مصنوعی Gemini</div>
        <div class="ai-summary-content">${executiveSummary}</div>
    </div>

    <!-- ابزارهای فیلتر -->
    <div class="controls">
        <div class="filter-buttons">
            <button class="filter-btn active" data-filter="ALL">همه (${total})</button>
            <button class="filter-btn" data-filter="CRITICAL">🔴 بحرانی (${criticalCount})</button>
            <button class="filter-btn" data-filter="WARNING">🟡 هشدار (${warningCount})</button>
            <button class="filter-btn" data-filter="DISCOUNT">🔥 تخفیف‌دار (${discountCount})</button>
            <button class="filter-btn" data-filter="ERROR">⚠️ خطاها (${errorCount})</button>
        </div>
        <input type="text" id="searchInput" class="search-input" placeholder="🔍 جستجو بر اساس ID، دامنه یا متن...">
    </div>

    <!-- جدول نتایج -->
    <div class="table-wrapper">
        <table id="auditTable">
            <thead>
                <tr>
                    <th>شناسه (ID)</th>
                    <th>تامین‌کننده</th>
                    <th>سطح فوریت</th>
                    <th>قیمت روز (لیر)</th>
                    <th>وضعیت سایزها</th>
                    <th>تحلیل هوش مصنوعی و راهکار پیشنهادی</th>
                    <th>لینک‌ها</th>
                </tr>
            </thead>
            <tbody>
                ${auditResults.map(item => `
                <tr data-severity="${item.severity}" data-has-discount="${item.has_discount}" data-has-error="${!item.scrape_success}">
                    <td><strong>#${item.id}</strong></td>
                    <td><span style="font-weight:600; color:#cbd5e1;">${item.domain}</span></td>
                    <td>
                        <span class="badge badge-${item.severity.toLowerCase()}">${item.severity}</span>
                    </td>
                    <td>
                        ${item.has_discount 
                            ? `<span class="price-offer">${item.regular_price} ₺</span> <span class="price-final">${item.offer_price} ₺</span> <span style="font-size:11px; color:#f87171;">(-${item.discount_percent}%)</span>`
                            : (item.regular_price ? `<span class="price-final">${item.regular_price} ₺</span>` : '<span style="color:#64748b;">-</span>')
                        }
                    </td>
                    <td>
                        <div style="max-width: 220px;">
                            ${item.in_stock_sizes.map(s => `<span class="stock-tag in">✓ ${s.size} (${s.qty})</span>`).join('')}
                            ${item.out_of_stock_sizes.map(s => `<span class="stock-tag out">✗ ${s}</span>`).join('')}
                            ${item.in_stock_sizes.length === 0 && item.out_of_stock_sizes.length === 0 ? '<span style="color:#64748b; font-size:11px;">نامشخص</span>' : ''}
                        </div>
                    </td>
                    <td>
                        <div style="font-size:12px; color:#f1f5f9; font-weight:600;">${item.ai_summary || item.discrepancies.map(d => d.message).join(' | ')}</div>
                        ${item.recommended_action ? `<div class="action-box">💡 اقدام: ${item.recommended_action}</div>` : ''}
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
    // فیلتر و جستجوی آنی در داشبورد
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
            const hasDiscount = row.getAttribute('data-has-discount') === 'true';
            const hasError = row.getAttribute('data-has-error') === 'true';
            const rowText = row.innerText.toLowerCase();

            let matchesFilter = false;
            if (currentFilter === 'ALL') matchesFilter = true;
            else if (currentFilter === 'CRITICAL' && severity === 'CRITICAL') matchesFilter = true;
            else if (currentFilter === 'WARNING' && severity === 'WARNING') matchesFilter = true;
            else if (currentFilter === 'DISCOUNT' && hasDiscount) matchesFilter = true;
            else if (currentFilter === 'ERROR' && hasError) matchesFilter = true;

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
    console.log(`\n💾 داشبورد گرافیکی ذخیره شد: ${outputFile}`);
}

// ==========================================
// 🚀 اجرای فرآیند اصلی (Main Runner)
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

    // جستجوی خودکار فایل‌ها در صورت عدم وجود
    if (!fs.existsSync(productsFile)) {
        const found = fs.readdirSync('.').find(f => f.startsWith('products_') && f.endsWith('.json')) || 'products.json';
        if (fs.existsSync(found)) productsFile = found;
    }

    if (!fs.existsSync(stockFile)) {
        const found = fs.readdirSync('.').find(f => f.startsWith('stock-data_') && f.endsWith('.json')) || 'stock-data.json';
        if (fs.existsSync(found)) stockFile = found;
    }

    console.log('='.repeat(65));
    console.log('  🤖 Google Gemini AI Product & Supplier Auditor');
    console.log('='.repeat(65));
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

    // مرحله ۱: تحلیل الگوریتمی
    const auditResults = performAlgorithmicAudit(products, stockData);

    // مرحله ۲: تحلیل هوش مصنوعی (برای مواردی که مغایرت دارند)
    let executiveSummary = 'حسابرسی الگوریتمی با موفقیت انجام شد.';
    if (runAI) {
        // انتخاب مواردی که دارای مغایرت، تخفیف، خطا یا ناموجودی هستند
        const discrepantItems = auditResults.filter(r => r.discrepancies.length > 0 || r.has_discount || !r.scrape_success);
        if (discrepantItems.length > 0) {
            executiveSummary = await performAIAudit(discrepantItems.slice(0, 30), modelName);
        } else {
            executiveSummary = '✅ تمام محصولات با تامین‌کننده هماهنگ هستند و مغایرتی مشاهده نشد.';
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
        ['ID', 'Domain', 'Severity', 'Regular Price', 'Offer Price', 'Discount %', 'In-Stock Sizes', 'Out-Of-Stock Sizes', 'AI Summary', 'Action'].join(',')
    ];
    auditResults.forEach(r => {
        csvRows.push([
            r.id,
            `"${r.domain}"`,
            r.severity,
            r.regular_price || '',
            r.offer_price || '',
            r.discount_percent,
            `"${r.in_stock_sizes.map(s => s.size).join(' ')}"`,
            `"${r.out_of_stock_sizes.join(' ')}"`,
            `"${(r.ai_summary || '').replace(/"/g, '""')}"`,
            `"${(r.recommended_action || '').replace(/"/g, '""')}"`
        ].join(','));
    });
    fs.writeFileSync(csvOutput, csvRows.join('\n'), 'utf8');

    generateHtmlDashboard(auditResults, executiveSummary, htmlOutput);

    console.log('\n' + '='.repeat(65));
    console.log('🏁 حسابرسی هوشمند با موفقیت پایان یافت!');
    console.log(`📄 گزارش JSON: ${jsonOutput}`);
    console.log(`📊 گزارش CSV : ${csvOutput}`);
    console.log(`🌐 داشبورد HTML: ${htmlOutput}`);
    console.log('='.repeat(65));
}

main().catch(err => {
    console.error('💥 Fatal Error:', err.message);
    process.exit(1);
});
