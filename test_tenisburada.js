const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

async function main() {
    console.log("🚀 Launching browser...");
    const { browser, page } = await connect({ headless: false, turnstile: true });

    console.log("🌐 Navigating to Tenisburada...");
    await page.goto("https://www.tenisburada.com/nikecourt-air-zoom-vapor-pro-2-toprak-kort-erkek-tenis-ayakkabisi", { waitUntil: "networkidle2", timeout: 60000 });
    
    console.log("⏳ Waiting 15s to let JS render completely...");
    await new Promise(r => setTimeout(r, 15000));

    console.log("🕵️ Searching the whole DOM for elements with text '44' or '44,5'...");
    const result = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        const matches = [];

        elements.forEach(el => {
            if (el.children && el.children.length === 0) { // Only leaf nodes
                const text = el.innerText ? el.innerText.trim() : '';
                if (text === '44' || text === '44,5' || text === '44.5') {
                    // Get a chain of parent tags/classes
                    let parentStr = '';
                    let p = el.parentElement;
                    for (let i=0; i<3 && p; i++) {
                        parentStr = `<${p.tagName.toLowerCase()} class="${p.className}" id="${p.id}"> > ` + parentStr;
                        p = p.parentElement;
                    }

                    matches.push({
                        tag: el.tagName,
                        className: el.className,
                        id: el.id,
                        text: text,
                        parents: parentStr,
                        attributes: Array.from(el.attributes).map(a => `${a.name}="${a.value}"`)
                    });
                }
            }
        });

        // Let's also look for standard global javascript objects again just in case
        const globals = {
            keys: Object.keys(window).filter(k => 
                k.toLowerCase().includes('product') || 
                k.toLowerCase().includes('variant') || 
                k.toLowerCase().includes('stock') ||
                k.toLowerCase().includes('data')
            )
        };

        return { matches, globals };
    });

    fs.writeFileSync('tenisburada_debug2.json', JSON.stringify(result, null, 2));
    console.log("✅ Data extracted and saved to tenisburada_debug2.json");
    await browser.close();
}

main().catch(err => console.error("Error:", err));
