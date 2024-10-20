const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../config/db');
const nodemailer = require('nodemailer');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { loadExcel, findPartNumberColumn ,filterPartNumbersAndQuantities } = require('../routes/excelParser'); // Excel işlemleri için ekledik
const { getPartDetails } = require('../apis/digikeyAPI'); // DigiKey API çağrısı
const { callDigiKeyAPI, regenerateToken } = require('../apis/digikeyAuth'); // regenerateToken ve callDigiKeyAPI fonksiyonlarını içe aktarıyoruz
const axios = require('axios');
const { callMouserAPI } = require('../apis/mouserAPI'); // Mouser API'yi ekledik
const { getArrowProductData } = require('../apis/arrowApi');
const bodyParser = require('body-parser');
router.use(bodyParser.json());
router.use(express.json()); // JSON verileri alabilmek için gerekli middleware
const { callFarnellAPI } = require('../apis/element14'); // Element14 API'yi içe aktar
const cron = require('node-cron');
// Yükleme klasörünü kontrol et ve yoksa oluştur
let accessToken = null; // Token'ı bellekte tutuyoruz
let tokenExpiry = null; // Token'ın süresini takip ediyoruz

async function getToken() {
    const currentTime = Date.now();

    // token var ve süresi dolmamış
    if (accessToken && tokenExpiry && currentTime < tokenExpiry) {
        
        return accessToken;
    } else {
        // Token yok veya süresi dolmuş ---> yeni token üret
        console.log('Yeni token üretiliyor...');
        accessToken = await regenerateToken(); // Token alındı
        tokenExpiry = currentTime + (10 * 60 * 1000); // 10 dk da 1 yenile
        return accessToken;
    }
}
// Bellekte geçici olarak dosya tutmak için kullanılır
const storage2 = multer.memoryStorage(); 
const upload2 = multer({ storage: storage2 });

// Bireysel mesaj gönderme (medya dosyası dahil)
router.post('/messages/send', upload2.single('media'), (req, res) => {
    const { senderId, recipientEmail, messageText, messageType } = req.body;
    const media = req.file;

    let mediaData = null;
    if (media) {
        mediaData = media.buffer.toString('base64');  // Medya dosyasını Base64 formatına dönüştürme
    }

    // Alıcı ID'sini bul
    db.query('SELECT id FROM users WHERE email = ?', [recipientEmail], (err, results) => {
        if (err || results.length === 0) {
            return res.status(500).json({ error: 'Recipient not found' });
        }

        const recipientId = results[0].id;

        // Mesajı veritabanına ekle
        db.query(`
            INSERT INTO messages (sender_id, recipient_id, message_text, message_type, media_url)
            VALUES (?, ?, ?, ?, ?)`, 
            [senderId, recipientId, messageText, media ? 'media' : 'text', mediaData], (err, result) => {
                if (err) {
                    console.error('Mesaj gönderilirken hata oluştu:', err);
                    return res.status(500).json({ error: 'Mesaj gönderilemedi' });
                }
                res.json({ message: 'Mesaj başarıyla gönderildi' });
            });
    });
});

// Token yenileme endpoint'i
router.get('/generate-token', async (req, res) => {
    try {
        const token = await regenerateToken(); // Token yenileme fonksiyonunu çağırıyoruz
        console.log("Yeni Token Üretildi:", token);  // Token'ı backend console'da logla
        res.json({ token });
    } catch (error) {
        console.error('Token yenileme hatası:', error.message);
        res.status(500).json({ error: 'Token yenileme başarısız oldu.' });
    }
});

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
router.get('/api/digikey/partdetails/:partNumber', async (req, res) => {
    const partNumber = req.params.partNumber;
    try {
        const token = await getToken(); // Mevcut token'ı al veya yenile
        const result = await callDigiKeyAPI(partNumber, token); // API'yi çağır ve token'ı kullan
        res.json(result);
    } catch (error) {
        console.error('DigiKey API çağrısı başarısız3:');
        res.status(500).json({ error: 'DigiKey API hatası' });
    }
});



// Dosya yükleme ayarları
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage }); // Yükleme fonksiyonunu burada tanımlıyoruz

// Nodemailer ayarları
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'apitronic06@gmail.com', // Sabit e-posta adresi (gönderici)
        pass: 'ivax fqrd gdiu jioz'  // 16 haneli uygulama şifresi
    }
});

// Deneme hakları ve engelleme kontrolü için ek tablo: failed_attempts
const FAILED_ATTEMPTS_LIMIT = 3;
const BLOCK_DURATION = 10 * 60 * 1000; // 10 dakika

// Yeni bir kullanıcı kaydettikten sonra e-posta göndermek için fonksiyon
function sendVerificationEmail(toEmail, verificationCode) {
    const mailOptions = {
        from: 'apitronic06@gmail.com',
        to: toEmail,
        subject: 'APItronic Hesap Doğrulama',
        text: `Hesabınızı doğrulamak için lütfen şu kodu kullanın: ${verificationCode}`
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.log(error);
        } else {
            console.log('E-posta gönderildi: ' + info.response);
        }
    });
}


router.get('/get-part-details/:fileId', async (req, res) => {
    const fileId = req.params.fileId;

    // Veritabanından BOM dosyasını çekiyoruz
    db.query('SELECT file_content FROM bom_files WHERE id = ?', [fileId], async (err, results) => {
        if (err || results.length === 0) {
            console.error('Dosya bulunamadı:', err);
            return res.status(404).json({ message: 'Dosya bulunamadı.' });
        }

        const fileBuffer = Buffer.from(results[0].file_content); // Excel dosyasını yükle
        const excelData = loadExcel(fileBuffer); // Excel dosyasını JSON formatına çeviriyoruz
        const partDetailsFromExcel = filterPartNumbersAndQuantities(excelData); // Part numaralarını ve quantity bilgilerini alıyoruz

        try {
            const token = await getToken(); // Token bir kez alınıyor

            // DigiKey API sonuçlarını al
            const digikeyResults = await Promise.all(partDetailsFromExcel.map(async (partDetail) => {
                try {
                    const result = await callDigiKeyAPI(partDetail.partNumber, token); // Token'ı burada kullanıyoruz
                    return {
                        partNumber: partDetail.partNumber,
                        manufacturer: result?.Product?.Manufacturer?.Value || 'N/A',
                        unitPrice: result?.Product?.UnitPrice || 'N/A',
                        stock: result?.Product?.QuantityAvailable || 'N/A',
                        totalPrice: (result?.Product?.UnitPrice * partDetail.quantity).toFixed(2) || 'N/A',
                        quantity: partDetail.quantity || 'Bilinmiyor',  // Quantity (Adet) bilgisi
                        recommendedSupplier: 'DigiKey'
                    };
                } catch (error) {
                    console.error(`DigiKey API çağrısı başarısız oldu: ${partDetail.partNumber}`, error.message);
                    return {
                        partNumber: partDetail.partNumber,
                        manufacturer: 'N/A',
                        unitPrice: 'N/A',
                        stock: 'N/A',
                        totalPrice: 'N/A',
                        quantity: partDetail.quantity || 'Bilinmiyor', // Hata durumunda quantity bilgisi
                        recommendedSupplier: 'DigiKey'
                    };
                }
            }));

            // Part detaylarını JSON olarak frontend'e gönder
            res.json({
                partDetails: digikeyResults
            });
        } catch (error) {
            console.error('Token alma veya DigiKey API çağrısında bir hata oluştu:', error.message);
            res.status(500).json({ message: 'DigiKey API sorgusu sırasında bir hata oluştu.' });
        }
    });
});

// POST isteği ile bom_count ve total_price güncelleme
router.post('/saveBomCount', (req, res) => {
    const { bomCount, totalPrice, fileId } = req.body; // formdan gelen değerler
    console.log("bomCount: "+bomCount);
    console.log("totalPrice: "+totalPrice);
    console.log("fileId: "+fileId);
    // Veritabanında bom_count ve total_price güncelleniyor
    db.query(
        'UPDATE bom_files SET bom_count = ?, total_price = ? WHERE id = ?', // Tek id parametresi kullanıyoruz
        [bomCount, totalPrice, fileId], // Üç değer sırayla sorguya ekleniyor
        (err, result) => {
            if (err) {
                console.error('BOM dosyası güncellenirken hata oluştu:', err);
                return res.status(500).send('Veritabanı hatası.');
            }

            // Güncelleme başarılı olduğunda dashboard2 sayfasına yönlendir
            res.redirect(`/dashboard2/${fileId}`);
        }
    );
});

// function updateNextUpdateDate(bomFile) {
//     const fileId = bomFile.id;
//     const updateInterval = bomFile.update_interval;
//     let nextUpdate;

//     // last_updated alanını kullan
//     const lastUpdated = new Date(bomFile.last_updated);

//     switch (updateInterval) {
//         case 'daily':
//             nextUpdate = new Date(lastUpdated.setDate(lastUpdated.getDate() + 1)); // Günlük
//             break;
//         case 'weekly':
//             nextUpdate = new Date(lastUpdated.setDate(lastUpdated.getDate() + 7)); // Haftalık
//             break;
//         case 'monthly':
//             nextUpdate = new Date(lastUpdated.setMonth(lastUpdated.getMonth() + 1)); // Aylık
//             break;
//         default:
//             nextUpdate = lastUpdated;
//     }

//     db.query(`UPDATE bom_files SET next_update = ? WHERE id = ?`, [nextUpdate, fileId], (err) => {
//         if (err) {
//             console.error('next_update güncellemesi başarısız:', err);
//         } else {
//             console.log(`BOM dosyası ${fileId} için next_update ${nextUpdate} olarak güncellendi.`);
//         }
//     });
// }

function updateBomFileAndParts(bomFile, digikeyResults, mouserResults, parts) {
    let totalPrice = 0;
    let maxLeadTime = 0; // En yüksek lead time'ı bulmak için başlangıçta 0

    console.log("BOM Dosyası Bilgisi:", bomFile);
    console.log("BOM Count:", bomFile.bom_count);
    console.log("Parçalar:", parts.length, "adet parça var.");

    parts.forEach((part, index) => {
        const digikey = digikeyResults[index];
        const mouser = mouserResults[index];
        const selectedResult = selectBestSupplier(digikey, mouser);

        console.log(`Parça ${index + 1}: ${part.part_number}`);
        console.log("Seçilen Sonuç:", selectedResult);

        if (selectedResult) {
            let partPrice = parseFloat(selectedResult.unitPrice);
            console.log("Unit Price:", selectedResult.unitPrice, "Parsed Unit Price:", partPrice);

            if (isNaN(partPrice)) {
                partPrice = 0;
            }

            partPrice *= part.quantity;
            console.log("Miktar:", part.quantity, "Parça Fiyatı:", partPrice);

            totalPrice += partPrice;
            console.log("Toplam Fiyat Güncellemesi:", totalPrice);

            let leadTime = parseInt(selectedResult.leadTime);
            console.log("Lead Time:", selectedResult.leadTime, "Parsed Lead Time:", leadTime);

            if (!isNaN(leadTime) && leadTime > 0) {
                maxLeadTime = Math.max(maxLeadTime, leadTime); // En yüksek lead time'ı bulmak için max kullanıyoruz
            }

            console.log("Güncellenen Max Lead Time:", maxLeadTime);
        }

        updatePartInDatabase(bomFile.id, part.part_number, selectedResult, part.quantity);
    });

    const finalTotalPrice = (totalPrice * bomFile.bom_count).toFixed(4);
    console.log("Final Toplam Fiyat (bom_count ile çarpıldı):", finalTotalPrice);
    console.log("Final Max Lead Time Sonucu:", maxLeadTime);
    console.log("BOM Count:", bomFile.bom_count);

    updateBomFile(bomFile, parseFloat(finalTotalPrice), maxLeadTime, bomFile.bom_count);
}

function updateStartTimeIfNeeded(bomFile) {
    const fileId = bomFile.id;
    if (!bomFile.start_time) {  // Eğer start_time null ise
        const currentTime = new Date();
        db.query(`UPDATE bom_files SET start_time = ? WHERE id = ?`, [currentTime, fileId], (err) => {
            if (err) {
                console.error('start_time güncellenirken hata oluştu:', err);
            } else {
                console.log(`BOM dosyası ${fileId} için start_time başarıyla güncellendi: ${currentTime}`);
            }
        });
    }
}


// DigiKey API sonuçlarını almak için fonksiyon
async function getDigiKeyResults(partDetails, token) {
    console.log('getDigiKeyResults fonksiyonu çalıştırılıyor...');
    return await Promise.all(partDetails.map(async (partDetail) => {
        try {
            console.log(`DigiKey API çağrısı yapılıyor: Part Number: ${partDetail.part_number}`);
            const result = await callDigiKeyAPI(partDetail.part_number, token);
            // console.log(`DigiKey API sonucu: ${JSON.stringify(result)}`);
            const digikeyLeadTimeDays = parseInt(result?.Product?.ManufacturerLeadWeeks || 0) * 7;

            return {
                partNumber: partDetail.part_number,
                manufacturer: result?.Product?.Manufacturer?.Name || 'N/A',
                unitPrice: result?.Product?.UnitPrice || 'N/A',
                stock: result?.Product?.QuantityAvailable || 'N/A',
                totalPrice: (result?.Product?.UnitPrice * partDetail.quantity).toFixed(2) || 'N/A',
                quantity: partDetail.quantity || 'Bilinmiyor',
                leadTime: digikeyLeadTimeDays,
                supplier: 'DigiKey'
            };
        } catch (error) {
            console.error(`DigiKey API çağrısı başarısız oldu: ${partDetail.part_number}`, error.message);
            return {
                partNumber: partDetail.part_number,
                manufacturer: 'N/A',
                unitPrice: 'N/A',
                stock: 'N/A',
                totalPrice: 'N/A',
                quantity: partDetail.quantity || 'Bilinmiyor',
                leadTime: 'N/A',
                supplier: 'DigiKey'
            };
        }
    }));
}

// Mouser API sonuçlarını almak için fonksiyon
async function getMouserResults(partDetails) {
    console.log('getMouserResults fonksiyonu çalıştırılıyor...');
    return await Promise.all(partDetails.map(async (partDetail) => {
        try {
            console.log(`Mouser API çağrısı yapılıyor: Part Number: ${partDetail.part_number}`);
            const result = await callMouserAPI(partDetail.part_number);
            // console.log(`Mouser API sonucu: ${JSON.stringify(result)}`);
            const mouserStockRaw = result?.SearchResults?.Parts[0]?.Availability || 'N/A';
            const mouserStock = parseInt(mouserStockRaw.replace(' In Stock', ''), 10);
            const priceBreaks = result?.SearchResults?.Parts[0]?.PriceBreaks || [];

            let mouserPrice = 'N/A';
            const quantity = partDetail.quantity || 1;

            if (priceBreaks.length > 0) {
                for (let i = 0; i < priceBreaks.length; i++) {
                    if (quantity >= priceBreaks[i].Quantity) {
                        mouserPrice = priceBreaks[i].Price.replace('$', '');
                    } else {
                        break;
                    }
                }
            }

            const mouserLeadTimeDays = parseInt(result?.SearchResults?.Parts[0]?.LeadTime || 0);
            const totalPrice = (parseFloat(mouserPrice) * quantity).toFixed(2);

            return {
                partNumber: partDetail.part_number,
                manufacturer: result?.SearchResults?.Parts[0]?.Manufacturer || 'N/A',
                unitPrice: mouserPrice,
                stock: mouserStock,
                totalPrice: !isNaN(totalPrice) ? totalPrice : 'N/A',
                quantity: quantity,
                leadTime: mouserLeadTimeDays,
                supplier: 'Mouser'
            };
        } catch (error) {
            console.error(`Mouser API çağrısı başarısız oldu: ${partDetail.part_number}`, error.message);
            return {
                partNumber: partDetail.part_number,
                manufacturer: 'N/A',
                unitPrice: 'N/A',
                stock: 'N/A',
                totalPrice: 'N/A',
                quantity: partDetail.quantity || 'Bilinmiyor',
                leadTime: 'N/A',
                supplier: 'Mouser'
            };
        }
    }));
}

function calculateNextUpdate(lastUpdated, bomFile) {
    let nextUpdate = new Date(lastUpdated); // last_updated zamanını kullan

    // Güncelleme aralığına göre next_update'i ayarlayalım
    switch (bomFile.update_interval) {
        case 'minute':
            nextUpdate.setMinutes(nextUpdate.getMinutes() + 1); // last_updated zamanına 1 dakika ekle
            break;
        case 'hour':
            nextUpdate.setHours(nextUpdate.getHours() + 1); // last_updated zamanına 1 saat ekle
            break;
        case 'day':
        case 'daily': // 'daily' ve 'day' işleniyor
            nextUpdate.setDate(nextUpdate.getDate() + 1); // last_updated zamanına 1 gün ekle
            break;
        case 'week':
        case 'weekly': // 'weekly' ve 'week' işleniyor
            nextUpdate.setDate(nextUpdate.getDate() + 7); // last_updated zamanına 1 hafta ekle
            break;
        case 'month':
        case 'monthly': // 'monthly' ve 'month' işleniyor
            nextUpdate.setMonth(nextUpdate.getMonth() + 1); // last_updated zamanına 1 ay ekle
            break;
        default:
            console.warn(`Bilinmeyen update_interval: ${bomFile.update_interval}. Varsayılan olarak 1 dakika ekleniyor.`);
            nextUpdate.setMinutes(nextUpdate.getMinutes() + 1); // Varsayılan olarak 1 dakika ekle
            break;
    }

    return nextUpdate;
}


function updateNextUpdateField(bomFile, lastUpdated) {
    const nextUpdate = calculateNextUpdate(lastUpdated, bomFile);
    const fileId = bomFile.id;

    db.query(`
        UPDATE bom_files 
        SET next_update = ? 
        WHERE id = ?`,
        [nextUpdate, fileId],
        (err) => {
            if (err) {
                console.error('next_update alanı güncellenirken hata oluştu:', err);
            } else {
                console.log(`BOM dosyası ${fileId} için next_update başarıyla güncellendi: ${nextUpdate}`);
            }
        }
    );
}



function selectBestSupplier(digikey, mouser) {
    console.log('selectBestSupplier fonksiyonu çalıştırılıyor...');
    let selectedResult = null;

    if (digikey && mouser) {
        if (digikey.leadTime === mouser.leadTime) {
            if (parseFloat(mouser.unitPrice) < parseFloat(digikey.unitPrice)) {
                selectedResult = mouser;
            } else {
                selectedResult = digikey;
            }
        } else if (mouser.leadTime < digikey.leadTime) {
            selectedResult = mouser;
        } else {
            selectedResult = digikey;
        }
    } else if (mouser) {
        selectedResult = mouser;
    } else if (digikey) {
        selectedResult = digikey;
    }

    console.log(`Seçilen tedarikçi: ${selectedResult ? selectedResult.supplier : 'Hiçbiri'}`);
    return selectedResult;
}

function updatePartInDatabase(fileId, partNumber, selectedResult, bomCount) {
    console.log(`updatePartInDatabase fonksiyonu çalıştırılıyor: Part Number: ${partNumber}`);
    const { unitPrice, leadTime, supplier } = selectedResult;

    const safeLeadTime = isNaN(leadTime) || leadTime === 'N/A' ? 0 : leadTime;
    const safeUnitPrice = isNaN(unitPrice) || unitPrice === 'N/A' ? 0 : parseFloat(unitPrice).toFixed(2);

    db.query('SELECT * FROM bom_parts WHERE bom_id = ? AND part_number = ?', [fileId, partNumber], (err, results) => {
        if (err) {
            console.error('Veritabanı sorgusu sırasında hata oluştu:', err);
            return;
        }

        let query, params;

        if (results.length > 0) {
            console.log('Parça veritabanında mevcut, güncelleme yapılıyor...');

            const dateFields = [
                { priceSlot: 'price_1', leadTimeSlot: 'lead_time_1', dateSlot: 'price_1_date', date: results[0].price_1_date },
                { priceSlot: 'price_2', leadTimeSlot: 'lead_time_2', dateSlot: 'price_2_date', date: results[0].price_2_date },
                { priceSlot: 'price_3', leadTimeSlot: 'lead_time_3', dateSlot: 'price_3_date', date: results[0].price_3_date },
                { priceSlot: 'price_4', leadTimeSlot: 'lead_time_4', dateSlot: 'price_4_date', date: results[0].price_4_date },
                { priceSlot: 'price_5', leadTimeSlot: 'lead_time_5', dateSlot: 'price_5_date', date: results[0].price_5_date }
            ];

            dateFields.forEach(field => {
                if (!field.date) {
                    field.date = new Date(0);  // Eğer tarih null ise, eski bir tarih olarak kabul ediyoruz
                }
            });

            dateFields.sort((a, b) => new Date(a.date) - new Date(b.date)); // En eski tarihli olanı bul
            const oldestField = dateFields[0];  // En eski tarihli olanı seç

            query = `
                UPDATE bom_parts 
                SET ${oldestField.priceSlot} = ?, ${oldestField.leadTimeSlot} = ?, supplier = ?, ${oldestField.dateSlot} = NOW()
                WHERE bom_id = ? AND part_number = ?
            `;
            params = [safeUnitPrice, safeLeadTime, supplier, fileId, partNumber];

        } else {
            console.log('Parça veritabanında mevcut değil, ekleniyor...');

            query = `
                INSERT INTO bom_parts (bom_id, part_number, price_1, lead_time_1, supplier, price_1_date, lead_time_1_date) 
                VALUES (?, ?, ?, ?, ?, NOW(), NOW())
            `;
            params = [fileId, partNumber, safeUnitPrice, safeLeadTime, supplier];
        }

        db.query(query, params, (err) => {
            if (err) {
                console.error('Parça bilgisi veritabanına kaydedilemedi:', err);
            } else {
                console.log(`Parça ${partNumber} başarıyla güncellendi/veritabanına eklendi.`);
            }
        });
    });
}


function updateBomFile(bomFile, totalPrice, maxLeadTime, bomCount) {
    const fileId = bomFile.id;
    const safeTotalPrice = isNaN(totalPrice) ? 0 : (totalPrice / bomCount).toFixed(4);
    const safeMaxLeadTime = isNaN(maxLeadTime) ? 0 : maxLeadTime;

    db.query(`
        SELECT bom_price_1_date, bom_price_2_date, bom_price_3_date, bom_price_4_date, bom_price_5_date
        FROM bom_files WHERE id = ?`, [fileId], (err, result) => {
        if (err) {
            console.error('Veritabanı sorgusu başarısız:', err);
            return;
        }

        const dateFields = [
            { priceSlot: 'bom_price_1', leadTimeSlot: 'bom_lead_time_1', dateSlot: 'bom_price_1_date', date: result[0].bom_price_1_date },
            { priceSlot: 'bom_price_2', leadTimeSlot: 'bom_lead_time_2', dateSlot: 'bom_price_2_date', date: result[0].bom_price_2_date },
            { priceSlot: 'bom_price_3', leadTimeSlot: 'bom_lead_time_3', dateSlot: 'bom_price_3_date', date: result[0].bom_price_3_date },
            { priceSlot: 'bom_price_4', leadTimeSlot: 'bom_lead_time_4', dateSlot: 'bom_price_4_date', date: result[0].bom_price_4_date },
            { priceSlot: 'bom_price_5', leadTimeSlot: 'bom_lead_time_5', dateSlot: 'bom_price_5_date', date: result[0].bom_price_5_date }
        ];

        dateFields.forEach(field => {
            if (!field.date) {
                field.date = new Date(0);  // Eğer tarih null ise, eski bir tarih olarak kabul ediyoruz
            }
        });

        // Tarihler arasında en eskisini bul ve ona güncelleme yap
        dateFields.sort((a, b) => new Date(a.date) - new Date(b.date));
        const oldestField = dateFields[0];

        db.query(`
            UPDATE bom_files 
            SET total_price = ?, min_lead_time = ?, ${oldestField.priceSlot} = ?, ${oldestField.leadTimeSlot} = ?, ${oldestField.dateSlot} = NOW(), last_updated = NOW()
            WHERE id = ?`,
            [safeTotalPrice, safeMaxLeadTime, safeTotalPrice, safeMaxLeadTime, fileId],
            (updateErr) => {
                if (updateErr) {
                    console.error('Veritabanı güncellemesi başarısız:', updateErr);
                } else {
                    console.log(`BOM dosyası ${fileId} başarıyla güncellendi.`);
                    
                    // Güncelleme sonrasında next_update'i hesapla
                    updateNextUpdateField(bomFile, new Date());
                }
            }
        );
    });
}


function checkForUpdates() {
    console.log('checkForUpdates fonksiyonu çalıştırılıyor...');
    const now = new Date();
    db.query('SELECT * FROM bom_files WHERE next_update <= ?', [now], (err, bomFiles) => {
        if (err) {
            console.error('Veritabanı sorgusu başarısız:', err);
            return;
        }

        bomFiles.forEach(bomFile => {
            if (bomFile.update_disabled) {
                console.log(`BOM dosyası ${bomFile.id} için güncellemeler devre dışı bırakıldı.`);
                return;  // Güncellemeler devre dışı bırakıldıysa devam etmiyoruz
            }

            console.log(`Güncellenmesi gereken BOM dosyası: ${bomFile.id}`);
            updateBom(bomFile);  // BOM dosyasını güncelle
        });
    });
}

async function updateBom(bomFile) {
    console.log(`updateBom fonksiyonu çalıştırılıyor: BOM ID: ${bomFile.id}`);
    const fileId = bomFile.id;

    db.query('SELECT * FROM bom_parts WHERE bom_id = ?', [fileId], async (err, parts) => {
        if (err || parts.length === 0) {
            console.error('BOM dosyasına ait ürünler bulunamadı.');
            return;
        }

        console.log(`BOM dosyasına ait parçalar alındı: ${parts.length} adet parça var.`);

        const token = await getToken();  // Token'i al
        console.log('Yeni token alındı.');

        const digikeyResults = await getDigiKeyResults(parts, token);
        console.log('DigiKey sonuçları alındı.');

        const mouserResults = await getMouserResults(parts);
        console.log('Mouser sonuçları alındı.');

        updateBomFileAndParts(bomFile, digikeyResults, mouserResults, parts);
    });
}


router.get('/risk-management', (req, res) => {
    const userId = req.session.user.id;

    //  BOM dosyalarını getirdik
    db.query('SELECT * FROM bom_files WHERE user_id = ?', [userId], (err, bomFiles) => {
        if (err) {
            console.error('BOM dosyaları alınırken hata:', err);
            return res.status(500).send('Veritabanı hatası');
        }

        res.render('risk_management', {
            bomFiles,
            bomParts: []  
        });
    });
});

router.get('/risk-management/:bomId', (req, res) => {
    const bomId = req.params.bomId;

    // Öncelikle bom_files tablosundaki bilgileri çekiyoruz
    db.query('SELECT * FROM bom_files WHERE id = ?', [bomId], (err, bomFile) => {
        if (err || bomFile.length === 0) {
            console.error('BOM dosyası çekilirken hata oluştu:', err);
            return res.status(500).send('Veritabanı hatası');
        }

        // Seçilen BOM dosyasına ait parçaları çekiyoruz
        db.query('SELECT * FROM bom_parts WHERE bom_id = ?', [bomId], (err, bomParts) => {
            if (err) {
                console.error('BOM parçaları çekilirken hata oluştu:', err);
                return res.status(500).send('Veritabanı hatası');
            }

            // BOM dosyasına ait fiyat ve lead time bilgilerini frontend'e göndermek üzere hazırlıyoruz
            const bomFileData = {
                totalPrice: [
                    bomFile[0].bom_price_1,
                    bomFile[0].bom_price_2,
                    bomFile[0].bom_price_3,
                    bomFile[0].bom_price_4,
                    bomFile[0].bom_price_5
                ],
                leadTimes: [
                    bomFile[0].bom_lead_time_1,
                    bomFile[0].bom_lead_time_2,
                    bomFile[0].bom_lead_time_3,
                    bomFile[0].bom_lead_time_4,
                    bomFile[0].bom_lead_time_5
                ],
                priceDates: [
                    bomFile[0].bom_price_1_date,
                    bomFile[0].bom_price_2_date,
                    bomFile[0].bom_price_3_date,
                    bomFile[0].bom_price_4_date,
                    bomFile[0].bom_price_5_date
                ]
            };

            // Parçalarla ilgili tüm geçmiş fiyat ve lead time bilgileri ile risk hesaplamaları
            const parts = bomParts.map(part => {
                const price_1 = parseFloat(part.price_1) || 0;
                const price_2 = parseFloat(part.price_2) || 0;
                const price_3 = parseFloat(part.price_3) || 0;
                const price_4 = parseFloat(part.price_4) || 0;
                const price_5 = parseFloat(part.price_5) || 0;

                const lead_time_1 = parseInt(part.lead_time_1) || 0;
                const lead_time_2 = parseInt(part.lead_time_2) || 0;
                const lead_time_3 = parseInt(part.lead_time_3) || 0;
                const lead_time_4 = parseInt(part.lead_time_4) || 0;
                const lead_time_5 = parseInt(part.lead_time_5) || 0;

                // En düşük fiyatı ve tarihini bulma
                const lowest_price = Math.min(price_1, price_2, price_3, price_4, price_5);
                const lowest_price_date = part[`price_${[1, 2, 3, 4, 5].find(i => parseFloat(part[`price_${i}`]) === lowest_price)}_date`];

                return {
                    part_number: part.part_number,
                    price_1,
                    price_2,
                    price_3,
                    price_4,
                    price_5,
                    price_1_date: part.price_1_date,
                    price_2_date: part.price_2_date,
                    price_3_date: part.price_3_date,
                    price_4_date: part.price_4_date,
                    price_5_date: part.price_5_date,
                    lead_time_1,
                    lead_time_2,
                    lead_time_3,
                    lead_time_4,
                    lead_time_5,
                    lead_time_1_date: part.lead_time_1_date,
                    lead_time_2_date: part.lead_time_2_date,
                    lead_time_3_date: part.lead_time_3_date,
                    lead_time_4_date: part.lead_time_4_date,
                    lead_time_5_date: part.lead_time_5_date,
                    lowest_price,
                    lowest_price_date,
                    supplier: part.supplier
                };
            });

            // Hem bom_files hem de bom_parts bilgilerini frontend'e JSON formatında gönderiyoruz
            res.json({ bomFileData, parts });
        });
    });
});

function formatDate(dateString) {
    if (!dateString) return 'No Date'; // Eğer tarih bilgisi yoksa

    const date = new Date(dateString);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}


// router.get('/dashboard2/:fileId')
router.get('/dashboard2/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const userId = req.session.user.id;

    // Kullanıcının tüm BOM dosyalarını al
    db.query('SELECT id, file_name, bom_count FROM bom_files WHERE user_id = ?', [userId], async (err, bomFiles) => {
        if (err) {
            console.error(err);
            return res.send('Bir hata oluştu.');
        }

        if (bomFiles.length === 0) {
            return res.status(404).send('BOM dosyası bulunamadı.');
        }

        // Seçili dosyanın bom_count bilgisini al
        const selectedBom = bomFiles.find(bom => bom.id == fileId);
        const bomCount = selectedBom ? selectedBom.bom_count : 1; // Eğer bom_count veritabanında yoksa 1 olarak al

        // BOM dosyasını al ve işle
        db.query('SELECT file_content FROM bom_files WHERE id = ?', [fileId], async (err, results) => {
            if (err || results.length === 0) {
                console.error('Dosya bulunamadı.');
                return res.status(404).send('Dosya bulunamadı.');
            }

            const fileBuffer = Buffer.from(results[0].file_content);
            const excelData = loadExcel(fileBuffer);
            const partDetailsFromExcel = filterPartNumbersAndQuantities(excelData);

            const token = await getToken();

            // DigiKey API sorgusu
            const digikeyResults = await Promise.all(partDetailsFromExcel.map(async (partDetail) => {
                try {
                    const result = await callDigiKeyAPI(partDetail.partNumber, token);
                    const digikeyLeadTimeDays = parseInt(result?.Product?.ManufacturerLeadWeeks || 0) * 7;

                    return {
                        partNumber: partDetail.partNumber,
                        manufacturer: result?.Product?.Manufacturer?.Name || 'N/A',
                        unitPrice: result?.Product?.UnitPrice || 'N/A',
                        stock: result?.Product?.QuantityAvailable || 'N/A',
                        totalPrice: (result?.Product?.UnitPrice * partDetail.quantity).toFixed(2) || 'N/A',
                        quantity: partDetail.quantity || 'Bilinmiyor',
                        leadTime: digikeyLeadTimeDays,
                        supplier: 'DigiKey'
                    };
                } catch (error) {
                    console.error(`DigiKey API çağrısı başarısız oldu: ${partDetail.partNumber}`, error.message);
                    return {
                        partNumber: partDetail.partNumber,
                        manufacturer: 'N/A',
                        unitPrice: 'N/A',
                        stock: 'N/A',
                        totalPrice: 'N/A',
                        quantity: partDetail.quantity || 'Bilinmiyor',
                        leadTime: 'N/A',
                        supplier: 'DigiKey'
                    };
                }
            }));

            // Mouser API sorgusu
            const mouserResults = await Promise.all(partDetailsFromExcel.map(async (partDetail) => {
                try {
                    const result = await callMouserAPI(partDetail.partNumber);
                    const mouserStockRaw = result?.SearchResults?.Parts[0]?.Availability || 'N/A';
                    const mouserStock = parseInt(mouserStockRaw.replace(' In Stock', ''), 10);
                    const priceBreaks = result?.SearchResults?.Parts[0]?.PriceBreaks || [];

                    // Doğru fiyatı seçmek için quantity değerine göre PriceBreaks'i kontrol edelim
                    let mouserPrice = 'N/A';
                    const quantity = partDetail.quantity || 1;

                    if (priceBreaks.length > 0) {
                        for (let i = 0; i < priceBreaks.length; i++) {
                            if (quantity >= priceBreaks[i].Quantity) {
                                mouserPrice = priceBreaks[i].Price.replace('$', '');
                            } else {
                                break;
                            }
                        }
                    }

                    const mouserLeadTimeDays = parseInt(result?.SearchResults?.Parts[0]?.LeadTime || 0);
                    const totalPrice = (parseFloat(mouserPrice) * quantity).toFixed(2);

                    return {
                        partNumber: partDetail.partNumber,
                        manufacturer: result?.SearchResults?.Parts[0]?.Manufacturer || 'N/A',
                        unitPrice: mouserPrice,
                        stock: mouserStock,
                        totalPrice: !isNaN(totalPrice) ? totalPrice : 'N/A',
                        quantity: quantity,
                        leadTime: mouserLeadTimeDays,
                        supplier: 'Mouser'
                    };
                } catch (error) {
                    console.error(`Mouser API çağrısı başarısız oldu: ${partDetail.partNumber}`, error.message);
                    return {
                        partNumber: partDetail.partNumber,
                        manufacturer: 'N/A',
                        unitPrice: 'N/A',
                        stock: 'N/A',
                        totalPrice: 'N/A',
                        quantity: partDetail.quantity || 'Bilinmiyor',
                        leadTime: 'N/A',
                        supplier: 'Mouser'
                    };
                }
            }));

            // DigiKey ve Mouser sonuçlarını karşılaştırıyoruz
            const combinedResults = partDetailsFromExcel.map((partDetail, index) => {
                const digikey = digikeyResults[index];
                const mouser = mouserResults[index];

                let recommendedSupplier = null;
                let selectedResult = null;

                // Lead time ve fiyat karşılaştırması
                if ((digikey.leadTime !== 'N/A' || mouser.leadTime !== 'N/A') &&
                    (digikey.unitPrice !== 'N/A' || mouser.unitPrice !== 'N/A')) {

                    if (digikey.leadTime !== 'N/A' && mouser.leadTime !== 'N/A') {
                        if (digikey.leadTime === mouser.leadTime) {
                            if (parseFloat(mouser.unitPrice) < parseFloat(digikey.unitPrice)) {
                                recommendedSupplier = 'Mouser';
                                selectedResult = mouser;
                            } else {
                                recommendedSupplier = 'DigiKey';
                                selectedResult = digikey;
                            }
                        } else if (mouser.leadTime < digikey.leadTime) {
                            recommendedSupplier = 'Mouser';
                            selectedResult = mouser;
                        } else {
                            recommendedSupplier = 'DigiKey';
                            selectedResult = digikey;
                        }
                    } else if (mouser.leadTime !== 'N/A') {
                        recommendedSupplier = 'Mouser';
                        selectedResult = mouser;
                    } else if (digikey.leadTime !== 'N/A') {
                        recommendedSupplier = 'DigiKey';
                        selectedResult = digikey;
                    }

                    if (mouser.unitPrice !== 'N/A') {
                        mouser.totalPrice = (parseFloat(mouser.unitPrice) * partDetail.quantity).toFixed(2);
                    }
                    if (digikey.unitPrice !== 'N/A') {
                        digikey.totalPrice = (parseFloat(digikey.unitPrice) * partDetail.quantity).toFixed(2);
                    }

                }

                return {
                    digikey,
                    mouser,
                    recommendedSupplier,
                    selectedResult,
                    partNumber: partDetail.partNumber
                };
            });

            // Toplam fiyatı hesapla
            const totalPrice = combinedResults.reduce((acc, result) => {
                const price = result.selectedResult ? parseFloat(result.selectedResult.totalPrice) : 0;
                return acc + price;
            }, 0) * bomCount;

            // En uzun teslimat süresini bul
            const maxLeadTime = Math.max(...combinedResults.map(result => result.selectedResult ? result.selectedResult.leadTime : 0));
            const minLeadTime = Math.min(...combinedResults.map(result => result.selectedResult ? result.selectedResult.leadTime : Infinity));
            
            
            // BOM dosyasını güncelle: total_price ve min_lead_time değerlerini veritabanına yaz ve bom_parts tablosunu da güncelle
db.query(
    'SELECT bom_price_1, bom_price_2, bom_price_3, bom_price_4, bom_price_5, bom_count FROM bom_files WHERE id = ?',
    [fileId], 
    (selectErr, bomData) => {
        if (selectErr || bomData.length === 0) {
            console.error('Veritabanı sorgusu başarısız:', selectErr ? selectErr.message : 'BOM dosyası bulunamadı.');
            return;
        }

        // Mevcut fiyat ve lead time bilgilerini alıyoruz
        const { bom_price_1, bom_price_2, bom_price_3, bom_price_4, bom_price_5, bom_count } = bomData[0];

        // BOM adet sayısına göre birim fiyat hesaplayalım
        const unitPrice = totalPrice / bom_count;

        let priceSlot, leadTimeSlot, priceDateSlot, leadTimeDateSlot;

        // İlk boş fiyat slotunu buluyoruz ya da en eskisini seçiyoruz
        if (!bom_price_1) {
            priceSlot = 'bom_price_1';
            leadTimeSlot = 'bom_lead_time_1';
            priceDateSlot = 'bom_price_1_date';
            leadTimeDateSlot = 'bom_lead_time_1_date';
        } else if (!bom_price_2) {
            priceSlot = 'bom_price_2';
            leadTimeSlot = 'bom_lead_time_2';
            priceDateSlot = 'bom_price_2_date';
            leadTimeDateSlot = 'bom_lead_time_2_date';
        } else if (!bom_price_3) {
            priceSlot = 'bom_price_3';
            leadTimeSlot = 'bom_lead_time_3';
            priceDateSlot = 'bom_price_3_date';
            leadTimeDateSlot = 'bom_lead_time_3_date';
        } else if (!bom_price_4) {
            priceSlot = 'bom_price_4';
            leadTimeSlot = 'bom_lead_time_4';
            priceDateSlot = 'bom_price_4_date';
            leadTimeDateSlot = 'bom_lead_time_4_date';
        } else if (!bom_price_5) {
            priceSlot = 'bom_price_5';
            leadTimeSlot = 'bom_lead_time_5';
            priceDateSlot = 'bom_price_5_date';
            leadTimeDateSlot = 'bom_lead_time_5_date';
        } else {
            // Eğer tüm slotlar doluysa, FIFO mantığı ile en eskisini güncelleyelim
            priceSlot = 'bom_price_1';
            leadTimeSlot = 'bom_lead_time_1';
            priceDateSlot = 'bom_price_1_date';
            leadTimeDateSlot = 'bom_lead_time_1_date';
        }

      // Yeni birim fiyat ve lead time bilgilerini ve tarihlerini yaz
db.query(
    `UPDATE bom_files 
    SET total_price = ?, 
        min_lead_time = ?, 
        ${priceSlot} = ?, 
        ${leadTimeSlot} = ?, 
        ${priceDateSlot} = NOW(), 
        ${leadTimeDateSlot} = NOW(), 
        last_updated = NOW()  -- last_updated alanı da şimdi güncelleniyor
    WHERE id = ?`,
    [totalPrice.toFixed(2), maxLeadTime, unitPrice.toFixed(2), maxLeadTime, fileId],
    (updateErr) => {
        if (updateErr) {
            console.error('Veritabanı güncellemesi başarısız:', updateErr.message);
        }
    }
);


// Part numaraları için bom_parts tablosunu güncelle
partDetailsFromExcel.forEach(part => {
    const { partNumber, quantity } = part;

    // DigiKey ve Mouser sonuçlarını al
    const digikey = digikeyResults.find(item => item.partNumber === partNumber);
    const mouser = mouserResults.find(item => item.partNumber === partNumber);

    let recommendedSupplier = null;
    let selectedResult = null;

    // Fiyat ve lead time bilgilerini kontrol et
    const isValidPrice = (price) => {
        // Fiyatın geçerli olup olmadığını kontrol et ve logla
        console.log(`Fiyat kontrol ediliyor: ${price}`);
        return price !== null && price !== 'N/A' && price !== undefined && parseFloat(price) > 0;
    };

    if ((digikey && isValidPrice(digikey.unitPrice) && digikey.leadTime !== 'N/A') || 
        (mouser && isValidPrice(mouser.unitPrice) && mouser.leadTime !== 'N/A')) {

        if (digikey && mouser) {
            // Eğer her iki tedarikçinin de geçerli fiyat ve lead time bilgisi varsa karşılaştırma yap
            console.log(`DigiKey fiyatı: ${digikey.unitPrice}, Mouser fiyatı: ${mouser.unitPrice}`);

            if (digikey.leadTime === mouser.leadTime) {
                // Lead time eşitse, fiyat karşılaştırması yap
                if (parseFloat(mouser.unitPrice) < parseFloat(digikey.unitPrice)) {
                    recommendedSupplier = 'Mouser';
                    selectedResult = mouser;
                } else {
                    recommendedSupplier = 'DigiKey';
                    selectedResult = digikey;
                }
            } else if (mouser.leadTime < digikey.leadTime) {
                // Mouser'ın lead time'ı daha kısa ise
                recommendedSupplier = 'Mouser';
                selectedResult = mouser;
            } else {
                // DigiKey'in lead time'ı daha kısa ise
                recommendedSupplier = 'DigiKey';
                selectedResult = digikey;
            }
        } else if (mouser && isValidPrice(mouser.unitPrice)) {
            // Sadece Mouser varsa ve fiyat geçerliyse
            recommendedSupplier = 'Mouser';
            selectedResult = mouser;
        } else if (digikey && isValidPrice(digikey.unitPrice)) {
            // Sadece DigiKey varsa ve fiyat geçerliyse
            recommendedSupplier = 'DigiKey';
            selectedResult = digikey;
        }

       
// Fiyatları direkt olarak kaydedelim, hiçbir bölme işlemi yapılmayacak
if (selectedResult && selectedResult.unitPrice !== 'N/A') {
    console.log(`Bölmeden önce fiyat: ${selectedResult.unitPrice}`);

    // Fiyatı olduğu gibi kaydet
    selectedResult.unitPrice = parseFloat(selectedResult.unitPrice).toFixed(3);
    console.log(`Bölmeden sonra fiyat: ${selectedResult.unitPrice}`);
}



        // BOM parçası tablosunu sorgula
        db.query('SELECT * FROM bom_parts WHERE bom_id = ? AND part_number = ?', 
        [fileId, partNumber], (err, existingPart) => {
            if (err) {
                console.error('Veritabanında bir hata oluştu:', err);
                return;
            }

            if (existingPart.length > 0) {
                // Mevcut part varsa FIFO mantığı ile güncelleyelim
                let partPriceSlot, partLeadTimeSlot, partPriceDateSlot, partLeadTimeDateSlot;
                const partData = existingPart[0];

                if (!partData.price_1) {
                    partPriceSlot = 'price_1';
                    partLeadTimeSlot = 'lead_time_1';
                    partPriceDateSlot = 'price_1_date';
                    partLeadTimeDateSlot = 'lead_time_1_date';
                } else if (!partData.price_2) {
                    partPriceSlot = 'price_2';
                    partLeadTimeSlot = 'lead_time_2';
                    partPriceDateSlot = 'price_2_date';
                    partLeadTimeDateSlot = 'lead_time_2_date';
                } else if (!partData.price_3) {
                    partPriceSlot = 'price_3';
                    partLeadTimeSlot = 'lead_time_3';
                    partPriceDateSlot = 'price_3_date';
                    partLeadTimeDateSlot = 'lead_time_3_date';
                } else if (!partData.price_4) {
                    partPriceSlot = 'price_4';
                    partLeadTimeSlot = 'lead_time_4';
                    partPriceDateSlot = 'price_4_date';
                    partLeadTimeDateSlot = 'lead_time_4_date';
                } else if (!partData.price_5) {
                    partPriceSlot = 'price_5';
                    partLeadTimeSlot = 'lead_time_5';
                    partPriceDateSlot = 'price_5_date';
                    partLeadTimeDateSlot = 'lead_time_5_date';
                } else {
                    // Tüm slotlar doluysa FIFO mantığıyla güncelle
                    partPriceSlot = 'price_1';
                    partLeadTimeSlot = 'lead_time_1';
                    partPriceDateSlot = 'price_1_date';
                    partLeadTimeDateSlot = 'lead_time_1_date';
                }

                // Güncellenen fiyatı loglayalım
                console.log(`Veritabanına yazılacak fiyat: ${selectedResult.unitPrice}`);

                // Yeni fiyat ve lead time bilgilerini ve tedarikçiyi güncelle
                db.query(
                    `UPDATE bom_parts 
                    SET ${partPriceSlot} = ?, ${partLeadTimeSlot} = ?, ${partPriceDateSlot} = NOW(), ${partLeadTimeDateSlot} = NOW(), supplier = ?
                    WHERE bom_id = ? AND part_number = ?`,
                    [selectedResult.unitPrice, selectedResult.leadTime, recommendedSupplier, fileId, partNumber],
                    (updateErr) => {
                        if (updateErr) {
                            console.error('Part güncellemesi sırasında hata oluştu:', updateErr.message);
                        }
                    }
                );
            }
        });
    }
});



    }
);







            // Part numarası detaylarını tabloya yansıt
            res.render('dashboard2', {
                email: req.session.user.email,
                bomFiles: bomFiles,
                bomDetails: combinedResults,
                selectedFileId: fileId,
                bomCount: bomCount,
                totalPrice: totalPrice.toFixed(2),
                maxLeadTime // En uzun teslimat süresi
            });
        });
    });
});

router.post('/bom_tracking/update', (req, res) => {
    const userId = req.session.user.id;

    const bomFiles = Object.keys(req.body).filter(key => key.startsWith('updateInterval_')).map(key => {
        const bomId = key.split('_')[1];
        return {
            bomId: bomId,
            updateInterval: req.body[`updateInterval_${bomId}`],
            partNotification: req.body[`partNotification_${bomId}`] ? 1 : 0,
            updateDisabled: req.body[`disableUpdate_${bomId}`] ? 1 : 0,
            startTime: req.body[`startTime_${bomId}`] ? new Date(req.body[`startTime_${bomId}`]) : null
        };
    });

    let completedQueries = 0;

    bomFiles.forEach(bom => {
        let nextUpdate = null;
        if (bom.startTime) {
            const startTimeDate = new Date(bom.startTime);
            switch (bom.updateInterval) {
                case 'minute':
                    nextUpdate = new Date(startTimeDate.getTime() + 1 * 60000); // 1 dakika ekle
                    break;
                case 'daily':
                    nextUpdate = new Date(startTimeDate.getTime() + 24 * 60 * 60000); // 1 gün ekle
                    break;
                case 'weekly':
                    nextUpdate = new Date(startTimeDate.getTime() + 7 * 24 * 60 * 60000); // 1 hafta ekle
                    break;
                case 'monthly':
                    nextUpdate = new Date(startTimeDate.getTime() + 30 * 24 * 60 * 60000); // 1 ay ekle
                    break;
                default:
                    nextUpdate = null;
            }
        }

        // Güncelleme sorgusu
        const updateQuery = `
            UPDATE bom_files
            SET update_interval = ?, part_notification = ?, update_disabled = ?, start_time = ?, next_update = ?
            WHERE user_id = ? AND id = ?
        `;
        db.query(updateQuery, [bom.updateInterval, bom.partNotification, bom.updateDisabled, bom.startTime, nextUpdate, userId, bom.bomId], (err) => {
            if (err) {
                console.error("Ayarlar kaydedilemedi:", err);
                return res.send('Ayarlar kaydedilemedi.');
            }

            // // Son güncelleme tarihini güncelle
            // const lastUpdateQuery = `
            //     UPDATE bom_files 
            //     SET last_updated = (
            //         SELECT GREATEST(
            //             COALESCE(bom_price_1_date, '1000-01-01'),
            //             COALESCE(bom_price_2_date, '1000-01-01'),
            //             COALESCE(bom_price_3_date, '1000-01-01'),
            //             COALESCE(bom_price_4_date, '1000-01-01'),
            //             COALESCE(bom_price_5_date, '1000-01-01')
            //         )
            //     )
            //     WHERE user_id = ? AND id = ?
            // `;
            // db.query(lastUpdateQuery, [userId, bom.bomId], (err) => {
            //     if (err) {
            //         console.error("Son güncelleme zamanı ayarlanamadı:", err);
            //         return res.send('Son güncelleme zamanı ayarlanamadı.');
            //     }
            // });
        });

        completedQueries++;
        if (completedQueries === bomFiles.length && !res.headersSent) {
            res.redirect('/bom_tracking');
        }
    });
});




router.get('/bom_tracking', (req, res) => {
    const userId = req.session.user.id;

    // Veritabanından BOM dosyalarını çek
    db.query('SELECT id, file_name, last_updated, part_notification, update_disabled, update_interval, start_time FROM bom_files WHERE user_id = ?', [userId], (err, bomFiles) => {
        if (err) {
            console.error('Veritabanı sorgusu başarısız:', err);
            return res.send('Veritabanı sorgusu başarısız.');
        }

        // BOM dosyalarını şablona gönder
        res.render('bom_tracking', { bomFiles });
    });
});



router.get('/dashboard2', (req, res) => {
    if (req.session.user) {
        const userId = req.session.user.id;

        // Kullanıcının BOM dosyalarını çekiyoruz
        db.query('SELECT id, file_name FROM bom_files WHERE user_id = ?', [userId], (err, bomFiles) => {
            if (err) {
                console.error(err);
                return res.send('Bir hata oluştu.');
            }

            // BOM dosyalarını frontend'e gönderiyoruz, fakat tablo boş olacak
            res.render('dashboard2', {
                email: req.session.user.email,
                bomFiles: bomFiles,  // Select için BOM dosyaları
                bomDetails: [],      // Boş tablo, part numarası detayları yok
                selectedFileId: null, // Seçili dosya yok
                bomCount: 1,         // Varsayılan olarak BOM adedi 1
                totalPrice: 0        // Toplam fiyat varsayılan olarak 0
            });
        });
    } else {
        res.redirect('/login');
    }
});
// Sipariş ekleme rotası
// Sipariş ekleme rotası
router.post('/takvim/addOrder', (req, res) => {
    const { bomId, orderName } = req.body;

    // Seçilen BOM dosyasının min_lead_time değerini çekme
    db.query('SELECT min_lead_time FROM bom_files WHERE id = ?', [bomId], (err, results) => {
        if (err || results.length === 0) {
            console.error(err);
            return res.status(404).json({ success: false, message: 'BOM dosyası bulunamadı.' });
        }

        const minLeadTime = results[0].min_lead_time;
        const today = new Date();

        // Sipariş teslim tarihini hesaplama (min_lead_time ekleyerek)
        const dueDate = new Date(today);
        dueDate.setDate(today.getDate() + minLeadTime);

        // Siparişi veritabanına ekleme
        const insertOrderQuery = `
            INSERT INTO orders (bom_id, order_name, due_date, total_price)
            VALUES (?, ?, ?, (SELECT total_price FROM bom_files WHERE id = ?))
        `;
        db.query(insertOrderQuery, [bomId, orderName, dueDate, bomId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false, message: 'Sipariş eklenirken bir hata oluştu.' });
            }

            // Sipariş başarıyla eklendiğinde JSON formatında başarı mesajı döndür
            res.status(200).json({
                success: true,
                message: 'Sipariş başarıyla eklendi.',
                due_date: dueDate.toISOString().split('T')[0], // Tarihi YYYY-MM-DD formatında döndür
            });
        });
    });
});


// Sipariş ekleme formu için ayrı bir rota (BOM dosyasına sipariş adı ekleme)
router.post('/takvim/add-order-name', (req, res) => {
    const { fileId, orderName } = req.body;

    const addOrderQuery = `
        INSERT INTO orders (bom_id, order_name, due_date)
        VALUES (?, ?, ?)
    `;

    db.query(addOrderQuery, [fileId, orderName, new Date()], (err, result) => {
        if (err) {
            console.error("Sipariş eklenirken bir hata oluştu:", err);
            return res.send('Sipariş eklenirken bir hata oluştu.');
        }

        // Sipariş eklendikten sonra takvim sayfasına yönlendirelim
        res.redirect('/takvim');
    });
});

// Takvim verilerini BOM dosyalarına göre oluştur
function generateCalendar(month, year) {
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const lastDateOfMonth = new Date(year, month + 1, 0).getDate();

    let weeks = [];
    let days = [];
    let dayCounter = 1;

    for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
        days = [];
        for (let dayIndex = 1; dayIndex <= 7; dayIndex++) {
            if (weekIndex === 0 && dayIndex < firstDayOfMonth) {
                days.push({ day: null });
            } else if (dayCounter > lastDateOfMonth) {
                days.push({ day: null });
            } else {
                days.push({ day: dayCounter });
                dayCounter++;
            }
        }
        weeks.push(days);
        if (dayCounter > lastDateOfMonth) {
            break;
        }
    }

    return weeks;
}

// Takvim sayfası: BOM dosyalarını getir ve seçilen ayı takvimde göster
router.get('/takvim', (req, res) => {
    const userId = req.session.user.id;
    const { month, year, fileId } = req.query;

    const currentDate = new Date();
    const selectedMonth = month ? parseInt(month) : currentDate.getMonth();
    const selectedYear = year ? parseInt(year) : currentDate.getFullYear();

    // Kullanıcının BOM dosyalarını getirme
    db.query('SELECT id, file_name FROM bom_files WHERE user_id = ?', [userId], (err, bomFiles) => {
        if (err) {
            console.error(err);
            return res.send('Bir hata oluştu.');
        }

        if (bomFiles.length === 0) {
            return res.status(404).send('BOM dosyası bulunamadı.');
        }

        // Siparişlerin getirilmesi (bom_files ile ilişkili siparişler)
        const ordersQuery = `
            SELECT orders.order_name, orders.due_date, bom_files.total_price
            FROM orders 
            JOIN bom_files ON orders.bom_id = bom_files.id
            WHERE bom_files.user_id = ?
        `;

        db.query(ordersQuery, [userId], (err, orders) => {
            if (err) {
                console.error(err);
                return res.send('Siparişler alınamadı.');
            }

            // Takvim ayı ve günleri hesaplama
            const weeks = generateCalendar(selectedMonth, selectedYear);

            const monthNames = [
                'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
            ];

            res.render('takvim', {
                orders: orders,
                month: selectedMonth,
                year: selectedYear,
                monthName: monthNames[selectedMonth],
                weeks: weeks,
                bomFiles: bomFiles,
                selectedFileId: fileId || null
            });
        });
    });
});



const { getDigiKeyPartDetails } = require('../apis/digikeyAPI');
// Her part numarası için DigiKey'den detayları almak için route
router.get('/digikey/partdetails/:partNumber', async (req, res) => {
    const partNumber = req.params.partNumber;
    try {
        const partDetails = await callDigiKeyAPI(partNumber);
        res.json(partDetails);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching part details' });
    }
});


// Part numaralarını getirip console'da gösterecek yeni route
// Part numaralarını getirip console'da gösterecek yeni route
// Part numaralarını getirip console'da gösterecek yeni route
router.get('/part-numbers/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    console.log("Part numaraları istek alındı, Dosya ID'si: " + fileId);

    try {
        const token = await getToken(); // Token'ı al
        console.log("Token alındı:", token);  // Token'ı backend console'da logla

        db.query('SELECT file_content FROM bom_files WHERE id = ?', [fileId], async (err, results) => {
            if (err || results.length === 0) {
                return res.status(404).json({ message: 'Dosya bulunamadı.' });
            }

            const fileBuffer = Buffer.from(results[0].file_content);
            const excelData = loadExcel(fileBuffer); // Excel dosyasını yükleyin
            const partNumberColumnIndex = findPartNumberColumn(excelData);

            if (partNumberColumnIndex !== -1) {
                const partNumbers = excelData.slice(1).map(row => row[partNumberColumnIndex]);
                console.log("Alınan Part Numaraları:", partNumbers);  // Part numaralarını logla

                // Part numaralarını client'a geri gönder
                res.json({ partNumbers });
            } else {
                res.status(404).json({ message: 'Part numarası içeren sütun bulunamadı.' });
            }
        });
    } catch (error) {
        console.error('Hata oluştu:', error.message);
        res.status(500).json({ message: 'Bir hata oluştu.' });
    }
});



router.post('/mouser-search-partnumber', async (req, res) => {
    const partNumber = req.body.partNumber; // İstemciden gelen parça numarası

    try {
        const result = await callMouserAPI(partNumber); // Mouser API'yi çağır
        res.json(result); // Veriyi client'a gönder
    } catch (error) {
        console.error(`Mouser API çağrısı başarısız oldu: ${partNumber}`, error.message);
        res.status(500).json({ error: 'Mouser API hatası' });
    }
});




// Ana sayfa rotası
router.get('/', (req, res) => {
    res.redirect('/login');
});

// Kayıt sayfası
router.get('/signup', (req, res) => {
    res.render('signup', { errorMessage: null });  // Her zaman boş bir errorMessage gönderiyoruz
});


// Kayıt sayfası (POST)
router.post('/signup', (req, res) => {
    const { first_name, last_name, email, password, confirm_password, phone_number } = req.body;

    if (password !== confirm_password) {
        return res.render('signup', { errorMessage: 'Şifreler eşleşmiyor. Lütfen tekrar deneyin.' });
    }

    db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
        if (err) {
            console.error(err);
            return res.send('Bir hata oluştu. Lütfen tekrar deneyin.');
        }

        if (results.length > 0) {
            return res.render('signup', { errorMessage: 'Bu e-posta adresi ile zaten bir hesap var.' });
        } else {
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) {
                    console.error(err);
                    return res.send('Kayıt işlemi sırasında bir hata oluştu.');
                }

                db.query('INSERT INTO users (first_name, last_name, email, password, phone_number) VALUES (?, ?, ?, ?, ?)', 
                [first_name, last_name, email, hash, phone_number], (err, result) => {
                    if (err) {
                        console.error(err);
                        return res.send('Kayıt işlemi sırasında bir hata oluştu.');
                    }

                    const userId = result.insertId;
                    const verificationCode = crypto.randomBytes(3).toString('hex');

                    db.query('INSERT INTO email_verification (user_id, verification_code, verified, created_at) VALUES (?, ?, 0, NOW())', 
                    [userId, verificationCode], (err) => {
                        if (err) {
                            console.error(err);
                            return res.send('Doğrulama bilgileri veritabanına kaydedilirken bir hata oluştu.');
                        }

                        // E-posta gönder
                        sendVerificationEmail(email, verificationCode);

                        res.render('verify', { email: email, errorMessage: null });
                    });
                });
            });
        }
    });
});



router.post('/verify-email', (req, res) => {
    const { email, verificationCode } = req.body;

    db.query('SELECT u.id, ev.verification_code FROM users u JOIN email_verification ev ON u.id = ev.user_id WHERE u.email = ?', 
    [email], (err, results) => {
        if (err) {
            console.error(err);
            return res.send('Bir hata oluştu. Lütfen tekrar deneyin.');
        }

        if (results.length > 0) {
            const userId = results[0].id;
            const dbVerificationCode = results[0].verification_code;

            // Doğrulama kodunu kontrol et
            if (verificationCode === dbVerificationCode) {
                // Kullanıcıyı doğrulandı olarak işaretle
                db.query('UPDATE email_verification SET verified = 1, verification_code = NULL WHERE user_id = ?', [userId], (err) => {
                    if (err) {
                        console.error(err);
                        return res.send('Doğrulama sırasında bir hata oluştu.');
                    }

                    // Doğrulama başarılı; kullanıcıyı dashboard'a yönlendir
                    res.redirect('/dashboard2');
                });
            } else {
                // Yanlış kod; hata mesajı ile doğrulama sayfasına dön
                res.render('verify', { email: email, errorMessage: 'Yanlış doğrulama kodu. Lütfen tekrar deneyin.' });
            }
        } else {
            res.render('verify', { email: email, errorMessage: 'E-posta veya doğrulama kodu hatalı. Lütfen tekrar deneyin.' });
        }
    });
});

router.post('/resend-verification-code', (req, res) => {
    const { email } = req.body;

    db.query('SELECT u.id, ev.verified FROM users u JOIN email_verification ev ON u.id = ev.user_id WHERE u.email = ?', [email], (err, results) => {
        if (err || results.length === 0) {
            return res.render('signup', { errorMessage: 'Bu e-posta adresiyle bir hesap bulunamadı.' });
        }

        const user = results[0];

        if (user.verified === 1) {
            return res.render('signup', { errorMessage: 'Bu e-posta zaten doğrulanmış. Lütfen giriş yapın.' });
        }

        // Yeni doğrulama kodu oluştur ve gönder
        const newVerificationCode = crypto.randomBytes(3).toString('hex');
        db.query('UPDATE email_verification SET verification_code = ?, verified = 0 WHERE user_id = ?', [newVerificationCode, user.id], (err) => {
            if (err) {
                return res.send('Doğrulama kodu güncellenirken bir hata oluştu.');
            }

            sendVerificationEmail(email, newVerificationCode); // Yeni kodu gönder
            res.render('verify', { email, successMessage: 'Yeni doğrulama kodu gönderildi. Lütfen kontrol edin.' });
        });
    });
});

// Giriş sayfası
router.get('/login', (req, res) => {
    res.render('login');
});

// Login işlemi sırasında hata kontrolü
router.post('/login', (req, res) => {
    const { email, password } = req.body;

    db.query('SELECT u.*, ev.verified FROM users u LEFT JOIN email_verification ev ON u.id = ev.user_id WHERE u.email = ?', [email], (err, results) => {
        if (err || results.length === 0) {
            return res.render('login', { errorMessage: 'Geçersiz kullanıcı adı veya şifre!' });
        }

        const user = results[0];

        // Kullanıcının doğrulaması yapılmamışsa
        if (!user.verified) {
            return res.render('login', { errorMessage: 'E-posta adresiniz doğrulanmamış. Lütfen doğrulama işlemini tamamlayın.' });
        }

        // Şifre doğrulaması
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err || !isMatch) {
                return res.render('login', { errorMessage: 'Geçersiz kullanıcı adı veya şifre!' });
            }

            // Başarılı giriş
            req.session.user = user;
            res.redirect('/dashboard2');
        });
    });
});

// Dashboard sayfası rotası
router.get('/dashboard', (req, res) => {
    const uploadSuccess = req.query.uploadSuccess === 'true'; 
    if (req.session.user) {
        const userId = req.session.user.id;

        db.query('SELECT * FROM bom_files WHERE user_id = ?', [userId], (err, bomFiles) => {
            if (err) {
                console.error(err);
                return res.send('Bir hata oluştu.');
            }

            const fileDataPromises = bomFiles.map((file) => {
                return new Promise((resolve, reject) => {
                    db.query('SELECT * FROM bom_data WHERE bom_file_id = ?', [file.id], (err, data) => {
                        if (err) reject(err);
                        else resolve({ file, data });
                    });
                });
            });

            Promise.all(fileDataPromises)
                .then((results) => {
                    res.render('dashboard', {
                        email: req.session.user.email,
                        first_name: req.session.user.first_name,
                        last_name: req.session.user.last_name,
                        bomFilesData: results,
                        uploadSuccess 
                    });
                })
                .catch((err) => {
                    console.error(err);
                    res.send('BOM dosyaları alınırken bir hata oluştu.');
                });
        });
    } else {
        res.redirect('/login');
    }
});

// Dosya indirme rotası
router.get('/download/:id', (req, res) => {
    const fileId = req.params.id;

    db.query('SELECT file_name, file_content FROM bom_files WHERE id = ?', [fileId], (err, results) => {
        if (err || results.length === 0) {
            console.error(err);
            return res.send('Dosya bulunamadı.');
        }

        const fileName = results[0].file_name;
        const fileContent = results[0].file_content;

        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.send(fileContent);
    });
});
// Dosya yükleme rotası
// Dosya yükleme rotası
router.post('/upload-bom', upload.single('bomFile'), (req, res) => {
    const userId = req.session.user.id;

    // Kullanıcı ID'si kontrolü
    if (!userId) {
        return res.send('Oturum açmış bir kullanıcı bulunamadı.');
    }

    const fileName = req.file.filename;
    const filePath = req.file.path; // Yüklenen dosyanın yolunu al

    // Dosya içeriğini oku
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error(err);
            return res.send('Dosya okunurken bir hata oluştu.');
        }

        // Dosyayı JSON formatına çeviriyoruz (Excel'den JSON'a)
        const fileBuffer = Buffer.from(data);
        const excelData = loadExcel(fileBuffer); // Excel dosyasını JSON formatına çeviriyoruz
        const partDetailsFromExcel = filterPartNumbersAndQuantities(excelData); // Part numaralarını ve quantity bilgilerini alıyoruz

        // Veritabanına bom_files ekle
        db.query('INSERT INTO bom_files (user_id, file_name, file_content) VALUES (?, ?, ?)', 
        [userId, fileName, data], (err, result) => {
            if (err) {
                console.error(err);
                return res.send('BOM dosyası veritabanına kaydedilirken bir hata oluştu.');
            }

            const bomId = result.insertId; // Yeni eklenen bom_files satırının ID'si

            // Her bir part numarası için bom_parts tablosuna ekleme yap
            partDetailsFromExcel.forEach(part => {
                const { partNumber, quantity } = part;

                // Aynı bom_id ve part_number ile eklenmiş mi kontrol et
                db.query('SELECT * FROM bom_parts WHERE bom_id = ? AND part_number = ?', 
                [bomId, partNumber], (err, existingPart) => {
                    if (err) {
                        console.error(err);
                        return res.send('Veritabanında bir hata oluştu.');
                    }

                    // Eğer aynı part eklenmemişse bom_parts'a ekle
                    if (existingPart.length === 0) {
                        db.query(`INSERT INTO bom_parts 
                        (bom_id, part_number, quantity) 
                        VALUES (?, ?, ?)`, 
                        [bomId, partNumber, quantity], (err, insertResult) => {
                            if (err) {
                                console.error(err);
                                return res.send('Part numarası eklenirken hata oluştu.');
                            }
                        });
                    }
                });
            });

            // İşlem başarıyla tamamlandığında yönlendirme yap
            res.redirect('/dashboard');
        });
    });
});


// Kullanıcı profili sayfası
router.get('/profile', (req, res) => {
    if (req.session.user) {
        res.render('profile', { user: req.session.user });
    } else {
        res.redirect('/login');
    }
});

// Logout işlemi
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error(err);
            return res.send('Çıkış yaparken bir hata oluştu.');
        }
        res.redirect('/');
    });
});
router.get('/part-details', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login'); // Kullanıcı oturum açmamışsa giriş sayfasına yönlendir
    }

    const userId = req.session.user.id; // Oturum açmış kullanıcının ID'si
    const partNumbers = JSON.parse(req.query.partNumbers); // Gelen part numaraları
    const fileId = req.query.fileId; // URL'den fileId'yi alıyoruz

    console.log('File ID:', fileId); // fileId'yi konsola yazdırarak kontrol edelim

    try {
        // Favori ürünleri ve takip edilen ürünleri veritabanından çek
        db.query('SELECT part_number FROM favorites WHERE user_id = ?', [userId], (err, favoriler) => {
            if (err) {
                console.error('Favoriler sorgusu başarısız:', err);
                return res.status(500).send('Favoriler alınamadı');
            }

            db.query('SELECT part_number FROM watchlist WHERE user_id = ?', [userId], async (err, takipEdilenler) => {
                if (err) {
                    console.error('Takip edilenler sorgusu başarısız:', err);
                    return res.status(500).send('Takip edilenler alınamadı');
                }

                const token = await getToken(); // Token alınması
                const digikeyResults = await Promise.all(partNumbers.map(async (partNumber) => {
                    let digikeyPrice = 'N/A';
                    let leadTime = 'N/A';
                
                    try {
                        const token = await getToken(); // Token yenileme
                        const result = await callDigiKeyAPI(partNumber, token); // DigiKey API çağrısı
                        // console.log('DigiKey API Result for', partNumber, result); // Yanıtı konsola yazdırıyoruz
                
                        // Fiyat ve lead time bilgilerini kontrol et
                        digikeyPrice = result?.Product?.UnitPrice || result?.Product?.StandardPricing?.[0]?.Price || 'N/A';
                        leadTime = result?.Product?.ManufacturerLeadWeeks ? result.Product.ManufacturerLeadWeeks * 7 : 'N/A';
                
                        return { partNumber, result, digikeyPrice, leadTime };
                    } catch (error) {
                        console.error(`DigiKey API çağrısı başarısız oldu: ${partNumber}`, error.message, error);
                        return { partNumber, result: null, digikeyPrice, leadTime };
                    }
                }));

                const mouserResults = await Promise.all(partNumbers.map(async (partNumber) => {
                    try {
                        const result = await callMouserAPI(partNumber); // Mouser API çağrısı
                        const mouserPrice = result?.SearchResults?.Parts[0]?.PriceBreaks?.[0]?.Price || 'N/A'; // Fiyat bilgisi
                        const mouserLeadTime = result?.SearchResults?.Parts[0]?.LeadTime || 'N/A'; // Lead time bilgisi
                
                        return { partNumber, result, mouserPrice, mouserLeadTime };
                    } catch (error) {
                        console.error(`Mouser API çağrısı başarısız oldu: ${partNumber}`, error.message, error);
                        return { partNumber, result: null, mouserPrice: 'N/A', mouserLeadTime: 'N/A' };
                    }
                }));

                // Element14 API Çağrısı
                const element14Results = await Promise.all(partNumbers.map(async (partNumber) => {
                    try {
                        const result = await callFarnellAPI(partNumber); // Element14 API
                        return { partNumber, result };
                    } catch (error) {
                        console.error(`Element14 API çağrısı başarısız oldu: ${partNumber}`);
                        return { partNumber, result: null };
                    }
                }));

                res.render('partdetails', {
                    fileId, // fileId'yi burada da render ediyoruz
                    partNumbers,
                    digikeyResults,
                    mouserResults,
                    element14Results, // Element14 sonuçları eklendi
                    arrowResults: [], // Placeholder for Arrow API sonuçları
                    favoriler: favoriler.map(fav => fav.part_number),
                    takipEdilenler: takipEdilenler.map(watch => watch.part_number)
                });
            });
        });
    } catch (error) {
        console.error('Hata oluştu:', error.message);
        res.status(500).send('Bir hata oluştu');
    }
});




async function getFavoriteProductDetails(partNumber) {
    try {
        const token = await getToken(); 
        const digiKeyDetails = await callDigiKeyAPI(partNumber, token);
        const mouserDetails = await callMouserAPI(partNumber);
        
        return {
            digiKey: {
                description: digiKeyDetails.Product.Description.ProductDescription || "Açıklama yok",
                manufacturer: digiKeyDetails.Product.Manufacturer.Name || "Üretici yok",
                quantityAvailable: digiKeyDetails.Product.QuantityAvailable || "Stok bilgisi yok",
                leadTime: digiKeyDetails.Product.ManufacturerLeadWeeks ? digiKeyDetails.Product.ManufacturerLeadWeeks * 7 : "Lead time bilgisi yok",
                unitPrice: digiKeyDetails.Product.UnitPrice || "Fiyat bilgisi yok",
                packaging: digiKeyDetails.Product.Packaging || "Ambalaj bilgisi yok",
                datasheets: digiKeyDetails.Product.Datasheets || [],
                productURL: digiKeyDetails.Product.ProductUrl || "URL yok"
            },
            mouser: {
                description: mouserDetails.SearchResults.Parts[0].Description || "Açıklama yok",
                manufacturer: mouserDetails.SearchResults.Parts[0].Manufacturer || "Üretici yok",
                quantityAvailable: mouserDetails.SearchResults.Parts[0].Availability || "Stok bilgisi yok",
                leadTime: mouserDetails.SearchResults.Parts[0].LeadTime || "Lead time bilgisi yok",
                unitPrice: mouserDetails.SearchResults.Parts[0].PriceBreaks ? mouserDetails.SearchResults.Parts[0].PriceBreaks[0].Price : "Fiyat bilgisi yok",
                packaging: mouserDetails.SearchResults.Parts[0].Packaging || "Ambalaj bilgisi yok",
                datasheets: mouserDetails.SearchResults.Parts[0].Datasheets || [],
                productURL: mouserDetails.SearchResults.Parts[0].ProductDetailUrl || "URL yok"
            }
        };
    } catch (error) {
        console.error('Favori ürün detaylarını alırken hata oluştu:', error.message);
        return null;
    }
}

async function getWatchlistProductDetails(partNumber) {
    try {
        const token = await getToken();
        const digiKeyDetails = await callDigiKeyAPI(partNumber, token);
        const mouserDetails = await callMouserAPI(partNumber);
        
        return {
            digiKey: {
                description: digiKeyDetails.Product.Description.ProductDescription || "Açıklama yok",
                manufacturer: digiKeyDetails.Product.Manufacturer.Name || "Üretici yok",
                quantityAvailable: digiKeyDetails.Product.QuantityAvailable || "Stok bilgisi yok",
                leadTime: digiKeyDetails.Product.ManufacturerLeadWeeks ? digiKeyDetails.Product.ManufacturerLeadWeeks * 7 : "Lead time bilgisi yok",
                unitPrice: digiKeyDetails.Product.UnitPrice || "Fiyat bilgisi yok",
                packaging: digiKeyDetails.Product.Packaging || "Ambalaj bilgisi yok",
                datasheets: digiKeyDetails.Product.Datasheets || [],
                productURL: digiKeyDetails.Product.ProductUrl || "URL yok"
            },
            mouser: {
                description: mouserDetails.SearchResults.Parts[0].Description || "Açıklama yok",
                manufacturer: mouserDetails.SearchResults.Parts[0].Manufacturer || "Üretici yok",
                quantityAvailable: mouserDetails.SearchResults.Parts[0].Availability || "Stok bilgisi yok",
                leadTime: mouserDetails.SearchResults.Parts[0].LeadTime || "Lead time bilgisi yok",
                unitPrice: mouserDetails.SearchResults.Parts[0].PriceBreaks ? mouserDetails.SearchResults.Parts[0].PriceBreaks[0].Price : "Fiyat bilgisi yok",
                packaging: mouserDetails.SearchResults.Parts[0].Packaging || "Ambalaj bilgisi yok",
                datasheets: mouserDetails.SearchResults.Parts[0].Datasheets || [],
                productURL: mouserDetails.SearchResults.Parts[0].ProductDetailUrl || "URL yok"
            }
        };
    } catch (error) {
        console.error('Takip edilen ürün detaylarını alırken hata oluştu:', error.message);
        return null;
    }
}
// Tüm part number'lar için detayları görüntülemek için EJS sayfasını render eden rota
// router.get('/all-part-details-view', async (req, res) => {
//     const fileId = req.query.fileId;
//     const partNumbers = req.query.partNumbers ? JSON.parse(req.query.partNumbers) : [];
    

//     // fileId ve partNumbers kontrolü
//     if (!fileId || !partNumbers || partNumbers.length === 0) {
//         console.error("Geçersiz veri: fileId veya partNumbers eksik.");
//         return res.status(400).json({ message: "Geçersiz veri. fileId veya partNumbers eksik." });
//     }

//     try {
//         // Veritabanından Excel dosyasını al
//         db.query('SELECT file_content FROM bom_files WHERE id = ?', [fileId], (err, results) => {
//             if (err || results.length === 0) {
//                 console.error('Dosya bulunamadı:', err);
//                 return res.status(404).json({ message: 'Dosya bulunamadı.' });
//             }

//             const fileBuffer = Buffer.from(results[0].file_content); // Excel dosyasını buffer olarak yükle
//             const excelData = loadExcel(fileBuffer); // Excel dosyasını yükle
//             const partDetailsFromExcel = filterPartNumbersAndQuantities(excelData); // Excel'den part numaralarını ve miktarları filtrele

//             // DigiKey ve Mouser API sonuçlarını topluyoruz
//             Promise.all(partNumbers.map(async (partNumber) => {
//                 const partDetailFromExcel = partDetailsFromExcel.find(detail => detail.partNumber === partNumber);

//                 let digikeyPrice = 'N/A';
//                 let mouserPrice = 'N/A';
//                 let leadTime = 'N/A';

//                 // DigiKey API fiyat ve lead time bilgilerini alalım
//                 try {
//                     const token = await getToken(); // Token yenile
//                     const digikeyResult = await callDigiKeyAPI(partNumber, token);
//                     digikeyPrice = digikeyResult?.Product?.UnitPrice || 'N/A';
//                     leadTime = digikeyResult?.Product?.ManufacturerLeadWeeks ? digikeyResult.Product.ManufacturerLeadWeeks * 7 : 'N/A'; // Lead time'ı gün cinsine çeviriyoruz
//                 } catch (error) {
//                     console.error(`DigiKey API çağrısında hata oluştu: ${partNumber}`, error.message);
//                 }

//                 // Mouser API fiyat bilgilerini alalım
//                 try {
//                     const mouserResult = await callMouserAPI(partNumber);
//                     mouserPrice = mouserResult?.SearchResults?.Parts[0]?.PriceBreaks[0]?.Price || 'N/A';
//                 } catch (error) {
//                     console.error(`Mouser API çağrısında hata oluştu: ${partNumber}`, error.message);
//                 }

//                 // Part numarası, quantity, DigiKey ve Mouser fiyatları ile lead time bilgilerini döndürüyoruz
//                 return {
//                     partNumber,
//                     quantity: partDetailFromExcel ? partDetailFromExcel.quantity : 'Quantity Bilgisi Yok',
//                     digikeyPrice,
//                     mouserPrice,
//                     leadTime
//                 };
//             }))
//             .then(partDetails => {
//                 // Part detaylarını view'e gönderiyoruz
//                 res.render('all-part-details-view', {
//                     fileId,
//                     partDetails // Part numarası, quantity, DigiKey ve Mouser fiyatlarıyla birlikte render ediliyor
//                 });
//             })
//             .catch(err => {
//                 console.error('Veri işleme hatası:', err);
//                 res.status(500).json({ message: 'Veri işleme sırasında bir hata oluştu.' });
//             });
//         });
//     } catch (error) {
//         console.error('Hata:', error.message);
//         res.status(500).json({ message: 'Bir hata oluştu.' });
//     }
// });


// Mesaj gönderimi
router.post('/messages/send', async (req, res) => {
    console.log("Mesaj gönderim işlemi başlatıldı");
    try {
        const { recipientEmail, senderId, messageText, messageType, mediaUrl } = req.body;

        if (!recipientEmail || !senderId || !messageText) {
            return res.status(400).json({ error: 'Zorunlu alanlar eksik.' });
        }

        // Mesaj gönderilen kişinin ID'sini alalım
        const recipientQuery = 'SELECT id FROM users WHERE email = ?';
        const recipientResults = await new Promise((resolve, reject) => {
            db.query(recipientQuery, [recipientEmail], (err, results) => {
                if (err) reject(err);
                resolve(results);
            });
        });

        if (recipientResults.length === 0) {
            return res.status(404).json({ error: 'Recipient not found' });
        }

        const recipientId = recipientResults[0].id;

        // Mesajı veritabanına ekleyelim
        const insertQuery = `
            INSERT INTO messages (sender_id, recipient_id, message_text, message_type, media_url)
            VALUES (?, ?, ?, ?, ?)
        `;
        await new Promise((resolve, reject) => {
            db.query(insertQuery, [senderId, recipientId, messageText, messageType, mediaUrl], (err, result) => {
                if (err) reject(err);
                resolve(result);
            });
        });

        console.log("Mesaj başarıyla gönderildi");
        return res.json({ message: 'Mesaj başarıyla gönderildi' });

    } catch (error) {
        console.error('Mesaj gönderilirken hata oluştu:', error.message);
        return res.status(500).json({ error: 'Mesaj gönderilirken sunucu hatası oluştu.' });
    }
});


// Mesaj listeleme
router.get('/messages/:recipientEmail', (req, res) => {
    const { recipientEmail } = req.params;
    const senderId = req.session.user.id;

    // Alıcı ID'sini al
    db.query('SELECT id FROM users WHERE email = ?', [recipientEmail], (err, results) => {
        if (err || results.length === 0) {
            return res.status(500).json({ error: 'Recipient not found' });
        }

        const recipientId = results[0].id;

        // Mesajları çek
        db.query(`
            SELECT m.*, u.email AS sender_email
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE (m.sender_id = ? AND m.recipient_id = ?)
            OR (m.sender_id = ? AND m.recipient_id = ?)
            ORDER BY m.created_at ASC`,
            [senderId, recipientId, recipientId, senderId],
            (err, messages) => {
                if (err) {
                    return res.status(500).json({ error: 'Mesajlar alınırken hata oluştu' });
                }
                res.json(messages);
            });
    });
});

// Kullanıcıları listeleme (email için)
router.get('/messaging', (req, res) => {
    // Kullanıcıların listesini çekiyoruz
    db.query('SELECT email FROM users WHERE id != ?', [req.session.user.id], (err, users) => {
        if (err) {
            console.error('Kullanıcılar çekilirken hata oluştu:', err);
            return res.status(500).send('Veritabanı hatası');
        }
        // messaging.ejs sayfasını render ediyoruz ve tüm kullanıcıları gönderiyoruz
        res.render('messaging', { user: req.session.user, users });
    });
});

// Grup oluşturma
router.post('/groups/create', (req, res) => {
    const { groupName, groupMembers } = req.body;
    const creatorId = req.session.user.id; 

    // Grup oluşturma sorgusu
    db.query('INSERT INTO chat_groups (group_name, creator_id) VALUES (?, ?)', [groupName, creatorId], (err, result) => {
        if (err) {
            console.error('Grup oluşturulurken hata oluştu:', err);
            return res.status(500).json({ error: 'Grup oluşturulamadı' });
        }

        const groupId = result.insertId;

        // Grup üyelerini kaydetme (checkbox ile seçilen kullanıcılar)
        const members = groupMembers.map(memberId => [groupId, memberId]);

        // Çoklu ekleme için kullanıyoruz
        db.query('INSERT INTO group_members (group_id, user_id) VALUES ?', [members], (err) => {
            if (err) {
                console.error('Grup üyeleri eklenirken hata oluştu:', err);
                return res.status(500).json({ error: 'Grup üyeleri eklenemedi' });
            }

            res.redirect('/groups'); // Grup oluşturulduktan sonra yönlendirme yapılır
        });
    });
});


// Tüm kullanıcıları listeleme (grup oluştururken kullanılacak)
router.get('/groups/new', (req, res) => {
    db.query('SELECT id, email FROM users', (err, users) => {
        if (err) {
            console.error('Kullanıcılar alınırken hata oluştu:', err);
            return res.status(500).json({ error: 'Kullanıcılar alınamadı' });
        }

        res.render('group_chat', { users });
    });
});
// Mesaj silme
router.post('/messages/:messageId/delete', (req, res) => {
    const { messageId } = req.params;

    db.query('DELETE FROM messages WHERE id = ?', [messageId], (err, result) => {
        if (err) {
            console.error('Mesaj silinirken hata oluştu:', err);
            return res.status(500).json({ error: 'Mesaj silinemedi' });
        }

        res.json({ message: 'Mesaj başarıyla silindi' });
    });
});

// Mesaj düzenleme
router.post('/messages/:messageId/edit', (req, res) => {
    const { messageId } = req.params;
    const { messageText } = req.body;

    db.query(`
        UPDATE messages 
        SET message_text = ?, edited = 1
        WHERE id = ?`, 
        [messageText, messageId], (err, result) => {
            if (err) {
                console.error('Mesaj düzenlenirken hata oluştu:', err);
                return res.status(500).json({ error: 'Mesaj düzenlenemedi' });
            }

            res.json({ message: 'Mesaj başarıyla düzenlendi' });
        });
});


// Mesaj düzenleme
router.post('/groups/messages/:messageId/edit', (req, res) => {
    const { messageId } = req.params;
    const { newMessage } = req.body;

    db.query('UPDATE group_messages SET message_text = ?, edited = 1 WHERE id = ?', [newMessage, messageId], (err, result) => {
        if (err) {
            console.error('Mesaj düzenlenirken hata oluştu:', err);
            return res.status(500).json({ success: false });
        }
        res.json({ success: true });
    });
});

// Grup bilgilerini ve üyelerini getirme
router.get('/groups/:groupId/info', (req, res) => {
    const { groupId } = req.params;
    const user = req.session.user; // Oturumdan kullanıcı bilgisini alıyoruz

    // Grup bilgilerini ve üyeleri al
    db.query('SELECT * FROM chat_groups WHERE id = ?', [groupId], (err, groupResults) => {
        if (err || groupResults.length === 0) {
            console.error('Grup bilgileri alınırken hata oluştu:', err);
            return res.status(500).json({ error: 'Grup bilgileri alınamadı' });
        }

        const group = groupResults[0];

        // Grup üyelerini al
        db.query('SELECT users.id, users.email FROM group_members JOIN users ON group_members.user_id = users.id WHERE group_members.group_id = ?', [groupId], (err, memberResults) => {
            if (err) {
                console.error('Grup üyeleri alınırken hata oluştu:', err);
                return res.status(500).json({ error: 'Grup üyeleri alınamadı' });
            }

            const members = memberResults;

            // Kurucuyu al
            db.query('SELECT users.id, users.email FROM users WHERE users.id = ?', [group.creator_id], (err, creatorResults) => {
                if (err || creatorResults.length === 0) {
                    console.error('Grup kurucusu alınırken hata oluştu:', err);
                    return res.status(500).json({ error: 'Grup kurucusu alınamadı' });
                }

                const creator = creatorResults[0];

                // Yönlendirmeden sonra sayfayı render ediyoruz, `user` oturum bilgisiyle birlikte
                res.render('group_info', { group, members, creator, user });
            });
        });
    });
});

// Grup silme işlemi (sadece kurucuya izin veriyoruz)
router.post('/groups/:groupId/delete', (req, res) => {
    const { groupId } = req.params;
    const userId = req.session.user.id;

    // Kullanıcının grup kurucusu olup olmadığını kontrol ediyoruz
    db.query('SELECT creator_id FROM chat_groups WHERE id = ?', [groupId], (err, results) => {
        if (err || results.length === 0 || results[0].creator_id !== userId) {
            return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok.' });
        }

        // Gruba ait tüm üyeleri sil
        db.query('DELETE FROM group_members WHERE group_id = ?', [groupId], (err, result) => {
            if (err) {
                console.error('Grup üyeleri silinirken hata oluştu:', err);
                return res.status(500).json({ error: 'Grup üyeleri silinemedi.' });
            }

            // Grup silme işlemi (üye silindikten sonra grubu siler)
            db.query('DELETE FROM chat_groups WHERE id = ?', [groupId], (err, result) => {
                if (err) {
                    console.error('Grup silinirken hata oluştu:', err);
                    return res.status(500).json({ error: 'Grup silinemedi.' });
                }

                res.redirect('/groups'); // Grup silindikten sonra grup listesine yönlendir
            });
        });
    });
});


// Grup üyesini çıkarma işlemi (sadece kurucuya izin veriyoruz)
router.post('/groups/:groupId/members/:memberId/remove', (req, res) => {
    const { groupId, memberId } = req.params;
    const userId = req.session.user.id; // Kullanıcıyı oturumdan alıyoruz

    // Kullanıcının grup kurucusu olup olmadığını kontrol et
    db.query('SELECT creator_id FROM chat_groups WHERE id = ?', [groupId], (err, results) => {
        if (err || results.length === 0 || results[0].creator_id !== userId) {
            return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok.' });
        }

        // Üyeyi gruptan çıkar
        db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, memberId], (err, result) => {
            if (err) {
                console.error('Üye çıkarılırken hata oluştu:', err);
                return res.status(500).json({ error: 'Üye çıkarılamadı.' });
            }

            // Kullanıcı bilgisi oturumda taşınacağından, yeniden yönlendirirken kullanıcı bilgisine ihtiyacımız yok
            res.redirect(`/groups/${groupId}/messages`); // Grup bilgisi sayfasına yönlendir
        });
    });
});



router.delete('/groups/messages/:messageId/delete', (req, res) => {
    const { messageId } = req.params;

    db.query('DELETE FROM group_messages WHERE id = ?', [messageId], (err, result) => {
        if (err) {
            console.error('Mesaj silinirken hata oluştu:', err);
            return res.status(500).json({ success: false });
        }
        res.json({ success: true });
    });
});

// //grup mesaj 
// router.post('/groups/:groupId/messages/send', (req, res) => {
//     const { groupId } = req.params;
//     const { senderId, messageText, messageType, mediaUrl } = req.body;

//     db.query(`
//         INSERT INTO group_messages (group_id, sender_id, message_text, message_type, media_url)
//         VALUES (?, ?, ?, ?, ?)`, 
//         [groupId, senderId, messageText, messageType, mediaUrl], (err, result) => {
//             if (err) {
//                 console.error('Mesaj gönderilirken hata oluştu:', err);
//                 return res.status(500).json({ error: 'Mesaj gönderilemedi' });
//             }
            
//             res.redirect(`/groups/${groupId}/messages`);
//         });
// });
// Kullanıcıya yeni mesaj bildirimini gösterme

// Mesajları okundu olarak işaretleme (bireysel sohbet)
router.post('/messages/:recipientId/mark-as-read', (req, res) => {
    const { recipientId } = req.params;
    const senderId = req.session.user.id;

    db.query(`
        UPDATE messages 
        SET is_read = 1 
        WHERE sender_id = ? AND recipient_id = ? AND is_read = 0`,
        [recipientId, senderId], 
        (err, result) => {
            if (err) {
                console.error('Mesajlar okunurken hata oluştu:', err);
                return res.status(500).json({ error: 'Mesajlar okunamadı.' });
            }
            res.json({ message: 'Mesajlar başarıyla okundu olarak işaretlendi.' });
        }
    );
});
// Grup mesajlarını okundu olarak işaretleme
router.post('/groups/:groupId/messages/mark-as-read', (req, res) => {
    const { groupId } = req.params;
    const userId = req.session.user.id;

    db.query(`
        UPDATE group_messages 
        SET is_read = 1 
        WHERE group_id = ? AND sender_id != ? AND is_read = 0`,
        [groupId, userId], 
        (err, result) => {
            if (err) {
                console.error('Grup mesajları okunurken hata oluştu:', err);
                return res.status(500).json({ error: 'Grup mesajları okunamadı.' });
            }
            res.json({ message: 'Grup mesajları başarıyla okundu olarak işaretlendi.' });
        }
    );
});

// Okunmamış mesaj sayısını alma
router.get('/notifications/unread-messages', (req, res) => {
    const userId = req.session.user.id;

    db.query(`
        SELECT COUNT(*) AS unreadCount 
        FROM messages 
        WHERE recipient_id = ? AND is_read = 0`, 
        [userId], 
        (err, results) => {
            if (err) {
                console.error('Okunmamış mesajlar alınırken hata oluştu:', err);
                return res.status(500).json({ error: 'Okunmamış mesajlar alınamadı.' });
            }
            res.json({ unreadCount: results[0].unreadCount });
        }
    );
});

// Grup sohbeti için mesaj gönderme (medya dosyası dahil)
router.post('/groups/:groupId/messages/send', upload2.single('media'), (req, res) => {
    const { groupId } = req.params;
    const { senderId, messageText, messageType } = req.body;
    const media = req.file;

    let mediaData = null;
    if (media) {
        mediaData = media.buffer.toString('base64');  // Medya dosyasını Base64 formatına dönüştürme
    }

    db.query(`
        INSERT INTO group_messages (group_id, sender_id, message_text, message_type, media_url)
        VALUES (?, ?, ?, ?, ?)`, 
        [groupId, senderId, messageText, media ? 'media' : 'text', mediaData], (err, result) => {
            if (err) {
                console.error('Mesaj gönderilirken hata oluştu:', err);
                return res.status(500).json({ error: 'Mesaj gönderilemedi' });
            }
            
            res.redirect(`/groups/${groupId}/messages`);
        });
});



// Belirli bir grup için mesajları listeleme
router.get('/groups/:groupId/messages', (req, res) => {
    const { groupId } = req.params;
    const user = req.session.user; // Kullanıcı bilgisini al

    db.query(`
        SELECT group_messages.*, users.email AS sender_name 
        FROM group_messages 
        JOIN users ON group_messages.sender_id = users.id 
        WHERE group_messages.group_id = ? 
        ORDER BY group_messages.created_at ASC`, [groupId], (err, messages) => {
        if (err) {
            console.error('Mesajlar alınırken hata oluştu:', err);
            return res.status(500).json({ error: 'Mesajlar alınamadı' });
        }

        // user bilgisini ve mesajları EJS şablonuna geçiyoruz
        res.render('group_messages', { group: { id: groupId }, messages, user });
    });
});
// Grup üyesini çıkarma
router.post('/groups/:groupId/remove-member', (req, res) => {
    const { groupId } = req.params;
    const { memberId } = req.body;

    // Üyeyi gruptan çıkarma
    db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, memberId], (err, result) => {
        if (err) {
            console.error('Üye çıkarılırken hata oluştu:', err);
            return res.status(500).json({ error: 'Üye çıkarılamadı' });
        }

        res.redirect(`/groups/${groupId}/info`);
    });
});

// Grup bilgilerini ve üyelerini listeleme
router.get('/groups/:groupId', (req, res) => {
    const { groupId } = req.params;

    // Grup bilgilerini alma
    db.query('SELECT * FROM chat_groups WHERE id = ?', [groupId], (err, groupResult) => {
        if (err || groupResult.length === 0) {
            console.error('Grup bilgileri alınırken hata oluştu:2449', err);
            return res.status(500).json({ error: 'Grup bilgileri alınamadı' });
        }

        const group = groupResult[0];

        // Grup üyelerini alma
        db.query('SELECT users.id, users.email FROM group_members JOIN users ON group_members.user_id = users.id WHERE group_members.group_id = ?', [groupId], (err, membersResult) => {
            if (err) {
                console.error('Grup üyeleri alınırken hata oluştu:', err);
                return res.status(500).json({ error: 'Grup üyeleri alınamadı' });
            }

            const members = membersResult;

            // Grup kurucusunu alma
            db.query('SELECT id, email FROM users WHERE id = ?', [group.creator_id], (err, creatorResult) => {
                if (err || creatorResult.length === 0) {
                    console.error('Kurucu bilgisi alınırken hata oluştu:', err);
                    return res.status(500).json({ error: 'Kurucu bilgisi alınamadı' });
                }

                const creator = creatorResult[0];

                // Tüm bilgileri frontend'e gönderiyoruz
                res.render('group_info', { group, members, creator });
            });
        });
    });
});


// Tüm grupları listeleme (kurucu ve üye olunan gruplar dahil)
router.get('/groups', (req, res) => {
    const userId = req.session.user.id;

    db.query(`
        SELECT DISTINCT chat_groups.* 
        FROM chat_groups 
        LEFT JOIN group_members ON chat_groups.id = group_members.group_id
        WHERE chat_groups.creator_id = ? OR group_members.user_id = ?`, 
        [userId, userId], (err, groups) => {
        if (err) {
            console.error('Gruplar alınırken hata oluştu:', err);
            return res.status(500).json({ error: 'Gruplar alınamadı' });
        }

        res.render('groups', { groups }); // Tüm gruplar frontend'e gönderilir
    });
});


router.post('/all-part-details-view', (req, res) => {
    const { fileId, partNumbers, digikeyResults, mouserResults } = req.body;

    // Gelen JSON verilerini parse et
    const parsedPartNumbers = JSON.parse(partNumbers);
    const parsedDigikeyResults = JSON.parse(digikeyResults);
    const parsedMouserResults = JSON.parse(mouserResults);

    // Veritabanından Excel dosyasını çekelim
    db.query('SELECT file_content FROM bom_files WHERE id = ?', [fileId], (err, results) => {
        if (err || results.length === 0) {
            console.error('Dosya bulunamadı:', err);
            return res.status(404).json({ message: 'Dosya bulunamadı.' });
        }

        const fileBuffer = Buffer.from(results[0].file_content); // Excel dosyasını buffer olarak yükle
        const excelData = loadExcel(fileBuffer); // Excel dosyasını yükle
        const partDetailsFromExcel = filterPartNumbersAndQuantities(excelData); // Excel'den part numaralarını ve miktarları filtrele

        let totalSavings = 0; // Toplam karı tutmak için

        // Part detaylarını oluştur
        const partDetails = parsedPartNumbers.map((partNumber) => {
            const digikeyResult = parsedDigikeyResults.find(result => result.partNumber === partNumber);
            const mouserResult = parsedMouserResults.find(result => result.partNumber === partNumber);
            const partDetailFromExcel = partDetailsFromExcel.find(detail => detail.partNumber === partNumber); // Excel'den part numarası ile eşleşen miktar bilgisi

            // DigiKey Fiyat ve Lead Time Bilgisi
            let digikeyPrice = 'N/A';
            let leadTime = 'N/A';
            if (digikeyResult && digikeyResult.result && digikeyResult.result.Product) {
                digikeyPrice = parseFloat(digikeyResult.result.Product.UnitPrice) || parseFloat(digikeyResult.result.Product.StandardPricing?.[0]?.Price) || 'N/A';
                leadTime = digikeyResult.result.Product.ManufacturerLeadWeeks ? digikeyResult.result.Product.ManufacturerLeadWeeks * 7 : 'N/A'; // Haftayı gün'e çeviriyoruz
            }

            // Mouser Fiyat Bilgisi ve Lead Time
            let mouserPrice = 'N/A';
            let mouserLeadTime = 'N/A';
            if (mouserResult && mouserResult.result && mouserResult.result.SearchResults && mouserResult.result.SearchResults.Parts && mouserResult.result.SearchResults.Parts.length > 0) {
                const partData = mouserResult.result.SearchResults.Parts[0];
                
                // PriceBreaks kontrolü
                if (partData.PriceBreaks && partData.PriceBreaks.length > 0) {
                    mouserPrice = parseFloat(partData.PriceBreaks[0].Price) || 'N/A';
                }

                // Lead time bilgisi
                mouserLeadTime = partData.LeadTime || 'N/A';
            }

            // Excel'den gelen miktar bilgisini kullan (Excel'den gelmezse Quantity Bilgisi Yok)
            let quantity = partDetailFromExcel ? partDetailFromExcel.quantity : 'Quantity Bilgisi Yok';

            // Fiyatları kontrol et, 'N/A' ise Infinity olarak değerlendir
            const parsedDigikeyPrice = isNaN(digikeyPrice) ? Infinity : digikeyPrice;
            const parsedMouserPrice = isNaN(mouserPrice) ? Infinity : mouserPrice;

            // Kar hesaplaması (eğer iki fiyat da varsa)
            if (parsedDigikeyPrice !== Infinity && parsedMouserPrice !== Infinity) {
                totalSavings += Math.abs(parsedDigikeyPrice - parsedMouserPrice) * (parseInt(quantity) || 0);
            }

            return {
                partNumber: partNumber,
                quantity: quantity, // Excel'den alınan quantity bilgisi
                digikeyPrice: parsedDigikeyPrice !== Infinity ? `$${parsedDigikeyPrice.toFixed(2)}` : 'Fiyat Bilinmiyor',
                leadTime: leadTime,
                mouserPrice: parsedMouserPrice !== Infinity ? `$${parsedMouserPrice.toFixed(2)}` : 'Fiyat Bilinmiyor',
                mouserLeadTime: mouserLeadTime
            };
        });

        // Tüm part detaylarını view'e gönder
        res.render('all-part-details-view', {
            fileId,
            partDetails, // Tabloda kullanılacak part detayları
            totalSavings // Toplam karı gönder
        });
    });
});










// Favori ürün detaylarını almak için API endpoint
router.get('/get-favorite-details/:partNumber', async (req, res) => {
   
    const partNumber = req.params.partNumber; // URL'den partNumber alınır
    const productDetails = await getFavoriteProductDetails(partNumber); // Ürün detaylarını al
    res.json(productDetails); // Detayları JSON formatında döndür
});

// Takip edilen ürün detaylarını almak için API endpoint
router.get('/get-watchlist-details', async (req, res) => {
    const partNumber = req.query.partNumber; // Takip edilen ürün part numarasını al
    const productDetails = await getWatchlistProductDetails(partNumber); // Ürün detaylarını al
    res.json(productDetails); // Detayları JSON olarak geri gönder
});

// Favorites and Watchlist Page
// Favoriler ve takip edilenler rotası
router.get('/favorites-and-watchlist', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login'); // Eğer kullanıcı oturum açmamışsa login sayfasına yönlendir
    }

    const userId = req.session.user.id;

    // Favoriler ve takip edilenler sorguları
    db.query('SELECT part_number FROM favorites WHERE user_id = ?', [userId], (err, favoriler) => {
        if (err) {
            console.error('Favoriler sorgusu hatası:', err);
            return res.status(500).send('Favoriler alınamadı.');
        }

        db.query('SELECT part_number FROM watchlist WHERE user_id = ?', [userId], (err, takipEdilenler) => {
            if (err) {
                console.error('Takip edilenler sorgusu hatası:', err);
                return res.status(500).send('Takip edilenler alınamadı.');
            }

            res.render('favorites-watchlist', {
                favoritePartNumbers: favoriler.map(fav => fav.part_number),
                watchlistPartNumbers: takipEdilenler.map(watch => watch.part_number),
                data: {} // Daha fazla veri gerektiğinde eklenebilir
            });
        });
    });
});


// profil bilgisi güncelleme bölümü
router.post('/update-profile', (req, res) => {
    const { first_name, last_name, email, phone_number } = req.body;
    const userId = req.session.user.id;

    // db sorgusu
    db.query('UPDATE users SET first_name = ?, last_name = ?, email = ?, phone_number = ? WHERE id = ?', 
    [first_name, last_name, email, phone_number, userId], (err, result) => {
        if (err) {
            console.error(err);
            return res.send('Profil güncellenirken bir hata oluştu.');
        }

        //güncelleme
        req.session.user.first_name = first_name;
        req.session.user.last_name = last_name;
        req.session.user.email = email;
        req.session.user.phone_number = phone_number;

        res.send('Profil başarıyla güncellendi.');
    });
});

// Mail gönderme rotası
router.post('/send-bom-email', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login'); // Kullanıcı oturum açmamışsa giriş sayfasına yönlendir
    }

    const userEmail = req.session.user.email; // Oturum açmış kullanıcının email adresi

    // Frontend'den gelen bomDetails, totalPrice ve maxLeadTime bilgilerini alıyoruz
    let bomDetails;
    try {
        bomDetails = JSON.parse(req.body.bomDetails); // bomDetails'i JSON formatına çeviriyoruz
    } catch (error) {
        return res.status(400).send('BOM detayları işlenemedi.');
    }

    const { totalPrice, maxLeadTime } = req.body;

    // Nodemailer transporter yapılandırması
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: 'apitronic06@gmail.com',
            pass: 'ivax fqrd gdiu jioz'  // Gmail uygulama şifreniz
        }
    });

    // HTML içeriğini oluştur
    const mailContent = `
        <h3>BOM Detayları</h3>
        <table border="1" cellpadding="5" cellspacing="0">
            <thead>
                <tr>
                    <th>Üretici Parça Numarası</th>
                    <th>Üretici</th>
                    <th>Adet</th>
                    <th>Stok</th>
                    <th>Birim Fiyat</th>
                    <th>Toplam</th>
                    <th>Önerilen Tedarikçi</th>
                </tr>
            </thead>
            <tbody>
            ${bomDetails.map(detail => `
                <tr>
                    <td>${detail.partNumber}</td>
                    <td>${detail.selectedResult && detail.selectedResult.manufacturer ? detail.selectedResult.manufacturer : 'Bilgi yok'}</td>
                    <td>${detail.selectedResult && detail.selectedResult.quantity ? detail.selectedResult.quantity : 'Bilgi yok'}</td>
                    <td>${detail.selectedResult && detail.selectedResult.stock ? detail.selectedResult.stock : 'N/A'}</td>
                    <td>${detail.selectedResult && detail.selectedResult.unitPrice ? detail.selectedResult.unitPrice : 'N/A'}</td>
                    <td>${detail.selectedResult && detail.selectedResult.totalPrice ? detail.selectedResult.totalPrice : 'N/A'}</td>
                    <td>${detail.recommendedSupplier || 'N/A'}</td>
                </tr>
            `).join('')}
            
            </tbody>
        </table>

        <p><strong>Toplam Fiyat:</strong> $${totalPrice}</p>
        <p><strong>En Uzun Teslimat Süresi:</strong> ${maxLeadTime} gün</p>
    `;

    // Mail içeriği
    const mailOptions = {
        from: '"APItronic" <apitronic06@gmail.com>',
        to: userEmail,
        subject: 'BOM Detayları ve Toplam Fiyat Bilgisi',
        html: mailContent
    };

    // Mail gönderme
    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.log(error);
            return res.status(500).send('Mail gönderilirken bir hata oluştu.');
        }
        console.log('Email gönderildi: ' + info.response);
        res.send('Mail başarıyla gönderildi.');
    });
});



// Şifreyi güncelleme
router.post('/update-password', (req, res) => {
    const { current_password, new_password } = req.body;
    const userId = req.session.user.id;

    // Mevcut şifreyi doğrula
    db.query('SELECT password FROM users WHERE id = ?', [userId], (err, results) => {
        if (err || results.length === 0) {
            console.error(err);
            return res.send('Bir hata oluştu.');
        }

        const hashedPassword = results[0].password;

        bcrypt.compare(current_password, hashedPassword, (err, isMatch) => {
            if (err || !isMatch) {
                return res.send('Mevcut şifre yanlış.');
            }

            // Yeni şifreyi hashle ve güncelle
            bcrypt.hash(new_password, 10, (err, hash) => {
                if (err) {
                    console.error(err);
                    return res.send('Şifre güncellenirken bir hata oluştu.');
                }

                db.query('UPDATE users SET password = ? WHERE id = ?', [hash, userId], (err, result) => {
                    if (err) {
                        console.error(err);
                        return res.send('Şifre güncellenirken bir hata oluştu.');
                    }

                    res.send('Şifre başarıyla güncellendi.');
                });
            });
        });
    });
});

// Dosya silme rotası
router.delete('/delete-file/:id', async (req, res) => {
    const fileId = req.params.id;

    try {
        // Transaction başlatmadan, tek tek query'leri çalıştır
        await db.promise().query('DELETE FROM bom_parts WHERE bom_id = ?', [fileId]);
        await db.promise().query('DELETE FROM bom_risk_alerts WHERE bom_id = ?', [fileId]);
        await db.promise().query('DELETE FROM orders WHERE bom_id = ?', [fileId]);

        // Son olarak bom_files kaydını sil
        const [result] = await db.promise().query('DELETE FROM bom_files WHERE id = ?', [fileId]);

        if (result.affectedRows === 0) {
            return res.status(404).send('Dosya bulunamadı.');
        }

        // İşlem başarılı, silme işlemi tamamlandı
        res.status(200).send('Dosya ve ilişkili veriler başarıyla silindi.');
    } catch (error) {
        console.error('Hata oluştu:', error);
        res.status(500).send('Dosya silinirken bir hata oluştu.');
    }
});

// Favorilere ekleme
router.post('/add-to-favorites', (req, res) => {
   
    const { partNumber } = req.body;
    const userId = req.session.user.id; // Oturum açmış kullanıcının ID'sini alın
    
    db.query('INSERT INTO favorites (user_id, part_number) VALUES (?, ?)', [userId, partNumber], (err) => {
        if (err) {
            console.error('Favorilere eklerken hata:', err);
            return res.json({ success: false });
        }
        return res.json({ success: true });
    });
});

// Favorilerden çıkarma
router.post('/remove-from-favorites', (req, res) => {
    const { partNumber } = req.body;
    const userId = req.session.user.id;
    
    db.query('DELETE FROM favorites WHERE user_id = ? AND part_number = ?', [userId, partNumber], (err) => {
        if (err) {
            console.error('Favorilerden çıkarırken hata:', err);
            return res.json({ success: false });
        }
        return res.json({ success: true });
    });
});

// Takip listesine ekleme
router.post('/add-to-watchlist', (req, res) => {
    const { partNumber } = req.body;
    const userId = req.session.user.id;

    db.query('INSERT INTO watchlist (user_id, part_number) VALUES (?, ?)', [userId, partNumber], (err) => {
        if (err) {
            console.error('Takip listesine eklerken hata:', err);
            return res.json({ success: false });
        }
        return res.json({ success: true });
    });
});

// Takip listesinden çıkarma
router.post('/remove-from-watchlist', (req, res) => {
    const { partNumber } = req.body;
    const userId = req.session.user.id;

    db.query('DELETE FROM watchlist WHERE user_id = ? AND part_number = ?', [userId, partNumber], (err) => {
        if (err) {
            console.error('Takip listesinden çıkarırken hata:', err);
            return res.json({ success: false });
        }
        return res.json({ success: true });
    });
});

function formatStock(stock) {
    return stock ? `${stock.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} in stock` : 'Stok Bilgisi Yok';
}

function formatLeadTime(weeks) {
    return weeks ? `${weeks * 7} gün` : 'Lead Time Bilgisi Yok'; // Haftayı gün'e çeviriyoruz
}
// Favori ürünü silme rotası
router.post('/delete-from-favorites', (req, res) => {
    const { partNumber } = req.body;
    const userId = req.session.user.id;

    db.query('DELETE FROM favorites WHERE user_id = ? AND part_number = ?', [userId, partNumber], (err, result) => {
        if (err) {
            console.error('Favorilerden silme hatası:', err);
            return res.status(500).send('Favori silinirken bir hata oluştu.');
        }
        res.status(200).send({ success: true });
    });
});

// Takip listesinden ürünü silme rotası
router.post('/delete-from-watchlist', (req, res) => {
    const { partNumber } = req.body;
    const userId = req.session.user.id;

    db.query('DELETE FROM watchlist WHERE user_id = ? AND part_number = ?', [userId, partNumber], (err, result) => {
        if (err) {
            console.error('Takip listesinden silme hatası:', err);
            return res.status(500).send('Takip listesinden silinirken bir hata oluştu.');
        }
        res.status(200).send({ success: true });
    });
});



// Geçersiz URL'ler için 404 middleware
router.use((req, res, next) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

module.exports = { router,
    checkForUpdates,
    updateBom,
    getDigiKeyResults,
    getMouserResults,
    updatePartInDatabase,
    selectBestSupplier,
    updateBomFile 
};  // checkForUpdates cron ile birlikte çalışır
