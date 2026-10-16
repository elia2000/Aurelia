# نصب از طریق Docker

:::tip نکته زیرساخت
این راهنما از Docker Compose استفاده میکند و برای **IaaS** (زیرساخت به عنوان سرویس — سرورها یا ماشین های مجازی اختصاصی که Docker Engine را اجرا میکنند) طراحی شده است. اگر قصد استقرار روی پلتفرم های ابری مدیریت شده (PaaS / CaaS) مانند Render، Railway، AWS ECS، Google Cloud Run یا Kubernetes را دارید، به راهنمای [استقرار ابری](./Cloud-Deployment.md) مراجعه کنید.
:::

**پیش‌نیازها (روی Ubuntu 22.04+ آزمایش شده):**

- یک سرور Ubuntu با دسترسی sudo
- یک نام دامنه که به IP عمومی سرور شما اشاره می‌کند (توصیه‌شده)

## ۱. راه‌اندازی سیستم

این بسته‌ها را نصب کنید:

```bash
sudo apt install -y ca-certificates gnupg lsb-release
```

کلید رسمی GPG مربوط به Docker را اضافه کنید:

```bash
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
```

مخزن apt مربوط به Docker را اضافه کنید:

```bash
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Docker Engine + افزونه Compose را نصب کنید:

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

اختیاری: اجرای Docker بدون `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

اختیاری: بررسی نصب:

```bash
docker --version
docker compose version
docker run hello-world
```

## ۲. کلون‌کردن مخزن

```bash
sudo mkdir -p /opt/songbird
cd /opt/songbird
git clone https://github.com/elia2000/Aurelia.git .
```

## ۳. پیکربندی محیط

فایل نمونه محیطی را کپی کرده و ویرایش کنید:

```bash
cp .env.example .env
nano .env
```

:::info استفاده از PostgreSQL در Docker
پایگاه داده پیشفرض Aurelle بر پایه SQLite است (`DB_CLIENT=sqlite3`). برای استفاده از PostgreSQL، فایل `.env` را ویرایش کرده و `DB_CLIENT=postgres` را به همراه متغیرهای `POSTGRES_*` تنظیم کنید، یا سرویس و volume اختیاری `postgres` را در `docker-compose.yaml` از حالت کامنت خارج کنید.
:::

:::info کانتینر Media Worker
Aurelle به‌صورت پیش‌فرض یک پروسه ورکر محلی را درون کانتینر یکپارچه (ایمیجی که از `Dockerfile` ریشه ساخته می‌شود) به‌طور خودکار اجرا و مدیریت می‌کند. برای محیط‌های با بار کاری سنگین یا توزیع‌شده، می‌توانید پردازش ویدیوها را به یک ایمیج مجزای ورکر بسپارید که خودتان از پوشه `worker/` می‌سازید (`docker build -t aurelle-worker:latest worker/`)؛ سپس سرویس اختیاری `media-worker` را در `docker-compose.yaml` از کامنت خارج کنید و `SONGBIRD_WORKER_IMAGE=aurelle-worker:latest` را در `.env` تنظیم نمایید. برای جزئیات بیشتر به مستندات [ورکر مدیا](./Media-Worker.md) مراجعه کنید.
:::

## ۴. راه‌اندازی گواهی‌نامه TLS

کانتینر nginx برای اجرا به فایل‌های گواهی‌نامه TLS نیاز دارد. گواهی‌نامه و کلید خصوصی خود را در مسیرهای زیر قرار دهید:

- `certs/cert.pem` — گواهی‌نامه (یا زنجیره کامل)
- `certs/key.pem` — کلید خصوصی

برای دیدن گزینه‌های موجود، به [گواهی‌نامه‌های SSL](./SSL-Certificates.md) مراجعه کنید.

## ۵. ساخت و اجرا

Aurelle از روی سورس ساخته می‌شود: فایل `docker-compose.yaml` بلوک `build:` دارد و هیچ ایمیج آماده‌ای منتشر نشده است (ایمیج Aurelle در Docker Hub شامل تماس‌ها، پیام‌های ویدیویی و برندینگ Aurelle نیست). ایمیج را بسازید و کانتینرها را اجرا کنید:

```bash
cd /opt/songbird
docker compose up -d --build
```

اولین بیلد، کلاینت را کامپایل کرده و وابستگی‌های سرور را نصب می‌کند، بنابراین ممکن است چند دقیقه طول بکشد. ایمیج حاصل با نام `aurelle:latest` برچسب‌گذاری می‌شود (برای تغییر نام، `SONGBIRD_IMAGE` را در `.env` تنظیم کنید). اگر ترجیح می‌دهید از ایمیجی استفاده کنید که خودتان ساخته و در رجیستری شخصی‌تان push کرده‌اید، بلوک `build:` را در `docker-compose.yaml` حذف کرده و `SONGBIRD_IMAGE` را روی نام آن ایمیج تنظیم کنید.

کانتینر nginx قبل از پذیرش ترافیک منتظر می‌ماند تا بررسی سلامت اپلیکیشن موفق شود. این کار از خطاهای 502 در طول پنجره راه‌اندازی کوتاه هنگام اجرای migration جلوگیری می‌کند.

اختیاری: بررسی موفقیت‌آمیز بودن راه‌اندازی کانتینرها:

```bash
docker compose ps
docker compose logs -f
```

:::info پیکربندی Nginx

کانتینر nginx با استفاده از گواهی‌نامه‌های موجود در پوشه `certs/`، HTTPS را روی پورت 443 ارائه می‌دهد. برای سفارشی‌سازی پیکربندی nginx، به صفحه [پیکربندی Nginx](./Nginx-Configuration.md) مراجعه کنید. پس از ویرایش `nginx/nginx.conf`، کانتینر nginx را مجدداً راه‌اندازی کنید:

```bash
docker compose restart nginx
```

:::

## کاربر runtime و داده پایدار

استقرارهای Docker از `songbird.service` استفاده نمیکنند. Aurelle با کاربر پیکربندی شده برای container اجرا میشود (در image فعلی root است، مگر آنکه `user:` در Compose آن را override کند) و دستورهای پایگاه داده با همان UID/GID ‏container اجرا میشوند:

```bash
docker compose exec songbird npm --prefix /app/server run db:inspect
```

برای اجرای container با یک UID/GID غیر root مشخص، `user:` را در service ‏Compose پیکربندی کنید:

```yaml
services:
  songbird:
    user: "songbird:songbird"
```

اگر به جای named volume پیشفرض از bind mount استفاده میکنید، پیش از راه اندازی Aurelle، پوشه host را برای همان UID:GID قابل نوشتن کنید. Aurelle مالکیت bind mount روی host را به صورت خودکار تغییر نمیدهد:

```bash
mkdir -p ./data
sudo chown -R songbird:songbird ./data
```

## کنترل سرویس در پنل مدیریت

اقدامات **ریستارت سرویس** و **توقف سرویس** در پنل مدیریت برای استقرار Docker با فراخوانی Docker Engine API از طریق سوکت mount‌شده (`/var/run/docker.sock`) کار می‌کنند. فایل compose متغیر `SONGBIRD_CONTAINER_NAME=songbird` را تنظیم می‌کند تا اپلیکیشن بداند کدام کانتینر را هدف قرار دهد.

اگر نام کانتینر را تغییر دادید یا از نام سفارشی استفاده می‌کنید، متغیر env را به‌روز کنید:

```yaml
# docker-compose.yaml
environment:
  SONGBIRD_CONTAINER_NAME: my-custom-name
```

اگر به کنترل سرویس از پنل مدیریت نیاز ندارید، می‌توانید mount سوکت را از `docker-compose.yaml` حذف کنید:

```yaml
# این خط را در بخش volumes مربوط به songbird حذف یا کامنت کنید:
# - /var/run/docker.sock:/var/run/docker.sock
```

## به‌روزرسانی

سورس جدید را دریافت کنید، ایمیج را دوباره بسازید و مجدداً راه‌اندازی کنید:

```bash
cd /opt/songbird
git pull
docker compose up -d --build
```

برای روش کامل به‌روزرسانی، صفحه [به‌روزرسانی](./Updating.md) را ببینید.
