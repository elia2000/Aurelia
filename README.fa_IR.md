[English](/README.md) | [فارسی](/README.fa_IR.md)

<div align="center">

# <img src="./client/src/assets/aurelle-logo.svg" alt="Aurelle" width="40"> Aurelle

[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)

**پیام‌رسان خصوصی و self-hosted با تماس رمزنگاری‌شده‌ی سرتاسری و پیام‌های ویدیویی گرد.**

</div>

Aurelle یک فورک از [Songbird](https://github.com/bllackbull/Songbird) (با لایسنس MIT) است که تماس صوتی و تصویری با رمزنگاری سرتاسری و پیام‌های ویدیویی گرد به سبک تلگرام را اضافه می‌کند و با هدف مصرف کم باتری و اینترنت موبایل ساخته شده است. نام آن از واژه‌ی لاتین *aurum* به معنی طلا گرفته شده است.

## قابلیت‌های کلیدی

- 📞 **تماس رمزنگاری‌شده**: تماس صوتی و تصویری یک‌به‌یک با رمزنگاری سرتاسری، همتا به همتا، با کد اموجی تأیید و شماره‌ی ایمنی و اشتراک‌گذاری صفحه
- ⭕ **پیام ویدیویی گرد**: ضبط تا ۶۰ ثانیه که روی دستگاه خودتان رمز می‌شود؛ گیرنده فقط هنگام پخش دانلود و رمزگشایی می‌کند
- 🔋 **سبک برای باتری و اینترنت**: Opus با DTX و ۲۴ کیلوبیت، کدک‌های سازگار با سخت‌افزار، ویدیوی تطبیقی که به صدا-فقط برمی‌گردد و آزاد کردن دوربین در پس‌زمینه
- 🛡️ **گزینه‌ی امنیت بالا**: عبور همه‌ی تماس‌ها از رله‌ی خودتان تا طرفین آدرس IP یکدیگر را نفهمند
- 💬 **انواع چت**: پیام مستقیم، گروه و کانال
- 😀 **پیام‌رسانی به سبک تلگرام**: واکنش با ایموجی، سنجاق کردن پیام‌ها و گفتگوها، انتخاب چند پیام برای ارسال، کپی یا حذف، مجموعه‌ی خصوصی GIFهای ذخیره‌شده، و ورودی‌های تماس با دکمه‌ی تماس دوباره
- 📁 **پشتیبانی از رسانه**: آپلود فایل، پیام صوتی، تبدیل ویدئو
- 🔔 **Push Notification**: اعلان وب با VAPID (برای تماس ورودی هم)
- 📡 **کانال‌های ریموت**: آینه‌کردن کانال‌های Telegram یا Aurelle
- 🛡️ **پنل مدیریت**: رابط مدیریتی کامل با نقش مالک
- 🔒 **امنیت**: رمزنگاری در حالت ذخیره، هش bcrypt، محدودیت نرخ
- 📱 **PWA**: اپلیکیشن وب نصب‌شدنی
- ☁️ **نصب ابری**: نصب به صورت PaaS و CaaS با پشتیبانی از فضای ابری
- 🌍 **چندزبانه**: پشتیبانی از انگلیسی و فارسی

## چه چیزی رمزنگاری سرتاسری می‌شود

| | رمزنگاری سرتاسری |
|---|---|
| صدا و تصویر تماس | ✅ |
| سیگنالینگ تماس (SDP و ICE) | ✅ |
| پیام‌های ویدیویی گرد (و پیش‌نمایش آن‌ها) | ✅ |
| پیام‌های متنی، پیام‌های صوتی، فایل‌ها | ❌ (روی سرور در حالت ذخیره رمز می‌شوند) |

سرور همچنان فراداده را می‌بیند (چه کسی با چه کسی، چه زمانی، حجم‌ها). پیش از تکیه بر آن، [مدل تهدید](docs/fa/E2EE-Protocol.md#threat-model) را بخوانید: مانند هر رمزنگاری سرتاسری مبتنی بر مرورگر، کد توسط سرور تحویل داده می‌شود؛ پس شماره‌های ایمنی را با افرادی که برایتان مهم هستند تأیید کنید.

## نصب سریع

**فقط با یک دستور** روی سرور Ubuntu/Debian (با کاربر root یا کاربری که `sudo` دارد). همه‌چیز را نصب می‌کند، Aurelle را از شاخه‌ی `main` همین مخزن می‌سازد و سرویس‌ها را راه می‌اندازد:

```bash
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | bash
```

این دستور یک منو باز می‌کند و فرمان `songbird-deploy` را نصب می‌کند؛ برای به‌روزرسانی بعداً `songbird-deploy` را اجرا و گزینه‌ی *Update Aurelle* را انتخاب کنید. برای اینکه اسکریپت چه می‌کند و چه گزینه‌هایی دارد، [اسکریپت نصب](docs/fa/Deployment-Script.md) را ببینید.

بدون ترمینال (cloud-init، CI، `ssh host '...'`) یا وقتی نمی‌خواهید چیزی پرسیده شود، آن را بدون پرسش اجرا کنید. بدون دامنه سرویس روی IP سرور با HTTP بالا می‌آید؛ با دامنه گواهی Let's Encrypt می‌گیرد. برای تماس صوتی و تصویری به‌طور پیش‌فرض رله (coturn) نصب می‌شود؛ پورت‌های `80`، `443`، `3478` (TCP و UDP) و `49160-49260` (UDP) را در فایروال ارائه‌دهنده باز کنید. برای به‌روزرسانی همان دستور را دوباره اجرا کنید.

```bash
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | sudo env AURELLE_YES=1 AURELLE_DOMAIN=chat.example.com AURELLE_EMAIL=you@example.com bash
```

همه‌ی گزینه‌ها (متغیرهای `AURELLE_*`، `--yes`، رله‌ی تماس، پورت‌های فایروال، به‌روزرسانی): [اسکریپت نصب](docs/fa/Deployment-Script.md).

یا خودتان با Docker بسازید:

```bash
git clone https://github.com/elia2000/Aurelia.git
cd Aurelia
cp .env.example .env
bash scripts/gen-certs.sh    # گواهی TLS خودامضا برای آزمایش -> certs/cert.pem و certs/key.pem
docker compose up -d --build
```

nginx همراه پروژه پیش از اجرا به فایل‌های `certs/cert.pem` و `certs/key.pem` نیاز دارد (اگر وجود نداشته باشند، Docker به‌جای آن‌ها پوشه‌های خالی با همین نام می‌سازد و nginx مدام از کار می‌افتد و دوباره راه‌اندازی می‌شود). دستور `scripts/gen-certs.sh` یک جفت گواهی و کلید خودامضا برای آزمایش می‌سازد؛ برای اینکه دامنه یا IP شما را هم پوشش دهد، آن را به‌عنوان آرگومان بدهید (`bash scripts/gen-certs.sh example.com`). مرورگرها هشدار امنیتی نشان می‌دهند و push notification با این گواهی کار نمی‌کند؛ پس برای استفاده‌ی واقعی یک گواهی معتبر نصب کنید؛ راهنمای [گواهی‌نامه‌های SSL](docs/fa/SSL-Certificates.md) را ببینید.

> [!TIP]
> داشتن یک دامنه که به IP عمومی سرور شما اشاره کند پیشنهاد می‌شود. برای تماس، پیام ویدیویی و push notification **به HTTPS نیاز دارید** (به‌جز روی `localhost`).

برای تماس بین شبکه‌های مختلف، رله‌ی همراه پروژه را فعال کنید: پس از تنظیم `CALLS_TURN_SECRET`، `CALLS_TURN_URLS` و `CALLS_TURN_EXTERNAL_IP` در `.env` دستور `docker compose --profile calls up -d` را اجرا کنید. [تماس‌ها و پیام‌های ویدیویی](docs/fa/Calls-and-Video-Messages.md) را ببینید.

> [!NOTE]
> نام‌های داخلی (سرویس Docker با نام `songbird`، دستور `songbird-deploy`، فایل `songbird.db` و کلیدهای cookie و storage) از پروژه‌ی اصلی حفظ شده‌اند تا نصب‌های موجود به کار خود ادامه دهند.

## مستندات

مستندات در پوشه‌ی [`docs/`](docs/) قرار دارد (VitePress، انگلیسی و فارسی). برای مرور محلی `npm run docs:dev` را اجرا کنید.

- [تماس‌ها و پیام‌های ویدیویی](docs/fa/Calls-and-Video-Messages.md)
- [منوی پیام](docs/fa/Message-Menu.md)، [واکنش‌ها](docs/fa/Reactions.md)، [انتخاب پیام‌ها](docs/fa/Selecting-Messages.md)، [پیام‌ها و گفتگوهای سنجاق‌شده](docs/fa/Pinned-Messages-and-Chats.md)، [گیف‌ها](docs/fa/Saved-GIFs.md)
- [پروتکل رمزنگاری سرتاسری](docs/fa/E2EE-Protocol.md) (برای توسعه‌دهندگان اپلیکیشن بومی)
- [اسکریپت نصب](docs/fa/Deployment-Script.md)
- [نصب از طریق Docker](docs/fa/Installation-Docker.md)
- [نصب ابری](docs/fa/Cloud-Deployment.md)
- [نصب دستی](docs/fa/Manual-Installation.md)
- [کانفیگ Nginx](docs/fa/Nginx-Configuration.md)
- [گواهی‌های SSL](docs/fa/SSL-Certificates.md)
- [متغیرهای محیطی](docs/fa/Environment-Variables.md)
- [فضای ابری](docs/fa/Object-Storage.md)
- [ورکر مدیا](docs/fa/Media-Worker.md)
- [پنل مدیریت](docs/fa/Admin-Panel.md)
- [عیب‌یابی](docs/fa/Troubleshooting.md)

## قدردانی

Aurelle بر پایه‌ی [Songbird](https://github.com/bllackbull/Songbird) ساخته‌ی [@bllackbull](https://github.com/bllackbull) و مشارکت‌کنندگان آن ([@nkhalili](https://github.com/nkhalili)، [@modos](https://github.com/modos)، [@iPmartNetwork](https://github.com/iPmartNetwork)) است و تحت لایسنس MIT منتشر می‌شود. اعلان کپی‌رایت آن‌ها در [LICENSE](LICENSE) حفظ شده است.

## مشارکت

issue و pull request خوش‌آمد است. [Contributing](/CONTRIBUTING.md) را ببینید.

## لایسنس

این پروژه تحت لایسنس MIT منتشر شده است. برای جزئیات بیشتر، فایل [LICENSE](LICENSE) را ببینید.

### تصاویر ایموجی

انتخابگر ایموجی و ایموجی‌های پیام‌ها با تصاویری به سبک Apple از بسته‌ی [`emoji-datasource-apple`](https://www.npmjs.com/package/emoji-datasource-apple) کشیده می‌شوند. کد و داده‌های این بسته با لایسنس MIT است، اما خود تصاویر اثر هنری Apple هستند. این تصاویر **در این مخزن ذخیره نشده‌اند**: `npm ci` آن‌ها را دانلود می‌کند و بیلد کلاینت آن‌ها را در `client/dist/emoji/` کپی می‌کند. اگر سرویس عمومی اجرا می‌کنید، بررسی کنید که این استفاده برای شما مجاز باشد. برای نداشتن آن‌ها، `emoji-datasource-apple` را از `client/package.json` حذف کنید: ایموجی‌ها به ایموجی خود دستگاه برمی‌گردند (انتخابگر به این بسته نیاز دارد و پیام «ایموجی بارگذاری نشد» نشان می‌دهد).
