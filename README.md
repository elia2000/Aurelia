[English](/README.md) | [فارسی](/README.fa_IR.md)

<div align="center">

# <img src="./client/src/assets/aurelle-logo.svg" alt="Aurelle" width="40"> Aurelle

[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)

**A private, self-hosted messenger with end-to-end encrypted calls and round video messages.**

</div>

Aurelle is a fork of [Songbird](https://github.com/bllackbull/Songbird) (MIT) that adds end-to-end encrypted voice and video calls and Telegram-style round video messages, designed to be gentle on battery and mobile data. The name comes from the Latin *aurum*, gold.

## Key Features

- 📞 **Encrypted calls**: one-to-one voice and video calls, end-to-end encrypted, peer-to-peer, with a verification emoji code and safety numbers
- ⭕ **Round video messages**: record up to 60 s, encrypted on your device; recipients download and decrypt only when they press play
- 🔋 **Light on battery and data**: Opus DTX at 24 kbps, hardware-friendly codecs, adaptive video that falls back to audio-only, camera released in the background
- 🛡️ **High-security option**: route every call through your own relay so peers never learn each other's IP address
- 💬 **Chat types**: Direct messages, groups, and channels
- 📁 **Media Support**: File uploads, voice messages, video transcoding
- 🔔 **Push Notifications**: Web push with VAPID (also for incoming calls)
- 📡 **Remote Channels**: Mirror Telegram or Aurelle channels
- 🛡️ **Admin Panel**: Full management interface with owner role
- 🔒 **Security**: Encryption at rest, bcrypt hashing, rate limiting
- 📱 **PWA**: Installable progressive web app
- ☁️ **Cloud Deployment**: PaaS and CaaS deployment with object storage support
- 🌍 **i18n**: English and Persian/Farsi support

## What is encrypted

| | End-to-end encrypted |
|---|---|
| Call audio and video | ✅ |
| Call signaling (SDP, ICE) | ✅ |
| Round video messages (and their preview) | ✅ |
| Text messages, voice messages, files | ❌ (encrypted at rest on the server) |

The server can still see metadata (who talks to whom, when, sizes). Read the [threat model](docs/E2EE-Protocol.md#threat-model) before relying on it: like every browser-based end-to-end encryption, the code is delivered by the server, so verify safety numbers with the people you care about.

## Quick Start

Aurelle is built from source. With Docker:

```bash
git clone https://github.com/elia2000/Aurelia.git
cd Aurelle
cp .env.example .env
bash scripts/gen-certs.sh    # self-signed TLS certificate for testing -> certs/cert.pem, certs/key.pem
docker compose up -d --build
```

The bundled nginx needs `certs/cert.pem` and `certs/key.pem` before it can start (if they are missing, Docker creates empty directories with those names and nginx keeps restarting). `scripts/gen-certs.sh` creates a self-signed pair for testing; pass your domain or IP to cover it (`bash scripts/gen-certs.sh example.com`). Browsers will show a security warning and push notifications will not work with it, so for real use install a proper certificate: see [SSL Certificates](docs/SSL-Certificates.md).

Or on an Ubuntu server (22.04+) with `sudo`, use the deployment script:

```bash
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | bash
```

> [!TIP]
> A domain name pointing to your server's public IP is recommended. **HTTPS is required** for calls, video messages and push notifications (except on `localhost`).

For calls between different networks, enable the bundled relay: `docker compose --profile calls up -d` after setting `CALLS_TURN_SECRET`, `CALLS_TURN_URLS` and `CALLS_TURN_EXTERNAL_IP` in `.env`. See [Calls & Video Messages](docs/Calls-and-Video-Messages.md).

> [!NOTE]
> Internal names (the `songbird` Docker service, the `songbird-deploy` command, `songbird.db`, cookie and storage keys) are kept from the original project so existing deployments keep working.

## Documentation

The documentation lives in [`docs/`](docs/) (VitePress, English and Persian). Run `npm run docs:dev` to browse it locally.

- [Calls & Video Messages](docs/Calls-and-Video-Messages.md)
- [End-to-End Encryption Protocol](docs/E2EE-Protocol.md) (for native app developers)
- [Deployment Script](docs/Deployment-Script.md)
- [Install via Docker](docs/Installation-Docker.md)
- [Cloud Deployment](docs/Cloud-Deployment.md)
- [Manual Installation](docs/Manual-Installation.md)
- [Configure Nginx](docs/Nginx-Configuration.md)
- [SSL Certificates](docs/SSL-Certificates.md)
- [Environment Variables](docs/Environment-Variables.md)
- [Object Storage](docs/Object-Storage.md)
- [Media Worker](docs/Media-Worker.md)
- [Admin Panel](docs/Admin-Panel.md)
- [Troubleshooting](docs/Troubleshooting.md)

## Credits

Aurelle is built on [Songbird](https://github.com/bllackbull/Songbird) by [@bllackbull](https://github.com/bllackbull) and its contributors ([@nkhalili](https://github.com/nkhalili), [@modos](https://github.com/modos), [@iPmartNetwork](https://github.com/iPmartNetwork)), released under the MIT License. Their copyright notice is kept in [LICENSE](LICENSE).

## Contributing

Issues and pull requests are welcome. See [Contributing](/CONTRIBUTING.md).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
