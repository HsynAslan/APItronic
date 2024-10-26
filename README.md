
# 🌐 Apitronic Project

📊 **Apitronic** – Elektronik parça bilgilerini dört farklı API’den (DigiKey, Arrow, Mouser, Avnet) çekerek en uygun fiyatları ve teslimat sürelerini analiz eden bir yazılım projesi. Bu sistem, kullanıcıların BOM dosyalarını periyodik güncellemelerle yönetmesine, fiyat ve stok bilgilerini takip etmesine ve gerekli durumlarda bildirimler almasına olanak tanır.

## 🚀 Özellikler

- **API Entegrasyonu** 🤖: Farklı API’lerden fiyat, stok ve teslimat bilgilerini toplayarak karşılaştırır.
- **BOM Yönetimi** 📋: Kullanıcılar, yükledikleri BOM dosyalarını yönetebilir ve her parça için güncel veriler alabilir.
- **FIFO Destekli Takip** 🔄: Her parçanın en güncel 5 fiyat ve teslimat süresi bilgisi saklanır, eski veriler düzenli olarak güncellenir.
- **Bildirim Sistemi** ✉️: Fiyat veya teslimat süresi değişikliği kullanıcıya otomatik olarak bildirilir.
- **Periyodik Güncelleme** ⏰: Kullanıcıların belirlediği aralıklarda API güncellemeleri yapılır.
- **Otomatik Sorgu Sıralaması** 🕰️: Sorgular FIFO mantığıyla işlenir, performansı artırır.

## 🛠️ Kurulum

1. Bu projeyi klonlayın:
   ```bash
   git clone https://github.com/kullanici-adi/Apitronic.git
   ```

2. Gerekli bağımlılıkları yükleyin:
   ```bash
   npm install
   ```

3. `.env` dosyasını API anahtarlarınız ve veritabanı bilgileriyle yapılandırın.

4. SQL dosyasını çalıştırarak veritabanı tablolarını oluşturun.

5. Uygulamayı başlatın:
   ```bash
   npm start
   ```

## 💡 Kullanım

- **BOM Dosyası Ekleme**: 📥 Kullanıcılar BOM dosyalarını yükleyebilir ve parça bilgilerini analiz edebilir.
- **Güncelleme Ayarları**: ⏳ Güncellemeler için başlangıç zamanı ve periyot seçme.
- **Fiyat ve Süre Analizi**: 📈 Parçaların geçmiş fiyat ve teslimat süreleri görselleştirilir.
- **Bildirimler** 🔔: Fiyat düşüşü veya teslimat süresi kısalması gibi değişikliklerde e-posta bildirimi.

## 🛠️ Kullanılan Teknolojiler

- **Backend**: Node.js, Express.js, bcrypt, JSON Web Tokens
- **Veritabanı**: MySQL
- **Frontend**: EJS, CSS, HTML, Font Awesome
- **API'ler**: DigiKey, Arrow, Mouser, Avnet
- **Diğer**: Nodemailer, dotenv

## 🤝 Katkıda Bulunma

Katkı sağlamak için bir pull request açın veya projeye eklemek istediğiniz özellikleri tartışmak üzere bir issue oluşturun. 

## 📝 Lisans

Bu proje MIT Lisansı ile lisanslanmıştır.
