const axios = require('axios');

// Mouser API çağrısı
async function callMouserAPI(partNumber) {
    console.log("mouser api yapacak");
    const apiKey = '00274d62-3a13-4b25-b7a0-383f23a48a08'; // API anahtarınızı buraya girin
    const apiUrl = `https://api.mouser.com/api/v1/search/partnumber?apiKey=${apiKey}`;
    
    const requestBody = {
        SearchByPartRequest: {
            mouserPartNumber: partNumber
        }
    };

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Mouser API çağrısı başarısız oldu:', error.response?.data || error.message);
        throw new Error('Mouser API hatası');
    }
    
}

module.exports = { callMouserAPI };
