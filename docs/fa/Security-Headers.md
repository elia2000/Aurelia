# هدرهای امنیتی

Aurelle هدرهای امنیتی مرورگر را **خودش** و از سرور Node می‌فرستد. برای همین در همهٔ انواع نصب (Docker، دستی، اسکریپت نصب با Nginx، Railway/Render) یکسان است و لازم **نیست** چیزی به پیکربندی Nginx یا CDN خود اضافه کنید.

مهم‌ترین آن‌ها **Content-Security-Policy (CSP)** است: فهرستی که همراه هر صفحه فرستاده می‌شود و می‌گوید صفحه اجازه دارد اسکریپت، استایل، تصویر، رسانه و اتصال را از کجا بگیرد. اگر مهاجمی روزی بتواند تکه‌ای اسکریپت را داخل صفحه جا بدهد (مثلاً از راه یک باگ در نمایش پیام‌ها)، یک سیاست سخت‌گیرانه مانع می‌شود که مرورگر آن را اجرا کند یا داده‌های شما را جایی بفرستد.

## چه چیزهایی فرستاده می‌شود

| هدر | مقدار | دلیل |
|---|---|---|
| `Content-Security-Policy` | [سیاست](#the-content-security-policy) را ببینید | اسکریپت تزریق‌شده، قرار دادن در فریم، ربودن فرم‌ها و خروج داده به سایت‌های دیگر را مسدود می‌کند. |
| `X-Content-Type-Options` | `nosniff` | مرورگر باید به `Content-Type` پاسخ اعتماد کند (یک فایل آپلودشده هرگز «حدس زده» نمی‌شود که اسکریپت است). |
| `X-Frame-Options` | `DENY` | هیچ‌کس نمی‌تواند Aurelle را داخل فریم بگذارد (click-jacking). برای مرورگرهای قدیمی‌تر، معادل `frame-ancestors 'none'`. |
| `Referrer-Policy` | `no-referrer` | هیچ درخواست پیوند یا تصویری به سایت دیگر نمی‌گوید از کدام صفحه آمده‌اید. |
| `Cross-Origin-Opener-Policy` | `same-origin` | پنجره‌ای که سایت دیگری باز کرده به پنجرهٔ Aurelle دسترسی پیدا نمی‌کند. |
| `Cross-Origin-Resource-Policy` | `same-origin` | سایت‌های دیگر نمی‌توانند پاسخ‌های API، آپلودها یا آواتارهای Aurelle را در خود جاسازی کنند. |
| `Permissions-Policy` | دوربین، میکروفون، ضبط صفحه‌نمایش، تصویر در تصویر، تمام‌صفحه، پخش خودکار و جلوگیری از خاموش‌شدن صفحه فقط برای خود صفحه؛ موقعیت مکانی، پرداخت، USB، serial، HID، MIDI، حسگرهای حرکتی، topics و idle detection **خاموش** | تماس و ضبط به گروه اول نیاز دارند؛ هیچ بخشی به گروه دوم نیاز ندارد. |
| `Strict-Transport-Security` | `max-age=15552000` (۱۸۰ روز) | **فقط روی درخواست HTTPS.** مرورگر از آن به بعد HTTP ساده را برای این سایت نمی‌پذیرد. بدون `includeSubDomains` و بدون `preload`: این دو روی سایت‌های دیگر دامنهٔ شما اثر می‌گذارند و سریع قابل بازگشت نیستند، پس تصمیمشان با خود شماست. |

Aurelle دیگر `X-Powered-By: Express` را هم اعلام نمی‌کند.

:::info تشخیص HTTPS

«درخواست HTTPS» یعنی خود اتصال TLS است **یا** پراکسی معکوس شما `X-Forwarded-Proto: https` فرستاده است (پیکربندی‌های Nginx در این مستندات و اسکریپت نصب این کار را می‌کنند). پشت پراکسی‌ای که آن را نمی‌فرستد، Aurelle درخواست را HTTP ساده می‌بیند و HSTS و `upgrade-insecure-requests` نمی‌فرستد؛ بقیهٔ سیاست تغییری نمی‌کند.

:::

## سیاست Content-Security-Policy {#the-content-security-policy}

سیاست برای صفحه‌ای که روی `https://chat.example.com` ارائه می‌شود:

```txt
default-src 'self';
script-src 'self';
script-src-attr 'none';
style-src 'self';
img-src 'self' data: blob:;
media-src 'self' blob:;
font-src 'self';
connect-src 'self' wss://chat.example.com https://api.github.com;
worker-src 'self';
manifest-src 'self';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

| دستور | معنی |
|---|---|
| `script-src 'self'` | فقط فایل‌های اسکریپت خود Aurelle. **بدون `'unsafe-inline'`، بدون `'unsafe-eval'`، بدون hash.** تنها اسکریپت کوچکی که قبلاً داخل `index.html` بود (قبل از اولین نقاشی صفحه تم تیره را می‌گذارد تا کاربر تم تیره سفیدی ناگهانی نبیند) حالا فایل `/theme-init.js` است. |
| `style-src 'self'` | فقط همان یک فایل استایل ساخته‌شده. **بدون `<style>` درون‌خطی و بدون صفت `style="..."` در HTML.** رابط Aurelle استایل‌های پویای خود را از داخل اسکریپت و با شیء style مرورگر (`element.style.x = ...`) تنظیم می‌کند که CSP محدودش نمی‌کند؛ پس هرگز به `'unsafe-inline'` نیاز نبود. |
| `img-src 'self' data: blob:` | تصاویر از خود Aurelle (آپلودها، آواتارها، تصاویر ایموجی، تصاویر پیش‌نمایش پیوند که سرور خودتان می‌دهد)، `data:` و `blob:` (پیش‌نمایش فایل پیش از ارسال، پیام ویدیویی ضبط‌شده). |
| `media-src 'self' blob:` | صدا و ویدیو از Aurelle و ضبط‌های محلی. |
| `font-src 'self'` | فونت‌ها فایل‌های خود Aurelle هستند. |
| `connect-src` | API خود Aurelle، اتصال زنده (`wss://` برای همین میزبان؛ Safari قدیمی آن را «self» حساب نمی‌کند) و `https://api.github.com` که فقط برای یک کار است: دکمهٔ **Check for updates** در پنل مدیریت از مرورگر مدیر، تازه‌ترین نسخه را از GitHub می‌پرسد. |
| `worker-src 'self'` | service worker (`/sw.js`). برنامه worker دیگری راه نمی‌اندازد. |
| `manifest-src 'self'` | manifest برنامهٔ وب. |
| `frame-src 'none'`، `object-src 'none'` | برنامه چیزی را جاسازی نمی‌کند. |
| `base-uri 'none'` | یک تگ `<base>` تزریق‌شده نمی‌تواند پیوندهای نسبی را منحرف کند. |
| `form-action 'self'` | فرم فقط به Aurelle ارسال می‌شود. |
| `frame-ancestors 'none'` | هیچ سایتی نمی‌تواند Aurelle را در فریم بگذارد. |
| `upgrade-insecure-requests` | **فقط روی HTTPS.** هر زیرمنبع `http://` سرگردان به‌جای آن با HTTPS گرفته می‌شود. |

تماس‌ها به ورودی نیاز ندارند: رسانهٔ WebRTC به رلهٔ TURN و همتاها می‌رود و خارج از CSP است، و راه‌اندازی تماس از API معمولی می‌گذرد.

پاسخ‌هایی که خود Express برای خطا می‌سازد (یک 404 ساده یا 400 برای JSON خراب) به‌جای آن `default-src 'none'` خود Express را دارند که حتی سخت‌گیرانه‌تر است؛ بقیهٔ هدرهای امنیتی همچنان هستند.

## `CSP_MODE`: اجرا، فقط گزارش، خاموش

| مقدار | چه می‌شود |
|---|---|
| `enforce` | سیاست اجرا می‌شود. **پیش‌فرض وقتی `APP_ENV=production`** (که پیش‌فرض خود `APP_ENV` است). |
| `report-only` | چیزی مسدود نمی‌شود. Aurelle همان سیاست را با هدر `Content-Security-Policy-Report-Only` می‌فرستد و مرورگر هر تخلف را در کنسول خود می‌نویسد (*DevTools → Console*، «[Report Only] Refused to ...»). |
| `off` | هیچ هدر CSP نیست. پیش‌فرض وقتی `APP_ENV` چیزی جز `production` باشد (سرور توسعهٔ Vite و تست‌ها از سیاست اثر نمی‌گیرند). |

آن را در `.env` (یا محیط کانتینر) بگذارید و **ری‌استارت** کنید:

```bash
CSP_MODE=report-only
```

```bash
# نصب با systemd
sudo systemctl restart songbird
# Docker
docker compose -f docker-compose.yaml up -d
```

`enforce` پیش‌فرض است چون سیاست حاصل آزمودن کل برنامه با فعال بودن آن است (گفتگو، نوار پیام، پیام صوتی و ویدیویی، تماس و اشتراک صفحه‌نمایش، ایموجی، GIF، پیش‌نمایش پیوند، آپلود، آواتار، service worker، پنل مدیریت و بنر نصب هیچ تخلفی ثبت نکردند). `report-only` و `off` راه نجات‌اند: اگر معلوم شد استقرار شما به چیزی نیاز دارد که سیاست اجازه نمی‌دهد، در یک دقیقه صفحه را برمی‌گردانید و بعداً علت را درست می‌کنید. بقیهٔ هدرها به `CSP_MODE` وابسته نیستند.

مقداری که یکی از این سه نباشد با یک هشدار در لاگ سرور نادیده گرفته می‌شود و پیش‌فرض به کار می‌رود.

## ذخیره‌سازی ابری و CDN {#object-storage-and-cdn-setups}

وقتی `STORAGE_DRIVER=remote` است، **مرورگر** مستقیم با باکت حرف می‌زند: آپلود `PUT` با آدرس presigned، و دانلود، تصویر و ویدیو از آدرس presigned یا از CDN شما. پس سیاست باید این origin ها را در `img-src`، `media-src` و `connect-src` مجاز کند. Aurelle آن‌ها را از تنظیمات شما خودش حساب می‌کند و چیزی لازم نیست اضافه کنید:

| تنظیم | origin اضافه‌شده |
|---|---|
| `STORAGE_ENDPOINT` | origin آن، مثلاً `https://<account>.r2.cloudflarestorage.com` |
| `STORAGE_ENDPOINT` با `STORAGE_FORCE_PATH_STYLE=false` و یک `STORAGE_BUCKET` | همچنین `https://<bucket>.<میزبان endpoint>` (سبک virtual-hosted) |
| بدون `STORAGE_ENDPOINT`، با `STORAGE_BUCKET` و یک `STORAGE_REGION` واقعی | میزبان‌های AWS برای آن منطقه |
| `STORAGE_PUBLIC_URL` (یک CDN یا دامنهٔ اختصاصی) | origin آن، مثلاً `https://media.example.com` |

برای هر چیز دیگر (میزبان دوم CDN، فایل‌هایی که روی دامنه‌ای غیر از `STORAGE_PUBLIC_URL` هستند، باکتی که با ریدایرکت به میزبان دیگری جواب می‌دهد) origin ها را در `CSP_EXTRA_SOURCES` بنویسید، **با ویرگول جدا شده**:

```bash
CSP_EXTRA_SOURCES=https://cdn.example.com,https://*.r2.dev
```

قواعد، که هنگام شروع سرور اعمال می‌شوند:

- هر مورد به شکل `scheme://host` با `:port` اختیاری است و scheme یکی از `https`، `http`، `wss` یا `ws`. `https://*.example.com` (یک برچسب wildcard در ابتدا) مجاز است.
- **موردها را با ویرگول جدا کنید.** موردی که فاصله، نقطه‌ویرگول، نقل‌قول، خط جدید یا مسیر (`https://cdn.example.com/media`) داشته باشد، یک `*` تنها، یک scheme تنها مثل `https:` یا `data:`، یا میزبانی بدون scheme **نادیده گرفته می‌شود** و سرور `CSP_EXTRA_SOURCES: ignored ...` را در لاگ می‌نویسد. این کار جلوی آن را می‌گیرد که یک غلط تایپی یا مقدار کپی‌شده، دستور یا کلیدواژه‌ای مثل `'unsafe-inline'` را به سیاست اضافه کند.
- منبع‌ها فقط به `img-src`، `media-src` و `connect-src` اضافه می‌شوند. اسکریپت، استایل، فونت، فریم و فرم قابل گسترش نیستند.

باکت باید در قواعد **CORS** خودش سایت شما را هم مجاز کند؛ این جدا از CSP است، [ذخیره‌سازی ابری](./Object-Storage.md) را ببینید.

:::tip

Media Worker (`WORKER_URL`) را **سرور** شما صدا می‌زند، نه مرورگر؛ پس به ورودی نیاز ندارد.

:::

## عیب‌یابی

### صفحهٔ خالی بعد از ارتقا یا فعال شدن سیاست

1. صفحه را باز کنید، `F12` را بزنید و **Console** را ببینید. درخواست مسدودشده چنین است: `Refused to load the image 'https://media.example.com/...' because it violates the following Content Security Policy directive: "img-src 'self' data: blob:"`. دستور و آدرس مسدودشده می‌گویند چه چیزی را باید مجاز کرد.
2. برای اینکه فوراً دوباره کار کند، `CSP_MODE=report-only` (یا `off`) بگذارید و ری‌استارت کنید. چیزی مسدود نمی‌شود و کنسول نشان می‌دهد چه چیزی *مسدود می‌شد*.
3. علت را درست کنید:
   - origin یک CDN یا باکت → آن را در `CSP_EXTRA_SOURCES` بگذارید (یا `STORAGE_PUBLIC_URL` / `STORAGE_ENDPOINT` را تنظیم کنید)، سپس به `enforce` برگردید؛
   - چیزی که یک پراکسی تزریق کرده (پایین را ببینید) → آن قابلیت را در پراکسی خاموش کنید؛
   - یک origin از نوع `https://` که با مسیر، فاصله یا نقطه‌ویرگول نوشته شده → لاگ سرور را برای `CSP_EXTRA_SOURCES: ignored` ببینید.
4. هدرهایی را که مرورگر واقعاً می‌گیرد بررسی کنید: `curl -sI https://chat.example.com/ | grep -i -E 'content-security|strict-transport'`. باید **دقیقاً یک** خط `Content-Security-Policy` ببینید.

### تصاویر یا ویدیوهای باکت بارگیری نمی‌شوند، آپلود شکست می‌خورد

Console: `Refused to connect to 'https://<میزبان باکت>/...'` یا `Refused to load media ...`. علت همان است: origin باکت در سیاست نیست. این origin خودکار از `STORAGE_ENDPOINT` / `STORAGE_PUBLIC_URL` اضافه می‌شود؛ اگر فایل‌های شما از میزبان دیگری می‌آیند، آن را در `CSP_EXTRA_SOURCES` بگذارید. اگر کنسول به‌جای آن خطای **CORS** نشان می‌دهد، مشکل از قواعد CORS باکت است، نه CSP.

### چیزی که پراکسی تزریق می‌کند مسدود می‌شود

*Rocket Loader*، *Email Address Obfuscation*، *Web Analytics* (اسکریپت `beacon.min.js`)، *Auto Minify* برای HTML و قابلیت‌های مشابه در Cloudflare صفحه را بازنویسی می‌کنند یا اسکریپت درون‌خطی اضافه می‌کنند. سیاست سخت‌گیرانه اسکریپت درون‌خطی را مسدود می‌کند و کنسول `Refused to execute inline script` نشان می‌دهد. Aurelle بدون این قابلیت‌ها کار می‌کند؛ آن‌ها را برای نام میزبان Aurelle خاموش کنید.

### بررسی به‌روزرسانی در پنل مدیریت شکست می‌خورد

این بررسی از مرورگر شما `https://api.github.com` را صدا می‌زند. اگر جایی جلوی Aurelle سیاست را دستی تغییر داده‌اید یا مرورگر به GitHub دسترسی ندارد (شبکهٔ محدود)، دکمه *Check failed* می‌گوید. بقیهٔ برنامه تأثیری نمی‌گیرد.

### سایت روی subpath است

`client/index.html` فایل `/theme-init.js` را با مسیر نسبت به ریشه بارگیری می‌کند. آن را مثل بقیهٔ مسیرهای ثابت که در [اجرا روی Subpath](./Subpath-Hosting.md) آمده است تنظیم کنید.

## همان هدرها را در Nginx یا CDN اضافه نکنید

:::warning هدرهای تکراری بی‌ضرر نیستند

اگر Aurelle **و** پراکسی معکوس یا CDN شما هر کدام یک `Content-Security-Policy` بفرستند، مرورگر **هر دو** را اعمال می‌کند و فقط چیزی را اجازه می‌دهد که *هر دو* اجازه بدهند. سخت‌گیرانه‌ترین برنده است؛ پس سیاستی که برای Aurelle درست است می‌تواند با دومی به صفحهٔ خالی تبدیل شود و علتش را در تنظیمات Aurelle نمی‌بینید. هدرهای تکراری دیگر (`X-Frame-Options`، `Strict-Transport-Security` و ...) در بهترین حالت فقط شلوغی‌اند.

:::

- پیکربندی‌های Nginx در این مستندات، آنچه اسکریپت نصب می‌نویسد و `nginx/nginx.conf` در نصب Docker **هیچ** هدر امنیتی اضافه نمی‌کنند (فقط `X-Accel-Buffering` برای جریان به‌روزرسانی زنده). تکه‌ای «سخت‌سازی» با `add_header Content-Security-Policy ...`، `add_header X-Frame-Options ...` و مانند آن را داخلشان نچسبانید. اگر یکی از این فایل‌ها چنین خطی بگیرد، یک تست در مخزن شکست می‌خورد.
- **Cloudflare**: *Transform Rules → Modify Response Header*، *Managed Transforms → Add security headers* و *SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS)* را برای نام میزبان Aurelle خاموش بگذارید، یا مطمئن شوید `Content-Security-Policy` تنظیم نمی‌کنند. (تنظیم HSTS در Cloudflare کنار HSTS خود Aurelle بی‌ضرر است و مرورگر اولی را به کار می‌برد، اما دلیلی برای اجرای دو تا نیست.)
- CDN ها و WAF های دیگر (Arvan Cloud، Fastly، BunnyCDN، response-header policy در AWS CloudFront، قواعد ModSecurity): همین قاعده، برای Aurelle `Content-Security-Policy` خودشان را نفرستند.
- اگر سیاست دیگری می‌خواهید، آن را روی سیاست Aurelle نیندازید: در Aurelle `CSP_MODE=off` بگذارید و سیاست خودتان را از پراکسی بفرستید. آن‌وقت مسئولیتش، از جمله origin های ذخیره‌سازی بالا، با شماست.

## بررسی توسط خودتان

```bash
# هدرهای صفحه
curl -sI https://chat.example.com/

# فقط سیاست، هر دستور در یک خط
curl -sI https://chat.example.com/ | grep -i '^content-security-policy' | tr ';' '\n'

# صفحه اسکریپت یا استایل درون‌خطی ندارد
curl -s https://chat.example.com/ | grep -c -i -E '<script[^>]*>[^<]|<style'   # باید 0 باشد
```

DevTools خود مرورگرها (*Application → Frames*، *Security*) و ابزارهایی مثل [Mozilla Observatory](https://developer.mozilla.org/en-US/observatory) هم همین هدرها را نشان می‌دهند.
