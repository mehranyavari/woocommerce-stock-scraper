const puppeteer = require('puppeteer');
const fs = require('fs');

// لینک محصول برای تست
const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-etegi-beyaz-essentiel-100/_/R-p-305841?mc=8547381&c=BEYAZ";

// --- توابع کمکی (دقیقاً کپی شده از اسکرپر اصلی) ---

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
        if (hostname === 'www.meritspor.com.tr') return numbers[0].replace(',', '.');
        else return numbers[numbers.length - 1].replace(',', '.');
    }
    return trimmed;
}

function parseTurkishPrice(rawPrice) {
    if (!rawPrice) return null;
    let clean = rawPrice.replace(/[^\d,\.]/g, '');
    clean = clean.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(clean);
    if (isNaN(num)) return null;
    return Math.ceil(num);
}

// --- اسکرپت دیباگ ---

async function debug() {
    console.log('🐞 Starting Advanced Debug Scraper...');
    console.log(`🎯 Target: ${TEST_URL}\n`);
    
    // ۱. اضافه شدن پروکسی به تنظیمات مرورگر
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--proxy-server=http://45.145.20.148:3128' // <--- آدرس سرور پروکسی ترکیه
        ]
    });

    const page = await browser.newPage();

    // ۲. وارد کردن یوزرنیم و پسورد پروکسی
    await page.authenticate({
        username: 'mehran',
        password: 'mehran75'
    });

    await page.setExtraHTTPHeaders({
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    // تنظیم منطقه زمانی روی استانبول
    await page.emulateTimezone('Europe/Istanbul');
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        console.log('🚀 Navigating to Decathlon...');
        await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log('⏳ Waiting for Cloudflare to process (12 seconds)...');
        // صبر کردن طولانی‌تر برای عبور از کلودفلر
        await new Promise(r => setTimeout(r, 12000));

        // 1. قیچی کردن مستقیم اطلاعات
        console.log('📥 Extracting __DKT data directly from HTML source...');
        const dktString = await page.evaluate(() => {
            const scriptNode = document.getElementById('__dkt');
            if (scriptNode) {
                const html = scriptNode.innerHTML;
                const match = html.match(/__DKT\s*=\s*(\{[\s\S]*?\});\s*__CONF/);
                return match ? match[1] : null;
            }
            return null;
        });

        if (!dktString) {
            console.error("❌ Critical: '__DKT' text NOT found!");
            console.log("📸 Taking a new screenshot to see if Cloudflare is still there...");
            
            // گرفتن عکس بعد از ۱۲ ثانیه برای دیدن نتیجه
            await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
            
            const html = await page.content();
            fs.writeFileSync('debug_source.html', html);
            
            await browser.close();
            return;
        }
        
        // ... (بقیه کدهای قبلی برای پردازش قیمت و سایز دقیقاً همینجا قرار می‌گیرد) ...
        console.log("✅ Decathlon JSON string extracted successfully!");

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await browser.close();
        console.log('\n🏁 Debugging finished.');
    }
}

debug();
