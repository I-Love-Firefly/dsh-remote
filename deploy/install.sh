#!/bin/sh
# Run only after reviewing the HTTPS exposure and generating server.env.
set -eu
cd "$(dirname "$0")/.."
test -f .private/server.env || { echo 'Missing .private/server.env'; exit 1; }
command -v docker >/dev/null
docker inspect dsh-remote >/dev/null 2>&1 && { echo 'Container already exists; review upgrade manually.'; exit 1; }
docker build -f deploy/Dockerfile -t dsh-remote:0.1.0 .
docker run -d --name dsh-remote --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 1 --pids-limit 100 \
  --env-file .private/server.env -p 127.0.0.1:8787:8787 dsh-remote:0.1.0
echo 'Container started on loopback. Review and add deploy/nginx-location.conf to the intended HTTPS virtual host, then nginx -t && systemctl reload nginx.'
