import { createServer } from "./app";

const port = Number(process.env.PORT || 3001);

const server = createServer().listen(port, "0.0.0.0", () => {
  console.log(`Instawork W-2 simulation API listening on ${port}`);
});

server.setTimeout(0);
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
