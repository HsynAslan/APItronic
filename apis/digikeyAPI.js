const axios = require('axios');

async function callDigiKeyAPI(partNumber, token) {
    const apiUrl = `https://api.digikey.com/products/v4/search/${partNumber}/productdetails`;

    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-DIGIKEY-Client-Id': 'lNhPGByVlazXNfWpOD8mYG4kGVkD1cLf',

                'Accept': 'application/json'
            }
        });

        // Gelen yanıtı loglayarak kontrol edelim
        console.log('DigiKey API Yanıtı:', response.data);

        return response.data; // API’den gelen veriyi döndürüyoruz
    } catch (error) {
        console.error(`API çağrısı başarısız oldu: ${partNumber}`, error.message);
        throw new Error(`API çağrısı başarısız oldu: ${partNumber}`);
    }
}

module.exports = { callDigiKeyAPI };
