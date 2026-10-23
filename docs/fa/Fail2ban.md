# Fail2ban

[Fail2ban](https://github.com/fail2ban/fail2ban) لاگ ها را میخواند و وقتی یک آدرس بیش از حد خطا بزند، آن را در فایروال مسدود میکند. برای Aurelle جلوی اسکریپتی را میگیرد که رمز حدس میزند و همچنین کلاینتی که nginx یا رله تماس را با درخواست پر میکند.

فایل های لازم در پوشه `deploy/fail2ban/` هستند. نصاب fail2ban را **راه اندازی نمیکند**: فایل ها را مثل زیر دستی کپی کنید. آن را روی سروری استفاده کنید که از اینترنت در دسترس است؛ روی شبکه خصوصی احتمالا لازم نیست.

| جیل (jail) | چه چیزی را میخواند | چه چیزی را مسدود میکند | پیش فرض |
|---|---|---|---|
| `aurelle-auth` | لاگ برنامه (ژورنال systemd سرویس `songbird.service`) | ۶ رمز یا کد 2FA اشتباه در ۱۵ دقیقه | فعال |
| `aurelle-auth-docker` | لاگ برنامه در لاگ کانتینرهای Docker | همان، برای نصب با Docker Compose | غیرفعال |
| `aurelle-nginx-4xx` | `/var/log/nginx/access.log` | ۲۰۰ پاسخ خطا (400، 403، 404، 405، 408، 414، 429) در یک دقیقه | غیرفعال |
| `aurelle-nginx-limit-req` | `/var/log/nginx/error.log` | ۳۰ درخواست ردشده توسط محدودیت نرخ `limit_req` در nginx در یک دقیقه | غیرفعال |
| `aurelle-coturn` | ژورنال `coturn.service` | ۶۰ نشست رله تماس از یک آدرس در یک دقیقه | غیرفعال |

:::warning اول آدرس را بررسی کنید

Fail2ban **آدرسی را که در لاگ است** مسدود میکند. اگر به جای آدرس بازدیدکننده، آدرس CDN یا پراکسی شما در لاگ باشد، با یک بازدیدکننده بد کل CDN مسدود میشود و همه قفل میشوند. پیش از روشن کردن هر جیل، بخش [برنامه کدام آدرس را میبیند](#برنامه-کدام-آدرس-را-میبیند) و بررسی انتهای آن را انجام دهید.

:::

## نصب

fail2ban نسخه 0.11 یا جدیدتر لازم است. Debian 12 و Ubuntu 24.04 نسخه 1.0 دارند و به طور پیش فرض از ژورنال systemd و nftables استفاده میکنند.

```bash
sudo apt install fail2ban

cd /opt/songbird          # the folder you installed Aurelle into
sudo cp deploy/fail2ban/filter.d/*.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/aurelle.local /etc/fail2ban/jail.d/aurelle.local
```

فایل `/etc/fail2ban/jail.d/aurelle.local` را باز کنید و:

۱. آدرس های خودتان (دفتر، VPN) را به `ignoreip` اضافه کنید تا هرگز خودتان را مسدود نکنید.
۲. برای جیل هایی که میخواهید `enabled = true` و برای بقیه `enabled = false` بگذارید.
۳. اگر از پورت های 80 و 443 استفاده نمیکنید خط های `port` را بررسی کنید.

سپس بارگذاری کنید:

```bash
sudo fail2ban-client reload
sudo fail2ban-client status
sudo fail2ban-client status aurelle-auth
```

اگر به جای وضعیت یک جیل خطا دیدید، `sudo journalctl -u fail2ban -n 50` علت را میگوید (معمولا مسیر لاگی که وجود ندارد).

## برنامه چه چیزی در لاگ مینویسد

با هر رمز اشتباه و هر کد 2FA اشتباه، سرور یک خط در خروجی استاندارد خود چاپ میکند که systemd در ژورنال `songbird.service` و Docker در لاگ کانتینر نگه میدارد:

```txt
2026-10-23T11:30:25.646Z [auth] auth_failed ip=203.0.113.9 user=b5fcabbe2af0 reason=credentials
```

- `ip` آدرس بازدیدکننده است، همان طور که سرور حساب میکند (بخش بعد). اگر آدرس معتبر نباشد `unknown` نوشته میشود و fail2ban آن خط را نادیده میگیرد.
- `user` هش کوتاهی از نام حسابی است که امتحان شده. رمز و نام هرگز نوشته نمیشوند، حتی برای حساب هایی که وجود ندارند. تا وقتی سرور راه اندازی مجدد نشود، برای یک نام همیشه همین مقدار است؛ پس میتوانید ببینید یک حساب هدف قرار گرفته یا نه.
- درخواستی که خود سرور به خاطر تلاش های ناموفق قبلی رد میکند (HTTP 429) دوباره ثبت نمیشود؛ برای همین `maxretry` را کم نگه دارید، مثل فایل (۶)، وگرنه fail2ban هرگز به تعداد کافی خط نمیرسد.

لاگ را با `sudo journalctl -u songbird | grep auth_failed` یا `docker compose logs songbird | grep auth_failed` ببینید.

## برنامه کدام آدرس را میبیند

سرور با `trust proxy` برابر **۱** اجرا میشود: به **آخرین** مقدار هدر `X-Forwarded-For` اعتماد میکند، یعنی آدرسی که اولین پراکسی جلوی آن (nginx) دیده است. فقط وقتی این آدرس بازدیدکننده است که خود nginx مستقیم با بازدیدکننده صحبت کند. این جدول با رفتار واقعی Express بررسی شده است:

| وضعیت | آدرس در لاگ | چه باید بکنید |
|---|---|---|
| nginx نصاب، بازدیدکننده ها مستقیم به آن وصل میشوند | بازدیدکننده | کاری لازم نیست. |
| Docker Compose با nginx همراه | بازدیدکننده، **به شرط** اینکه `nginx/nginx.conf` هدر `X-Forwarded-For` را تنظیم کند (از این نسخه میکند) | به‌روز کنید و یک بار دیگر `docker compose up -d` بزنید. نسخه های قبلی این هدر را نمیگذاشتند و همه بازدیدکننده ها شبیه کانتینر nginx دیده میشدند. |
| پشت Cloudflare یا CDN دیگر | آدرس CDN (nginx، CDN را کلاینت میبیند) | nginx را طوری تنظیم کنید که آدرس واقعی را بخواند: پایین را ببینید. |
| پراکسی یا load balancer دیگری جلوی nginx | آدرس همان پراکسی | مثل CDN. |
| پورت برنامه به اینترنت باز است و nginx استفاده نمیشود (`BIND_ADDRESS=0.0.0.0`) | هر چه بازدیدکننده در `X-Forwarded-For` بنویسد | این طور اجرا نکنید: nginx را جلویش بگذارید و `BIND_ADDRESS=localhost` را نگه دارید. در این حالت به fail2ban نمیشود اعتماد کرد، چون هر کسی میتواند هر آدرسی (از جمله آدرس شما) را بنویسد. |

### پشت Cloudflare یا CDN دیگر

بدون تنظیم اضافه، nginx فقط CDN را میبیند و برنامه، محدودیت های ورود آن و fail2ban همه آدرس CDN را میبینند. به nginx بگویید آدرس بازدیدکننده را از هدر CDN بخواند، آن هم فقط برای اتصال هایی که از محدوده های خود CDN می آیند. برای Cloudflare این همان فهرست `set_real_ip_from ...` و خط `real_ip_header CF-Connecting-IP;` در [اجرا پشت CDN](./CDN-Setup.md) (مرحله ۵) است. بعد از `sudo nginx -t && sudo systemctl reload nginx`، مقدار `$remote_addr` آدرس بازدیدکننده است، nginx آن را ارسال میکند و برنامه، خط لاگ و لاگ دسترسی nginx همه آدرس بازدیدکننده را دارند. برای پراکسی دیگری جلوی nginx از `real_ip_header X-Forwarded-For;` همراه `real_ip_recursive on;` و آدرس آن پراکسی در `set_real_ip_from` استفاده کنید.

حتی با آدرس درست در لاگ، مسدود کردن در فایروال **سرور** در برابر بازدیدکننده ای که پشت CDN پراکسی شده است فایده ندارد: بازدیدکننده هرگز به سرور شما وصل نمیشود، CDN وصل میشود و بسته هایی که میرسند آدرس CDN را دارند. از قواعد فایروال یا محدودیت نرخ خود CDN استفاده کنید، یا از اکشنی که با CDN صحبت میکند (fail2ban اکشن `cloudflare-token` را همراه دارد که توکن API میخواهد؛ پیش از استفاده `/etc/fail2ban/action.d/cloudflare-token.conf` را بخوانید؛ اینجا آزمایش نشده است). بدون چنین اکشنی، fail2ban را برای چیزهایی نگه دارید که مستقیم وصل میشوند: رله تماس و SSH. محدودیت خود برنامه روی رمز اشتباه (HTTP 429) به ازای آدرس بازدیدکننده است و وقتی nginx آدرس واقعی را ارسال کند درست کار میکند.

### پیش از روشن کردن جیل بررسی کنید

۱. از یک گوشی با اینترنت موبایل (نه شبکه خودتان) با رمز اشتباه وارد شوید.
۲. `sudo journalctl -u songbird -n 5 | grep auth_failed` را اجرا کنید.
۳. مقدار `ip=` باید آدرس عمومی همان گوشی باشد (در هر سایت "what is my IP" پیدا میشود). اگر `127.0.0.1`، آدرس Docker (`172.x`) یا آدرس CDN بود، اول تنظیمات بالا را درست کنید.

## آزمایش فیلترها

`fail2ban-regex` یک فیلتر را روی لاگ اجرا میکند و میگوید چند خط مطابقت داشته، بدون اینکه کسی را مسدود کند:

```bash
# the app, on the journal
sudo fail2ban-regex systemd-journal /etc/fail2ban/filter.d/aurelle-auth.conf \
  --journalmatch '_SYSTEMD_UNIT=songbird.service'

# the app, on a Docker container log
sudo fail2ban-regex "$(docker inspect --format '{{.LogPath}}' songbird)" /etc/fail2ban/filter.d/aurelle-auth.conf

# nginx
sudo fail2ban-regex /var/log/nginx/access.log /etc/fail2ban/filter.d/aurelle-nginx-4xx.conf
sudo fail2ban-regex /var/log/nginx/error.log nginx-limit-req
```

برای دیدن خط های مطابق و آدرس برداشته شده از هر کدام `-v --print-all-matched` را اضافه کنید. بعد از چند ورود اشتباه، دستور اول باید آن ها را مطابق نشان دهد.

## رفع مسدودیت و فهرست مجاز

```bash
sudo fail2ban-client status aurelle-auth                    # who is banned
sudo fail2ban-client set aurelle-auth unbanip 203.0.113.9   # let one address in
sudo fail2ban-client unban 203.0.113.9                      # from every jail
```

برای اینکه آدرسی هرگز مسدود نشود، آن را به `ignoreip` در `aurelle.local` اضافه کنید و `sudo fail2ban-client reload` بزنید. آدرسی که دوباره برمیگردد هر بار مدت طولانی تری مسدود میشود (`bantime.increment`، تا یک هفته).

## پورت ها، ufw و Docker

جیل ها در فایروالی مسدود میکنند که fail2ban برای آن تنظیم شده است (`banaction`).

- **Debian 12 / Ubuntu 24.04** به طور پیش فرض از nftables استفاده میکنند؛ چیزی لازم نیست.
- **ufw**: در بخش `[DEFAULT]` فایل `aurelle.local` خط `banaction = ufw` را اضافه کنید. ufw پورت هایی را که Docker منتشر میکند کنترل نمیکند.
- **Docker Compose**: پورت های منتشرشده از قواعد معمول INPUT رد میشوند، پس مسدودسازی باید در زنجیره `DOCKER-USER` باشد. جیل `aurelle-auth-docker` از قبل `chain = DOCKER-USER` دارد؛ برای هر جیل دیگری که با Docker استفاده میکنید همین را بگذارید (`banaction = iptables-multiport` به همراه `chain = DOCKER-USER`). این جیل `/var/lib/docker/containers/*/*-json.log` را میخواند و فقط به خط های دارای `[auth] auth_failed` واکنش نشان میدهد. اگر درایور لاگ دیگری دارید (مثلا journald) جیل را به آن اشاره دهید.

## محدودیت نرخ nginx (اختیاری)

پیکربندی nginx که نصاب مینویسد **هیچ** محدودیت نرخی ندارد، پس جیل `aurelle-nginx-limit-req` تا وقتی یکی اضافه نکنید چیزی برای خواندن ندارد. این را در یک فایل جدا بگذارید؛ context مربوط به `http` جای درست است، برای همه سایت های ماشین اعمال میشود و با اجرای دوباره نصاب (که فایل سایت را بازنویسی میکند) از بین نمیرود:

```nginx
# /etc/nginx/conf.d/aurelle-limits.conf
limit_req_zone $binary_remote_addr zone=aurelle_req:10m rate=20r/s;
limit_req zone=aurelle_req burst=60 nodelay;
limit_req_status 429;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

بارگذاری یک صفحه چند ده فایل را همزمان میگیرد که burst برابر ۶۰ آن را تحمل میکند. nginx درخواست ردشده را در `/var/log/nginx/error.log` به شکل `limiting requests, excess: ... by zone "aurelle_req", client: 203.0.113.9` مینویسد که فیلتر همراه fail2ban (`nginx-limit-req`) آن را میشناسد. با Docker فایل را در `/etc/nginx/conf.d/` کانتینر `nginx` بگذارید و به جای آن لاگ کانتینر را بخوانید.

## رله تماس (coturn)

رله اول از همه با ماهیت خودش محافظت میشود: مجوزها را برنامه برای هر کاربر میسازد و منقضی میشوند، و `user-quota`، `total-quota` و `max-bps` در پیکربندی آن مقدار مصرف هر کاربر را محدود میکنند. مسدودسازی بر پایه لاگ لایه دوم است و از وب اپ ضعیف تر:

- **coturn هنگام شکست ورود آدرس کلاینت را نمینویسد.** با coturn نسخه 4.6.1 بررسی شد: خط ها `check_stun_auth: Cannot find credentials of user <...>` و `incoming packet ... processed, error 401: Unauthorized` هستند و هیچ کدام آدرس ندارند.
- تنها خطی که آدرس دارد هنگام پایان نشست نوشته میشود، آن هم فقط اگر coturn با `verbose` اجرا شود:

  ```txt
  session 003000000000000003: closed (2nd stage), user <1792791167:mallory> realm <aurelle> origin <>, local 192.0.2.10:3478, remote 203.0.113.9:43994, reason: allocation watchdog determined stale session state
  ```

  ورود ناموفق و یک تماس عادی هر دو با همین نوع خط تمام میشوند، پس جیل `aurelle-coturn` **تعداد نشست به ازای هر آدرس** را میشمارد، با سقف بالا (۶۰ در دقیقه)، و جلوی سیل درخواست را میگیرد نه تک رمز اشتباه را.
- بیشتر ترافیک رله UDP است و آدرس مبدأ UDP قابل جعل است. کسی که آدرس دوست شما را بداند میتواند وانمود کند آن آدرس نشست های زیادی باز کرده است. برای همین جیل فقط پورت های رله را مسدود میکند نه کل ماشین را، و سقف آن بالاست.

برای استفاده، `verbose` را به پیکربندی رله (`/etc/turnserver.conf`؛ نصاب در آن `syslog` مینویسد ولی `verbose` نه) اضافه کنید، با `sudo systemctl restart coturn` راه اندازی مجدد کنید و جیل را فعال کنید. اجرای دوباره نصاب این فایل را بازنویسی میکند، پس بعدش خط را دوباره اضافه کنید. با Docker، `- "--verbose"` را به دستور سرویس `coturn` در `docker-compose.yaml` اضافه کنید، جیل را مثل بالا به لاگ کانتینر اشاره دهید و اگر پورت رله دیگری دارید `port` را عوض کنید.

علاوه بر fail2ban، یک محدودیت ساده فایروال روی پورت رله محافظت معمول در برابر سیل درخواست است؛ مثلا با ufw: `sudo ufw limit 3478`.

## چگونه بررسی شد

فیلترها با `fail2ban-regex` (نسخه 1.0.2) روی خروجی واقعی اجرا شدند: خط های برنامه از یک سرور Aurelle در حال اجرا و ورودهای ناموفق واقعی، خط های nginx از یک nginx در حال اجرا (قالب پیش فرض `combined` و `limit_req`)، و خط های coturn از یک turnserver نسخه 4.6.1 در حال اجرا آمدند. یک سرور کامل fail2ban هم روی لاگ برنامه راه اندازی شد و آدرس هفت ورود ناموفقی را که از طریق `X-Forwarded-For` رسیده بودند مسدود کرد. شکل ژورنال systemd و Docker با خط های نمونه در همان قالب ها آزمایش شد، نه با ژورنال یا Docker واقعی.
