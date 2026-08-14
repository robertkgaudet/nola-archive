# NOLA Auth Header Fix — install note

## Install (4 steps)

1. In wp-admin, go to **Plugins → Add New → Upload Plugin**.
2. Choose **`nola-auth-header.zip`** and click **Install Now**.
3. Click **Activate Plugin**.
4. Back on Rob's machine, run `npm run wp:check` in `C:\source\nola-archive`.

## What success looks like

`npm run wp:check` prints the authenticated account:

```
Authenticated as <name> (id 1, roles: administrator)
  publish_posts: true  delete_posts: true
```

Then `npm run wp:test` creates the private test post.

## What it does

noladmc.com's server does not pass the HTTP `Authorization` header through to
PHP, so WordPress never sees the application password and returns
`401 rest_not_logged_in` — the same response it gives when no credential was
sent at all.

The plugin recovers that header from wherever the server left it
(`HTTP_AUTHORIZATION`, `REDIRECT_HTTP_AUTHORIZATION`, or
`apache_request_headers()`), then decodes the Basic credential into
`PHP_AUTH_USER` / `PHP_AUTH_PW` — which is what WordPress actually reads. Under
normal mod_php hosting the server does this itself; under CGI/FastCGI it does
not.

It is inert on a working server: if the credential is already present it
returns immediately. No admin UI, no REST routes, no network calls, no error
log output.

## If wp:check still returns 401 after activating

**This is possible and it is not a fault in the plugin.** Some hosts strip the
header at the web-server layer, before PHP starts. Nothing running inside
WordPress can recover a header that never reached the PHP process.

Two things to try first, in order:

1. **Deactivate any security plugin** (Wordfence, iThemes/Solid Security, All In
   One WP Security) and re-run `npm run wp:check`. Several block REST
   authentication for non-logged-in requests by default. If that fixes it, the
   setting is usually called something like "Disable REST API" or "Block
   application passwords" and can be turned off without deactivating the plugin.

2. **Install as a must-use plugin instead.** If Rob has file access via a host
   file manager or FTP (not full server access — just the WordPress folder),
   copy `nola-auth-header.php` to `wp-content/mu-plugins/` (create the folder if
   it doesn't exist). Must-use plugins load earlier than regular ones, which
   occasionally makes the difference. No activation step — mu-plugins are always
   on.

### Option B — the host ticket

If neither works, the fix has to happen at the server and only the host can do
it. Send them this:

> The server is not passing the HTTP `Authorization` header through to PHP, so
> WordPress REST API application passwords fail with 401. Please enable
> `HTTP_AUTHORIZATION` pass-through for this site — on Apache/LiteSpeed that is
> the `RewriteRule .* - [e=HTTP_AUTHORIZATION:%{HTTP:Authorization}]` rewrite or
> `CGIPassAuth On`; on nginx it is
> `fastcgi_param HTTP_AUTHORIZATION $http_authorization;`.

That sentence is the whole ticket — it names the symptom and the fix, so it
should not need a back-and-forth.

## Removing it

Once the host fixes the header at the server level, this plugin is redundant and
can be deactivated and deleted. It does no harm if left active.
