const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

async function main() {
    console.log("🚀 Launching browser...");
    const { browser, page } = await connect({
        headless: false,
        turnstile: true
    });

    console.log("🌐 Navigating to Tenisburada...");
    await page.goto("https://www.tenisburada.com/nikecourt-air-zoom-vapor-pro-2-toprak-kort-erkek-tenis-ayakkabisi", { waitUntil: "domcontentloaded", timeout: 60000 });
    
    console.log("⏳ Waiting 15s to let Cloudflare pass & JS load...");
    await new Promise(r => setTimeout(r, 15000));

    console.log("🕵️ Extracting page data...");
    const result = await page.evaluate(() => {
        const data = {};
        
        try { data.window_sub_products = typeof sub_products !== 'undefined' ? sub_products : null; } catch(e){}
        try { data.window_PRODUCT_DATA = typeof PRODUCT_DATA !== 'undefined' ? PRODUCT_DATA : null; } catch(e){}
        try { data.window_DATA = typeof DATA !== 'undefined' ? DATA : null; } catch(e){}
        
        // Find DOM variant elements
        const variantLinks = Array.from(document.querySelectorAll('a[data-id], .variant a, .size a, .beden a')).map(a => ({
            id: a.getAttribute('data-id'),
            text: a.innerText.trim(),
            className: a.className
        }));
        
        data.variantLinks = variantLinks;
        
        // Find T-soft specific select boxes
        const selects = Array.from(document.querySelectorAll('select')).map(s => ({
            id: s.id,
            options: Array.from(s.options).map(o => ({text: o.text, value: o.value}))
        }));
        data.selects = selects;

        return data;
    });

    fs.writeFileSync('tenisburada_debug.json', JSON.stringify(result, null, 2));
    console.log("✅ Data extracted and saved to tenisburada_debug.json");
    await browser.close();
}

main().catch(err => console.error("Error:", err));
