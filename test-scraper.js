const axios = require('axios');
const fs = require('fs');

const API_KEY = 'YOUR_API_KEY'; // اینجا کلیدت رو بذار
const TARGET = 'https://www.decathlon.com.tr/p/kadin-tenis-ayakkabisi-pembe-tum-zeminler-artengo-fast/_/R-p-333408?mc=8646590';

async function test() {
    console.log('🚀 Testing ScraperAPI...');
    
    try {
        const response = await axios.get('https://api.scraperapi.com', {
            params: {
                api_key: API_KEY,
                url: TARGET,
                render: true,
                country_code: 'tr'
            },
            timeout: 60000
        });

        console.log('✅ Status:', response.status);
        fs.writeFileSync('result.html', response.data);
        console.log('📄 Saved to result.html');
        
        // چک کن __DKT هست یا نه
        if (response.data.includes('__DKT')) {
            console.log('🎉 __DKT FOUND!');
        } else {
            console.log('❌ __DKT not found');
        }
        
    } catch (err) {
        console.error('⚠️ Error:', err.message);
    }
}

test();
