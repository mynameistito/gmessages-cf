/** Container entrypoint: keep the AGPL Go adapter behind loopback HTTP IPC. */
const port = Number(Bun.env.PORT ?? "8787");
const adapter = Bun.spawn(["/usr/local/bin/gmessages-adapter"], {
  env: { ...Bun.env, PORT: "8788" },
  stderr: "inherit",
  stdout: "ignore",
});

const stopWrapperWhenAdapterStops = async () => {
  await adapter.exited;
  process.exit(1);
};
void stopWrapperWhenAdapterStops();

Bun.serve({
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return fetch("http://127.0.0.1:8788/healthz");
    }
    if (!url.pathname.startsWith("/v1/")) {
      return new Response("Not found", { status: 404 });
    }
    return fetch(
      new Request(`http://127.0.0.1:8788${url.pathname}${url.search}`, request)
    );
  },
  port,
});
