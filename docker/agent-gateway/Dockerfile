FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

ENV NODE_ENV=production \
    AGENT_GATEWAY_HOST=0.0.0.0 \
    AGENT_GATEWAY_PORT=8787

WORKDIR /app
LABEL org.opencode-lab.gateway-protocol="renewable-v1"
COPY --chown=node:node \
  artifact-network.mjs \
  capability-lease.mjs \
  gateway-errors.mjs \
  gateway-http.mjs \
  gateway-models.mjs \
  gateway-routes.mjs \
  lease-transport.mjs \
  gateway.mjs \
  server.mjs \
  ./

# This service executes only checked-in ESM with the Node runtime. Removing the
# bundled package manager reduces the production image and prevents npm's
# transitive tools from becoming an unnecessary runtime vulnerability surface.
RUN rm -rf -- /usr/local/lib/node_modules/npm \
  && rm -f -- /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/server.mjs"]
