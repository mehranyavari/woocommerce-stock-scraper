const puppeteer = require('puppeteer');
const fs = require('fs');

async function debug() {
    console.log('🐞 Starting Debug Scraper...');
    
    // لینک مشکل‌دار
    const url = "https://www.meritspor.com.tr/nike-elite-doublewide-2li-tenis-bilekligi";
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // تنظیمات مشابه اسکرپر اصلی
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        console.log(`Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // کمی صبر برای اطمینان از لود
        await new Promise(r => setTimeout(r, 5000));

        // 1. گرفتن اسکرین‌شات (برای دیدن اینکه آیا بلاک شدیم یا صفحه درست است)
        console.log('📸 Taking screenshot...');
        await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });

        // 2. ذخیره کل HTML صفحه
        console.log('📝 Saving HTML source...');
        const html = await page.content();
        fs.writeFileSync('debug_source.html', html);

        // 3. تلاش برای استخراج متغیر مورد نظر بصورت خام
        console.log('🔍 Extracting productDetailModel...');
        const variableContent = await page.evaluate(() => {
            const match = document.body.innerHTML.match(/var productDetailModel = (.*?);/);
            return match ? match[1] : "NOT FOUND";
        });

        fs.writeFileSync('debug_variable.json', variableContent);
        
        if (variableContent === "NOT FOUND") {
            console.error("❌ Variable 'productDetailModel' was NOT found in HTML.");
        } else {
            console.log("✅ Variable found and saved to debug_variable.json");
            
            // تست پارس کردن JSON برای دیدن ارور احتمالی
            try {
                JSON.parse(variableContent);
                console.log("✅ JSON is valid.");
            } catch (e) {
                console.error("❌ JSON parse error:", e.message);
            }
        }

    } catch (error) {
        console.error('❌ Error during debug:', error);
    } finally {
        await browser.close();
    }
}

debug();
