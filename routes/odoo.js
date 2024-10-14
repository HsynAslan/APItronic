const express = require('express');
const xmlrpc = require('xmlrpc');
const router = express.Router();

// Odoo bağlantı bilgileri
const odooUrl = 'http://your_odoo_url'; // Odoo sunucu URL'niz
const odooDb = 'your_db_name'; // Odoo veritabanı adı
const odooUsername = 'your_username'; // Odoo kullanıcı adı
const odooPassword = 'your_password'; // Odoo şifresi

// Odoo'ya bağlanarak kimlik doğrulama
const authenticate = (callback) => {
    const common = xmlrpc.createClient({ url: `${odooUrl}/xmlrpc/2/common` });
    common.methodCall('authenticate', [odooDb, odooUsername, odooPassword, {}], (err, uid) => {
        if (err) {
            console.error('Odoo Kimlik doğrulama başarısız:', err);
            callback(err, null);
        } else {
            console.log('Odoo Kimlik doğrulama başarılı! User ID:', uid);
            callback(null, uid);
        }
    });
};

// Odoo'dan BOM verilerini çekme
const fetchBomFromOdoo = (uid, callback) => {
    const models = xmlrpc.createClient({ url: `${odooUrl}/xmlrpc/2/object` });
    
    models.methodCall('execute_kw', [
        odooDb, uid, odooPassword,
        'mrp.bom', 'search_read',  // Odoo'daki mrp.bom modelini sorguluyoruz
        [[['active', '=', true]]], // Aktif olan BOM dosyalarını alıyoruz
        { fields: ['id', 'product_tmpl_id', 'product_qty'], limit: 5 }
    ], (err, bomRecords) => {
        if (err) {
            console.error('BOM verileri alınamadı:', err);
            callback(err, null);
        } else {
            console.log('BOM kayıtları alındı:', bomRecords);
            callback(null, bomRecords);
        }
    });
};

// BOM dosyalarını almak için route
router.get('/fetch-boms', (req, res) => {
    authenticate((authErr, uid) => {
        if (authErr) {
            return res.status(500).send('Kimlik doğrulama hatası.');
        }
        fetchBomFromOdoo(uid, (fetchErr, boms) => {
            if (fetchErr) {
                return res.status(500).send('BOM verileri alınamadı.');
            }
            res.json(boms); // BOM dosyalarını JSON olarak döndür
        });
    });
});

module.exports = router;
