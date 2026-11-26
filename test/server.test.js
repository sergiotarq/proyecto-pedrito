"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");
const path = require("node:path");
const { WebSocket } = require("ws");

const root = path.join(__dirname, "..");
let server;
let baseUrl;
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
    const timeout = setTimeout(() => reject(new Error("Se esperaba que la conexión fuera rechazada.")), 3000);
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

before(async () => {
  server = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      MATCH_DURATION_MS: "1000",
      PUBLIC_URL: "https://pong.example.test",
      PONG_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForServer(server);
  baseUrl = `http://127.0.0.1:${port}`;
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

test("serves the invite QR and enforces the creator-started sudden-death match flow", async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /start-match/);

  const css = await fetch(`${baseUrl}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);

  const configResponse = await fetch(`${baseUrl}/config`);
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.matchDurationMs, 1000);
  assert.equal(new URL(config.joinUrl).origin, "https://pong.example.test");
  assert.match(new URL(config.joinUrl).searchParams.get("join"), /^[a-f0-9]{24}$/);

  const qr = await fetch(`${baseUrl}/qr.png`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /image\/png/);
  assert.deepEqual([...new Uint8Array(await qr.arrayBuffer()).slice(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);

  const websocketUrl = `ws://127.0.0.1:${new URL(baseUrl).port}/ws`;
  const blocked = new WebSocket(websocketUrl, { origin: "https://example.com" });
  const rejection = await new Promise((resolve) => {
    blocked.once("unexpected-response", (_request, response) => resolve(response.statusCode));
  });
  assert.equal(rejection, 403);

  const joinUrl = new URL(config.joinUrl);
  const joinToken = joinUrl.searchParams.get("join");
  const joinBeforeCreator = await createRejectedClient(`${websocketUrl}?join=${joinToken}`);
  assert.match(joinBeforeCreator.message, /creador debe abrir/);

  const creator = createClient(`${websocketUrl}?role=creator`);
  assert.deepEqual(await creator.waitFor("welcome"), { type: "welcome", player: 1 });
  const creatorWaiting = await creator.waitFor("waiting");
  assert.equal(creatorWaiting.connectedPlayers, 1);

  const joiner = createClient(`${websocketUrl}?join=${joinToken}`);
  assert.deepEqual(await joiner.waitFor("welcome"), { type: "welcome", player: 2 });
  const creatorReady = creator.waitFor(
    (message) => message.type === "waiting" && message.connectedPlayers === 2,
  );
  const joinerReady = joiner.waitFor(
    (message) => message.type === "waiting" && message.connectedPlayers === 2,
  );
  assert.equal((await creatorReady).connectedPlayers, 2);
  assert.equal((await joinerReady).connectedPlayers, 2);

  joiner.ws.send(JSON.stringify({ type: "start" }));
  assert.match((await joiner.waitFor("error")).message, /Solo el creador/);
  creator.ws.send(JSON.stringify({ type: "start" }));
  assert.equal((await creator.waitFor("start")).durationMs, 1000);
  await joiner.waitFor("start");

  const overtime = await creator.waitFor("overtime", 4000);
  assert.match(overtime.message, /muerte súbita/);
  const winner = await creator.waitFor("game_over", 6000);
  assert.equal(winner.reason, "sudden_death");
  assert.ok([1, 2].includes(winner.winner));
  assert.equal(winner.score.reduce((sum, score) => sum + score, 0), 1);
  await joiner.waitFor("game_over");

  joiner.ws.close();
  const opponentLeft = await creator.waitFor("opponent_left");
  assert.match(opponentLeft.message, /desconectó/);
});
