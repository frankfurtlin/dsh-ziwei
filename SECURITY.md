# Security Policy

`dsh-ziwei` is a personal, self-hosted project. It is maintained by one person in their spare
time: there is no bug bounty, no guaranteed response time, and no security team. That said,
reports are taken seriously and handled as quickly as possible.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request containing exploit details, a
proof-of-concept payload, or step-by-step reproduction.** A public report is effectively a
0-day disclosure.

Please use GitHub's private vulnerability reporting instead:

1. Open the repository's **Security** tab → **Report a vulnerability**
   (direct link: <https://github.com/frankfurtlin/dsh-ziwei/security/advisories/new>).
2. Describe the affected version or commit, the impact, and reproduction steps. Attach any
   proof of concept inside the advisory, not in a public channel.
3. I will confirm the report and coordinate the fix and disclosure date in the advisory.

If private reporting is unavailable for some reason, open an issue **without any details**
saying that you have a security report and would like a private channel, and we will move to
one before you share specifics.

## Supported versions

Only the latest commit on `main` is supported. This is a personal project: there are no
backports to older tags or release branches. Fixes land on `main` and are announced in the
advisory once released.

## Scope

In scope:

- This repository: the plugin (host half under `lib/`, client half in `client.js`), its
  chart/reading endpoints, local birth-data storage, and the embedded Next.js app under `app/`
  including its reverse-proxied routes.

Out of scope:

- The DSH host itself and other plugins/projects — report those to their own repositories.
- Operator misconfiguration, e.g. exposing the service to the public internet without
  authentication, or committing credentials/secrets (provider keys, birth data).
- Issues that require an attacker to already have local shell or root access to the host.
- Known CVEs in third-party dependencies, unless code in this repository makes them
  exploitable. Dependency upgrades are still welcome as normal pull requests.
- Social engineering, physical access, and DoS/load tests against instances you do not own.

## Handling

1. The report is acknowledged in the advisory.
2. A fix is prepared privately where practical, then merged to `main`.
3. The advisory is published after the fix is released; credit is given unless you ask to stay
   anonymous.

## Please don't

- Post exploit details publicly;
- Scan or load-test instances you do not own;
- Open pull requests that contain malicious code.
