FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production CATALOG_HOST=0.0.0.0 PORT=8788
COPY --chown=node:node server/catalog.ts server/catalog-platforms.ts ./server/
COPY --chown=node:node shared/types.ts ./shared/types.ts
USER node
EXPOSE 8788
CMD ["node", "--experimental-strip-types", "server/catalog.ts"]
