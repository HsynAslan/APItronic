const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
const userRoutes = require('./routes/user'); // user.js dosyasını dahil et


const app = express();

app.use(bodyParser.json({ limit: '10mb' }));  // JSON verisi için limit
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));  // URL-encoded verisi için limit
app.use(express.static('public'));

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

// Sunucuyu başlat
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});