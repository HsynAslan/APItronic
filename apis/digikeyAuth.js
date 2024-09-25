const axios = require('axios');
const qs = require('qs');

let accessToken = ''; // Token'ı hafızada tutuyoruz
let tokenExpiry = null; // Token'ın süresini takip ediyoruz

// Token yenileme fonksiyonu
async function regenerateToken() {
    const tokenUrl = 'https://api.digikey.com/v1/oauth2/token';
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded'
    };
    const body = qs.stringify({
        // J1Dh1xnCwwGApOiC93h3lQKUe97G8Bp2 -> hüseyin
        // lNhPGByVlazXNfWpOD8mYG4kGVkD1cLf -> beyza hanım
        'client_id': 'lNhPGByVlazXNfWpOD8mYG4kGVkD1cLf',
        'client_secret': 'Koh6WLydkyNmq7HM',
        // fJ6PP4jrGdxhdNx0 -> hüso
        // Koh6WLydkyNmq7HM -> beyza hanım
        'grant_type': 'client_credentials'
    });

    try {
        const response = await axios.post(tokenUrl, body, { headers });
        accessToken = response.data.access_token; // Yeni token'ı hafızaya alıyoruz
        tokenExpiry = Date.now() + response.data.expires_in * 1000; // Token süresini belirliyoruz
       
        return accessToken;
    } catch (error) {
        console.error('Token yenileme hatası:', error.response ? error.response.data : error.message);
        throw new Error('Token yenileme başarısız oldu.');
    }
}

// Token kontrol fonksiyonu: Token'ı kontrol eder ve gerekirse yeniler
async function getValidToken() {
    if (accessToken && Date.now() < tokenExpiry) {
        
        return accessToken; // Geçerli token'ı kullan
    } else {
        return await regenerateToken(); // Token süresi dolmuş, yenile
    }
}

// DigiKey API çağrısı
async function callDigiKeyAPI(partNumber, token) {
    const apiUrl = `https://api.digikey.com/products/v4/search/${partNumber}/productdetails`;

    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-DIGIKEY-Client-Id': 'lNhPGByVlazXNfWpOD8mYG4kGVkD1cLf'
            }
        });
        return response.data;
    } catch (error) {
        console.error('DigiKey API çağrısı başarısız2:', error);
        throw error;
    }
}

module.exports = { callDigiKeyAPI, regenerateToken };
