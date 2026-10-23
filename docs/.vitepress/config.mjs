import {defineConfig} from 'vitepress';

const enSidebar = [
  {
    text: '📦 Installation',
    collapsed: false,
    items: [
      {text: '🚀 Deployment Script', link: '/Deployment-Script'},
      {text: '🐳 Install via Docker', link: '/Installation-Docker'},
      {text: '☁️ Cloud Deployment', link: '/Cloud-Deployment'},
      {text: '🛠️ Manual Installation', link: '/Manual-Installation'},
      {text: '🌐 Configure Nginx', link: '/Nginx-Configuration'},
      {text: '🔒 SSL Certificates', link: '/SSL-Certificates'},
      {text: '☁️ Running behind a CDN', link: '/CDN-Setup'},
      {text: '🧭 Subpath Hosting', link: '/Subpath-Hosting'},
    ],
  },
  {
    text: '⚙️ Configuration',
    collapsed: false,
    items: [
      {text: '🔧 Environment Variables', link: '/Environment-Variables'},
      {text: '☁️ Object Storage', link: '/Object-Storage'},
      {text: '🎬 Media Worker', link: '/Media-Worker'},
      {text: '🛡️ Admin Panel', link: '/Admin-Panel'},
      {text: '🔑 Account Security', link: '/Account-Security'},
      {text: '🧱 Security Headers', link: '/Security-Headers'},
      {text: '📋 Message Menu', link: '/Message-Menu'},
      {text: '😀 Reactions', link: '/Reactions'},
      {text: '🎞️ GIFs', link: '/Saved-GIFs'},
      {text: '🔗 Link Previews', link: '/Link-Previews'},
      {text: '☑️ Selecting Messages', link: '/Selecting-Messages'},
      {text: '📌 Pinned Messages and Chats', link: '/Pinned-Messages-and-Chats'},
      {text: '📡 Remote Channel Setup', link: '/Remote-Channel-Setup'},
      {text: '🔔 Push Notification Proxy', link: '/Push-Notification-Proxy'},
    ],
  },
  {
    text: '🔐 Calls & Encryption',
    collapsed: false,
    items: [
      {text: '📞 Calls & Video Messages', link: '/Calls-and-Video-Messages'},
      {text: '🧬 Encryption Protocol', link: '/E2EE-Protocol'},
    ],
  },
  {
    text: '🔨 Operations',
    collapsed: false,
    items: [
      {text: '🔄 Updating', link: '/Updating'},
      {text: '🛡️ Security Maintenance', link: '/Security-Maintenance'},
      {text: '🚫 Fail2ban', link: '/Fail2ban'},
      {text: '🗃️ Database Commands', link: '/Database-Commands'},
      {text: '🩺 Troubleshooting', link: '/Troubleshooting'},
    ],
  },
];

const faSidebar = [
  {
    text: '📦 نصب و راه‌اندازی',
    collapsed: false,
    items: [
      {text: '🚀 اسکریپت نصب', link: '/fa/Deployment-Script'},
      {text: '🐳 نصب از طریق Docker', link: '/fa/Installation-Docker'},
      {text: '☁️ استقرار ابری', link: '/fa/Cloud-Deployment'},
      {text: '🛠️ نصب دستی', link: '/fa/Manual-Installation'},
      {text: '🌐 کانفیگ Nginx', link: '/fa/Nginx-Configuration'},
      {text: '🔒 گواهی‌های SSL', link: '/fa/SSL-Certificates'},
      {text: '☁️ اجرا پشت CDN', link: '/fa/CDN-Setup'},
      {text: '🧭 اجرا روی Subpath', link: '/fa/Subpath-Hosting'},
    ],
  },
  {
    text: '⚙️ پیکربندی',
    collapsed: false,
    items: [
      {text: '🔧 متغیرهای محیطی', link: '/fa/Environment-Variables'},
      {text: '☁️ ذخیره سازی ابری', link: '/fa/Object-Storage'},
      {text: '🎬 ورکر مدیا', link: '/fa/Media-Worker'},
      {text: '🛡️ پنل مدیریت', link: '/fa/Admin-Panel'},
      {text: '🔑 امنیت حساب', link: '/fa/Account-Security'},
      {text: '🧱 هدرهای امنیتی', link: '/fa/Security-Headers'},
      {text: '📋 منوی پیام', link: '/fa/Message-Menu'},
      {text: '😀 واکنش‌ها', link: '/fa/Reactions'},
      {text: '🎞️ گیف‌ها', link: '/fa/Saved-GIFs'},
      {text: '🔗 پیش‌نمایش پیوند', link: '/fa/Link-Previews'},
      {text: '☑️ انتخاب پیام‌ها', link: '/fa/Selecting-Messages'},
      {text: '📌 پیام‌ها و گفتگوهای سنجاق‌شده', link: '/fa/Pinned-Messages-and-Chats'},
      {text: '📡 راه اندازی Remote Channel', link: '/fa/Remote-Channel-Setup'},
      {text: '🔔 پراکسی Push Notification', link: '/fa/Push-Notification-Proxy'},
    ],
  },
  {
    text: '🔐 تماس و رمزنگاری',
    collapsed: false,
    items: [
      {text: '📞 تماس‌ها و پیام‌های ویدیویی', link: '/fa/Calls-and-Video-Messages'},
      {text: '🧬 پروتکل رمزنگاری', link: '/fa/E2EE-Protocol'},
    ],
  },
  {
    text: '🔨 عملیات',
    collapsed: false,
    items: [
      {text: '🔄 به‌روزرسانی', link: '/fa/Updating'},
      {text: '🛡️ نگهداری امنیتی', link: '/fa/Security-Maintenance'},
      {text: '🚫 Fail2ban', link: '/fa/Fail2ban'},
      {text: '🗃️ دستورات دیتابیس', link: '/fa/Database-Commands'},
      {text: '🩺 عیب‌یابی', link: '/fa/Troubleshooting'},
    ],
  },
];

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Aurelle Docs',
  description: 'Documentation of Aurelle, a private, self-hosted messenger with end-to-end encrypted calls and video messages.',

  // Served from a custom domain at the site root.
  base: '/',

  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,

  head: [
    ['link', {rel: 'icon', href: '/favicon.ico'}],
  ],

  themeConfig: {
    // Shared across locales
    logo: '/aurelle-logo.svg',

    socialLinks: [
      {icon: 'github', link: 'https://github.com/elia2000/Aurelia'},
    ],

    search: {
      provider: 'local',
    },
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          {text: 'Home', link: '/'},
          {text: 'Guide', link: '/Deployment-Script'},
          {text: 'Releases', link: 'https://github.com/elia2000/Aurelia/releases'},
        ],
        sidebar: enSidebar,
        editLink: {
          pattern: 'https://github.com/elia2000/Aurelia/edit/main/docs/:path',
          text: 'Edit this page on GitHub',
        },
        footer: {
          message: 'Released under the MIT License.',
          copyright: 'Copyright © 2026 Aurelle · built on Songbird (MIT)',
        },
      },
    },

    fa: {
      label: 'فارسی',
      lang: 'fa-IR',
      link: '/fa/',
      themeConfig: {
        nav: [
          {text: 'خانه', link: '/fa/'},
          {text: 'راهنما', link: '/fa/Deployment-Script'},
          {text: 'نسخه‌ها', link: 'https://github.com/elia2000/Aurelia/releases'},
        ],
        sidebar: faSidebar,
        editLink: {
          pattern: 'https://github.com/elia2000/Aurelia/edit/main/docs/:path',
          text: 'ویرایش این صفحه در GitHub',
        },
        footer: {
          message: 'تحت لایسنس MIT منتشر شده است.',
          copyright: 'کپی‌رایت © ۲۰۲۶ Aurelle · ساخته‌شده بر پایه‌ی Songbird (MIT)',
        },
        docFooter: {
          prev: 'صفحه قبل',
          next: 'صفحه بعد',
        },
        outline: {label: 'در این صفحه'},
        lastUpdated: {text: 'آخرین به‌روزرسانی'},
        langMenuLabel: 'تغییر زبان',
        returnToTopLabel: 'بازگشت به بالا',
        sidebarMenuLabel: 'منو',
        darkModeSwitchLabel: 'حالت تیره',
      },
    },
  },
});
