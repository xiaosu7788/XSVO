# XSVO Nginx reverse proxy

Use this when XSVO is behind host-level Nginx and image generation or image edit requests fail with `413 Request Entity Too Large`.

The example config in `xsvo.conf` sets:

```nginx
client_max_body_size 500m;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

Install it on the server:

```bash
sudo cp deploy/nginx/xsvo.conf /etc/nginx/sites-available/xsvo.conf
sudo ln -sf /etc/nginx/sites-available/xsvo.conf /etc/nginx/sites-enabled/xsvo.conf
sudo nginx -t
sudo systemctl reload nginx
```

Replace `server_name _;` with the real domain when the same Nginx instance hosts multiple sites.

If the `413` response comes from the upstream model channel's Nginx, apply the same `client_max_body_size` setting on that upstream server. XSVO cannot bypass a body-size limit enforced before the request reaches the model API.
