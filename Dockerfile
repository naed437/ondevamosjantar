# Static site: nginx serves the files as-is. No build step.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html style.css app.js /usr/share/nginx/html/
COPY lib/ /usr/share/nginx/html/lib/
EXPOSE 3000
