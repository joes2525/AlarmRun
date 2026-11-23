#!/bin/sh
# Run before each commit: stamps file links with a new version so phones/browsers fetch fresh copies.
V=$(date +%y%m%d%H%M)
sed -i -E "s#(css/tech\.css|js/tech\.js|css/app\.css|js/app\.js|js/cert\.js|config\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" tech.html index.html cert.html
