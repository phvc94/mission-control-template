# Security and sharing

## Code and data are separate

This template contains only code and fictional examples: no real account
configuration, no encrypted credentials, no operational data, conversations or backups.

Before sharing your copy, review names, emails, domains, account identifiers,
tests, screenshots and documentation; a secret scanner of your choice helps but
does not prove that no personal data is present.

Never upload a real `.env`, device identities, keys, tokens, SQLite files, logs,
attachments, runtime state or backups, even to a private repository.
`.gitignore` reduces accidents, but it does not protect files Git already tracks.

## Sign-in

`MC_AUTH` decides who may use the dashboard (details in [INSTALL.md](INSTALL.md#3-sign-in)):

- `none` is accepted only when the dashboard is opened at 127.0.0.1/localhost and
  listens on loopback (or, in a container, with its port published on the host
  loopback and `MC_ALLOW_UNAUTHENTICATED_BIND=1`). Anyone who can use that computer
  can use the dashboard.
- `token` compares the token in constant time, rate-limits failures, and keeps the
  browser session in a signed, expiring HttpOnly SameSite=Strict cookie (Secure on
  https). The signing key derives from the token, so changing it signs everyone out.
  Outside 127.0.0.1 it requires an `https://` origin.
- `proxy` trusts one header set by your reverse proxy. The port must be reachable
  only through that proxy, and the proxy must overwrite the header.
- `cloudflare-access` checks the Access JWT again on every request: signature,
  issuer, audience, expiry and the allowed emails.

Every request is also checked for the configured host, and every change for the
same origin. User names and branding in the browser grant no access.

The dashboard's OpenClaw identity has administrative scopes. It can change models,
routines, documents and tasks, and it can chat with agents. Approve that device only
on your own installation, and check its exact device ID.
Never grant these scopes to someone else's identity.

## Demo

`npm run demo` starts a separate, read-only entry point on loopback.
It creates a temporary fictional workspace and ignores the production variables.
Never publish that entry point or add real data to it.

## Checking your installation

1. Without login: the home page, the status API, documents, exports and JavaScript must be refused.
2. With your login: confirm your name, your agents and your projects.
3. With another account: access must be refused.
4. Test writes first on a disposable workspace of your own, and check the commit and the audit log.
5. Confirm you can restore the data and the credentials before relying on the dashboard.

The container health check (`/healthz`) only proves that HTTP answers; it does
not prove that the Gateway, metrics or documents are working.

If a credential is exposed, revoke it in the corresponding service.
Deleting the file in a new commit does not remove it from the history.
