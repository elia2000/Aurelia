# Security Policy

## Reporting a vulnerability

Please report security problems **privately**. Do not open a public issue, pull request or discussion for them.

Use GitHub's private vulnerability reporting for this repository:

1. Open <https://github.com/elia2000/Aurelia/security/advisories/new> (or go to the repository, **Security** tab, **Report a vulnerability**).
2. Describe what you found, how to reproduce it, which version or commit you tested (see the `VERSION` file in the installation directory), and what an attacker could do with it.
3. Send the report. Only the maintainers and you can see it.

If you cannot use GitHub's form, open a public issue that says only that you have a security report and asks for a private way to send it. Do not put any details in the issue.

Please include, if you can:

- the steps or a small proof of concept (no real user data, please)
- whether it needs a signed-in account, an admin account, or nothing
- how you run Aurelle (deployment script, Docker, manual install) and behind which proxy or CDN, if any

## What to expect

- We acknowledge a report within a few days and keep you informed while we work on it.
- We fix confirmed problems in the next release where we can, and sooner for serious ones. The fix, the affected versions and a credit (if you want one) are published as a GitHub security advisory once a fixed version is available.
- Please give us a reasonable time to fix a problem before you tell anyone else about it.

## Supported versions

Only the latest release receives security fixes. Please update before reporting, and see [Security Maintenance](docs/Security-Maintenance.md) for how to update and how to check the dependencies of your own installation.

## Scope

In scope: the Aurelle server (`server/`), the web client (`client/`), the media worker (`worker/`), the installer and deployment files (`scripts/`, `Dockerfile`, `docker-compose.yaml`, `nginx/`), and the documentation when it leads to an insecure setup.

Out of scope: problems that need a machine you already control (a rooted server, a stolen unlocked phone), denial of service by sheer traffic volume, reports from automated scanners without a demonstrated impact, and vulnerabilities in a third-party service you use with Aurelle (report those to that project).

## Dependency advisories

Aurelle's dependencies are checked with `npm audit` and updated with each release; GitHub Dependabot opens update pull requests once a month. If you find a vulnerable dependency that is reachable in Aurelle, report it the same way as any other vulnerability.
