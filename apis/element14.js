const axios = require('axios');

async function callFarnellAPI(partNumber) {
    const apiUrl = `https://api.element14.com/catalog/products`; // Farnell API URL
    const apiKey = 'wp2zndpspfju9c9cd2z5ax6s'; // API Anahtarınızı buraya ekleyin

    try {
        // console.log("try içine girdi bao");
        // Sorgu parametreleri ile URL'yi oluşturuyoruz
        const response = await axios.get(apiUrl, {
            params: {
                term: partNumber, // Aranan parça numarası
                'storeInfo.id': 'bg.farnell.com', // Mağaza bilgisi
                'resultsSettings.responseGroup': 'small', // Yanıt detay seviyesi
                'callInfo.responseDataFormat': 'json', // Yanıt formatı JSON
                'callInfo.apiKey': apiKey // API Anahtarı
            },
            headers: {
                'Accept': 'application/json'
            }
            
        });

        // Gelen yanıtı loglayarak kontrol edelim
        // console.log('Farnell API Yanıtı:', response.data);

        return response.data; // API’den gelen veriyi döndürüyoruz
    } catch (error) {
        // console.error(`API çağrısı başarısız oldu: ${partNumber}`, error.message);
        // console.log("error: "+error);
        throw new Error(`Farnell API çağrısı başarısız oldu: ${partNumber}`);
    }
}

module.exports = { callFarnellAPI };

