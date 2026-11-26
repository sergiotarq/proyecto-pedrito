"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");
const path = require("node:path");
const { WebSocket } = require("ws");

const root = path.join(__dirname, "..");
let server;
let baseUrl;
let websocketUrl;
const clients = [];

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`El servidor no inició a tiempo. Salida: ${output}`));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!baseUrl) {
        clearTimeout(timeout);
        reject(new Error(`El servidor terminó con código ${code}. ${output}`));
      }
    });
  });
}

function createClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  const client = {
    ws,
    waitFor(expected, timeoutMs = 3000) {
      const matches = typeof expected === "function"
        ? expected
        : (message) => message.type === expected;
      const existingIndex = messages.findIndex(matches);
      if (existingIndex >= 0) {
        return Promise.resolve(messages.splice(existingIndex, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("No se recibió el mensaje WebSocket esperado."));
        }, timeoutMs);
        const waiter = {
          matches,
          resolve(message) {
            clearTimeout(timer);
            resolve(message);
          },
        };
        waiters.push(waiter);
      });
    },
  };
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.matches(message));
    if (waiterIndex >= 0) {
      waiters.splice(waiterIndex, 1)[0].resolve(message);
    } else if (message.type !== "state") {
      messages.push(message);
    }
  });
  clients.push(client);
  return client;
}

function createRejectedClient(url) {
  const ws = new WebSocket(url);
  clients.push({ ws });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Se esperaba que la conexión fuera rechazada.")),
      3000,
    );
    ws.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function getRooms() {
  const response = await fetch(`${baseUrl}/api/rooms`, { cache: "no-store" });
  assert.equal(response.status, 200);
  return (await response.json()).rooms;
}

before(async () => {
  server = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      MATCH_DURATION_MS: "1000",
      PUBLIC_URL: "",
      RENDER_EXTERNAL_URL: "https://pong.example.test",
      PONG_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForServer(server);
  baseUrl = `http://127.0.0.1:${port}`;
  websocketUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  for (const { ws } of clients) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }
  if (server && server.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill("SIGTERM");
    });
  }
});

test("serves the menu, duration choices, and an empty public room list", async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Jugar por 2/);
  assert.match(html, /Crear partida/);
  assert.match(html, /Buscar partidas/);

  const css = await fetch(`${baseUrl}/styles.css`);
  assert.match(css.headers.get("content-type"), /text\/css/);
  const script = await fetch(`${baseUrl}/app.js`);
  assert.match(script.headers.get("content-type"), /javascript/);

  const config = await (await fetch(`${baseUrl}/config`)).json();
  assert.deepEqual(config.durationOptions, [1, 2, 3, 5, 10]);
  assert.equal(config.publicUrl, "https://pong.example.test");
  assert.deepEqual(await getRooms(), []);
});

test("lists named rooms, joins the selected room, and enforces host start and sudden death", async () => {
  const blocked = new WebSocket(websocketUrl, { origin: "https://example.com" });
  const rejection = await new Promise((resolve) => {
    blocked.once("unexpected-response", (_request, response) => resolve(response.statusCode));
  });
  assert.equal(rejection, 403);

  const invalidDuration = await createRejectedClient(
    `${websocketUrl}?action=create&name=Bad&duration=99`,
  );
  assert.match(invalidDuration.message, /duración válida/);

  const hostA = createClient(`${websocketUrl}?action=create&name=Ana&duration=1`);
  const welcomeA = await hostA.waitFor("welcome");
  assert.equal(welcomeA.player, 1);
  assert.equal(welcomeA.roomName, "Ana");
  assert.equal(welcomeA.durationMinutes, 1);
  assert.equal((await hostA.waitFor("waiting")).connectedPlayers, 1);

  const hostB = createClient(`${websocketUrl}?action=create&name=Bruno&duration=5`);
  const welcomeB = await hostB.waitFor("welcome");
  assert.equal(welcomeB.roomName, "Bruno");
  const waitingRooms = await getRooms();
  assert.deepEqual(waitingRooms.map(({ name }) => name).sort(), ["Ana", "Bruno"]);

  const qr = await fetch(`${baseUrl}/qr.png?room=${welcomeA.roomId}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /image\/png/);
  assert.deepEqual([...new Uint8Array(await qr.arrayBuffer()).slice(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);

  const joiner = createClient(`${websocketUrl}?room=${welcomeA.roomId}`);
  const joined = await joiner.waitFor("welcome");
  assert.equal(joined.player, 2);
  assert.equal(joined.roomName, "Ana");
  const hostReady = hostA.waitFor(
    (message) => message.type === "waiting" && message.connectedPlayers === 2,
  );
  const joinerReady = joiner.waitFor(
    (message) => message.type === "waiting" && message.connectedPlayers === 2,
  );
  await hostReady;
  await joinerReady;
  assert.deepEqual((await getRooms()).map(({ name }) => name), ["Bruno"]);

  joiner.ws.send(JSON.stringify({ type: "start" }));
  assert.match((await joiner.waitFor("error")).message, /Solo el anfitrión/);
  hostA.ws.send(JSON.stringify({ type: "start" }));
  assert.equal((await hostA.waitFor("start")).durationMs, 1000);
  await joiner.waitFor("start");
  const overtime = await hostA.waitFor("overtime", 4000);
  assert.match(overtime.message, /muerte súbita/);
  const winner = await hostA.waitFor("game_over", 6000);
  assert.equal(winner.reason, "sudden_death");
  assert.ok([1, 2].includes(winner.winner));
  assert.equal(winner.score.reduce((sum, score) => sum + score, 0), 1);
  await joiner.waitFor("game_over");

  const hostWaiting = hostA.waitFor(
    (message) => message.type === "waiting" && message.connectedPlayers === 1,
  );
  joiner.ws.close();
  await hostWaiting;
  assert.deepEqual((await getRooms()).map(({ name }) => name), ["Ana", "Bruno"]);
});

test("closes a waiting room when its host disconnects", async () => {
  const host = createClient(`${websocketUrl}?action=create&name=Temporal&duration=2`);
  const welcome = await host.waitFor("welcome");
  assert.equal((await getRooms()).some((room) => room.id === welcome.roomId), true);
  const socketClosed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("El anfitrión no cerró su conexión.")), 3000);
    host.ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  host.ws.close();
  await socketClosed;
  assert.equal((await getRooms()).some((room) => room.id === welcome.roomId), false);
});
