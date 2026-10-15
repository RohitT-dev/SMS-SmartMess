# Web Security Headers Specification

This application processes zero-knowledge encrypted personal data and confidential military room allocations. To defend against Cross-Site Scripting (XSS), clickjacking, MIME-sniffing, and data exfiltration, the web deployment must enforce strict HTTP response headers.

## 1. Required Headers

| Header | Value | Purpose |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';` | Blocks unauthorized script injection, external font/image exfiltration, and restricts network calls strictly to self and Supabase. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Forces modern browsers to only connect over HTTPS with 2-year caching. |
| `X-Content-Type-Options` | `nosniff` | Disables MIME type sniffing to prevent malicious file uploads from executing as code. |
| `X-Frame-Options` | `DENY` | Rejects embedding in `<iframe>`, `<frame>`, or `<object>` to eliminate UI redressing (clickjacking). |
| `Referrer-Policy` | `no-referrer` | Ensures no URL paths, tokens, or query strings leak in the HTTP `Referer` header. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | Disables sensitive browser hardware APIs. |

## 2. Static Hosting Setup (`public/_headers`)

For Cloudflare Pages, Netlify, or similar static frontends, the root headers file is committed at `public/_headers`:

```http
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

## 3. Reverse Proxy Configuration (Nginx Example)

If served via Nginx behind a load balancer:

```nginx
server {
    listen 443 ssl http2;
    server_name mess.internal;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;

    location / {
        root /var/www/sms/dist;
        try_files $uri $uri/ /index.html;
    }
}
```
