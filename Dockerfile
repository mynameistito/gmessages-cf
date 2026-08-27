FROM golang:1.26@sha256:ba4c8df3f74321b0d5c44911ccb694c8156340b684eed1fae09a9bd9f7a82b4d AS adapter
# Rebuild this stage when the local adapter implementation changes.
WORKDIR /src
COPY gmessages ./gmessages
COPY adapter ./adapter
RUN cd adapter && go build -o /out/gmessages-adapter ./cmd/server

FROM oven/bun:1@sha256:18639686662e5cd8a963ffb967dd130034a2a2d076a52e65dfd4fe18f75cc038
COPY --from=adapter /out/gmessages-adapter /usr/local/bin/gmessages-adapter
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src ./src
EXPOSE 8787
CMD ["bun", "run", "src/container/runtime.ts"]
