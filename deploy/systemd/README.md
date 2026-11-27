# systemd units

Deployment template for the chart application half of dsh-ziwei. It is a
hand-written copy of the unit the author runs, with this machine's absolute paths
replaced by the `/opt/dsh/<repo>` convention.

| File | Installs as | Service |
| --- | --- | --- |
| `dsh-ziwei-app.service.example` | `/etc/systemd/system/dsh-ziwei-app.service` | Next.js chart app on `127.0.0.1:8815` |

`/opt/dsh/dsh-ziwei` is an example path, not a requirement: after `git clone` to
wherever you keep checkouts, replace it in `WorkingDirectory` and
`EnvironmentFile`. The plugin half has no unit — it is loaded by the DSH Web
process and borrows its port.

## Install

```sh
sudo git clone https://github.com/frankfurtlin/dsh-ziwei /opt/dsh/dsh-ziwei
cd /opt/dsh/dsh-ziwei/app && npm ci && npm run build      # produces app/.next

cd /opt/dsh/dsh-ziwei
sudo cp deploy/systemd/dsh-ziwei-app.service.example /etc/systemd/system/dsh-ziwei-app.service
# edit the copy: checkout path, NEXT_PUBLIC_SITE_URL, node interpreter if you use nvm
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-ziwei-app
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8815/ziwei/chart
```

Then install the plugin (`dsh plugin add <path-to-your-checkout>`, or the Plugins
page), add `dsh-ziwei` to `dsh.profile.bundles`, and reload the page. **The app
must be built before the unit starts**: `next start` exits immediately when
`.next` is missing, so build first and restart the unit after every rebuild.

`app/next.config.js` pins `basePath: '/ziwei'` and the unit sets
`NEXT_PUBLIC_BASE_PATH=/ziwei`; both must match the prefix the plugin proxies, or
the panel renders an unstyled 404.

## Why the `.service.example` suffix

systemd only loads files whose name ends in exactly `.service` from its unit
search path (`/etc/systemd/system`, `/run/systemd/system`, `/usr/lib/systemd/system`).
A `*.service.example` file inside a git checkout is therefore inert: it is not
scanned, it cannot be pulled in by `systemctl enable`, and cloning the repo never
adds a unit. The copy step above is the only thing that activates it.

The plugin package does not ship units either: `dsh plugin add` symlinks the
checkout into the DSH profile and only `lib/`, `client.js` and
`cordis.patch.yml` are loaded.

## Verification

```sh
sed 's#/opt/dsh/dsh-ziwei#/your/checkout#g' \
  deploy/systemd/dsh-ziwei-app.service.example > /tmp/dsh-ziwei-app.service
systemd-analyze verify /tmp/dsh-ziwei-app.service
```

`systemd-analyze verify` must not report syntax errors. Warnings about host
dependencies are expected on a machine that does not run this service.

## User and permissions

The unit ships `User=root` because that is what the author runs. For a production
host, create a dedicated account and hand it the checkout:

```sh
sudo useradd --system --home /opt/dsh/dsh-ziwei --shell /usr/sbin/nologin ziwei
sudo chown -R ziwei:ziwei /opt/dsh/dsh-ziwei/app/.next
# then set User=ziwei / Group=ziwei in the unit
```

Birth records are not kept in the app: they live on the host side, in
`$DSH_HOME/ziwei/birth.json` (mode `600`), written by the plugin process.
