FROM golang:1.26 AS adapter
WORKDIR /src
COPY gmessages ./gmessages
RUN cd gmessages && go build -o /out/gmessages-adapter ./cmd/server

FROM oven/bun:1
COPY --from=adapter /out/gmessages-adapter /usr/local/bin/gmessages-adapter
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src ./src
EXPOSE 8787
CMD ["bun", "run", "src/container/runtime.ts"]
