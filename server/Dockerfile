FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    CATALOG_HOST=0.0.0.0 \
    PORT=8788 \
    NODE_OPTIONS="--max-old-space-size=192"
COPY --chown=node:node server/catalog.ts server/catalog-platforms.ts ./server/
COPY --chown=node:node shared/types.ts shared/validation.ts ./shared/
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "server/catalog.ts"]
