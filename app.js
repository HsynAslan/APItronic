const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
const cron = require('node-cron');  // cron modülünü ekleyin
const { router: userRoutes, checkForUpdates } = require('./routes/user');  // user.js dosyasından router ve checkForUpdates fonksiyonunu alın
const odooRoutes = require('./routes/odoo');
const app = express();

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

// Odoo route'larını kullan
app.use('/odoo', odooRoutes);

const port = 3000;
// Body parser ayarı
app.use(bodyParser.urlencoded({ extended: true }));

// EJS şablon motoru ayarı
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Statik dosyalar için
app.use(express.static(path.join(__dirname, 'public')));


// Oturum yönetimi ayarı
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
}));

// Yönlendirmeleri kullan
app.use(userRoutes);

// Cron job'u başlat
cron.schedule('* * * * *', () => {
    console.log('Zamanı gelen BOM dosyaları kontrol ediliyor...');
    checkForUpdates();  // Zamanı gelen BOM dosyalarını kontrol et
});

// Sunucuyu başlat
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
