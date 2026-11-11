FROM node:22.23.4-bookworm-slim
WORKDIR /opt/product
COPY . .
CMD ["sh", "-c", "mkdir -p /tmp/product-run && cp -R /opt/product/. /tmp/product-run/ && cd /tmp/product-run && npm test && npm run build && npm run acceptance"]
