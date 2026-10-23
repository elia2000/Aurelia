# Security Maintenance

Keeping an Aurelle server safe is mostly routine: update the app, keep Node.js current, and look at the dependency audit now and then. This page is that routine. To report a vulnerability, see the [security policy](https://github.com/elia2000/Aurelia/security/policy).

| How often | What to do |
|---|---|
| When a release is announced | [Update Aurelle](#updating-aurelle) |
| About once a month | [Audit the dependencies](#auditing-the-dependencies) and check the [Node.js version](#node-js-version) |
| Once, on a public server | Set up [Fail2ban](./Fail2ban.md) so a script that guesses passwords is banned |

## Updating Aurelle

Updates carry the security fixes, including updated dependencies, so this is the most useful thing you can do. The full procedure, with downgrades and database backups, is on the [Updating](./Updating.md) page. In short:

### Deployment script

```bash
songbird-deploy
```

Choose **Update Aurelle**. The script offers a database backup, pulls the new code, installs the dependencies from the lock files (`npm ci`, with `npm install` only as a fallback when a lock file is out of step), rebuilds the client, runs the database migrations and restarts the services.

### Manual install (systemd)

Back up the database first (`npm run db:backup` in `server/`), then:

```bash
cd /opt/songbird
git pull --ff-only origin main

# Install exactly what the lock files say; `npm ci` never rewrites them.
npm --prefix server ci
npm --prefix worker ci
npm --prefix client ci

npm --prefix client run build
(cd server && npm run db:migrate)

sudo systemctl restart songbird songbird-worker
```

Adjust the path if you did not install into `/opt/songbird`. Run these as the user that owns the installation, as in [Manual Installation](./Manual-Installation.md).

### Docker

```bash
cd /path/to/aurelle
git pull --ff-only origin main
docker compose up -d --build
```

The image build runs `npm ci` itself. The `nginx` container uses `nginx/nginx.conf` from the repository, so pulling also updates it; run `docker compose up -d` again if that file changed.

:::tip

Use `npm ci`, not `npm install`, on a server. `npm ci` installs exactly the versions in `package-lock.json` and stops with an error when the lock file and `package.json` disagree, so what runs is what was tested.

:::

## Node.js version

Aurelle needs **Node.js 24.18 or newer** and **npm 11.18 or newer** (the `engines` field in `package.json`). Check what the service uses:

```bash
node -v
npm -v
```

If it is older, install a current Node.js 24 the way you installed it the first time (NodeSource, nvm or Volta, see [Manual Installation](./Manual-Installation.md)), reinstall the dependencies with `npm ci` as above, and restart the services. Native modules such as `better-sqlite3` are built for one Node version, so they must be reinstalled after a Node upgrade. The deployment script's **Update Aurelle** does that for you.

Use a release line that still receives security fixes (an LTS line); the Node.js project lists them at [nodejs.org/en/about/previous-releases](https://nodejs.org/en/about/previous-releases).

## Auditing the dependencies

`npm audit` compares the versions in a lock file with the public advisory database. Run it in each part of the project:

```bash
cd /opt/songbird
for dir in server worker client; do
  echo "== $dir"; (cd "$dir" && npm audit --omit=dev)
done
```

`--omit=dev` limits the report to what is actually shipped. What each part contributes:

| Part | Ships in production? | Notes |
|---|---|---|
| `server/` | Yes | The API server. Its runtime dependencies (`express`, `compression`, `ws`, ...) handle every request. |
| `worker/` | Yes | The media worker. |
| `client/` | Yes, but only as compiled files | Its runtime dependencies (`react`, `dompurify`, `marked`, ...) are bundled into the web app that browsers download. Fix these first: they run in your users' browsers. |
| root (`package.json`) | No | The documentation site and the release tooling. Never installed on the server. |

Everything else in the lock files (the test runner, the build tool, the linter) only runs on a developer machine or in CI. `npm audit` without `--omit=dev` lists those too; they matter much less, but are worth updating when a fix is easy.

### Fixing what the audit finds

```bash
cd server            # or worker, or client
npm audit fix        # patch and minor updates inside the ranges in package.json
npm test             # or the checks below
```

- Do **not** use `npm audit fix --force`. It makes major-version jumps, sometimes downgrades, and can break the app. Read the advisory first and decide.
- `npm audit fix` changes `package-lock.json`. Review the diff: only the packages named in the report and their dependencies should change.
- If an advisory has **no fixed version** yet (`npm audit` says "No fix available"), there is nothing to install. Check whether the vulnerable code is reachable from Aurelle, and watch for a fix.
- Packages that are listed only through a tool you do not run on the server (for example the release tooling in the root project) can wait.
- Then run the checks for what you changed: `npx vitest run` in `server/` and `worker/`; in `client/`, `npx vitest run --project unit`, `npx eslint src test` and `npm run build`; `npm run docs:build` in the root.

:::info

The `vitest` packages (`vitest`, `@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-v8`, `@vitest/ui`) require the exact same version of each other. When one is updated by hand, raise all of them in `package.json` together; otherwise npm stops with an `ERESOLVE` error.

:::

### Automatic update pull requests

The repository has GitHub Dependabot turned on (`.github/dependabot.yml`): once a month it opens one pull request per part with the dependency updates. Merge them after the tests pass. This keeps updates small, which is the safest way to stay current.

### If `npm audit` cannot run

`npm audit` needs to reach the npm registry. Behind a proxy or without internet it fails with a network error and prints nothing useful. Run it from a machine that can, on a checkout of the same version (the lock files are what is audited, not the installed `node_modules`). `npm ls` shows which versions are installed.

## After a security update

1. Check that the site loads and you can sign in: `curl -s https://your-domain/api/health`.
2. Look at the service log for errors: `sudo journalctl -u songbird -n 50`.
3. Hard-refresh the browser (or close and reopen the installed app) so it loads the new client files.

## See also

- [Updating](./Updating.md): updates and downgrades for every install method
- [Fail2ban](./Fail2ban.md): ban addresses that guess passwords or flood the server
- [Environment Variables](./Environment-Variables.md)
- [Running behind a CDN](./CDN-Setup.md)
