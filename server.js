"use strict";

const http = require("node:http");
const { readFile } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const { getTimeoutResult } = require("./game-rules");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8080);
const WIDTH = 1000;
const HEIGHT = 600;
const TICK_RATE = 60;
const MATCH_DURATION_MS = Number(process.env.MATCH_DURATION_MS || 120000);
const PADDLE_WIDTH = 14;
const PADDLE_HEIGHT = 100;
const BALL_RADIUS = 10;
const PADDLE_VERTICAL_SPEED = 420;
const PADDLE_HORIZONTAL_SPEED = 300;
const BALL_START_SPEED_X = 360;
const BALL_START_SPEED_Y = 210;
const WEB_ROOT = __dirname;
const GAME_URL = "http://localhost/";
const ROOM_TOKEN = randomBytes(12).toString("hex");
const PUBLIC_URL = parsePublicUrl(process.env.PUBLIC_URL);
const WEB_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error("PORT debe ser un entero entre 0 y 65535.");
}
if (!Number.isInteger(MATCH_DURATION_MS) || MATCH_DURATION_MS <= 0) {
  throw new Error("MATCH_DURATION_MS debe ser un entero positivo.");
}

function parsePublicUrl(value) {
  if (!value) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_URL debe ser una URL HTTPS válida.");
  }
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(isLocalHost && url.protocol === "http:"))
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("PUBLIC_URL debe ser un origen HTTPS sin ruta, parámetros ni credenciales.");
  }
  return url.origin;
}

function makeJoinUrl(baseUrl) {
  const url = new URL("/", baseUrl);
  url.searchParams.set("join", ROOM_TOKEN);
  return url.toString();
}

const players = [];
let game = createGame();
let disconnectingPlayers = false;

function createGame() {
  return {
    started: false,
    scores: [0, 0],
    matchEndsAt: null,
    overtime: false,
    ball: { x: WIDTH / 2, y: HEIGHT / 2, vx: BALL_START_SPEED_X, vy: BALL_START_SPEED_Y },
    lastTick: Date.now(),
  };
}

function send(player, message) {
  if (player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(message));
  }
}

function broadcast(message) {
  for (const player of players) {
    send(player, message);
  }
}

function resetBall(direction = Math.random() < 0.5 ? -1 : 1) {
  game.ball = {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    vx: BALL_START_SPEED_X * direction,
    vy: BALL_START_SPEED_Y * (Math.random() < 0.5 ? -1 : 1),
  };
}

function makeState() {
  return {
    type: "state",
    width: WIDTH,
    height: HEIGHT,
    paddles: players.map(({ x, y }) => ({ x, y })),
    ball: { x: game.ball.x, y: game.ball.y },
    score: [...game.scores],
    remainingMs: game.started && !game.overtime
      ? Math.max(0, game.matchEndsAt - Date.now())
      : 0,
    overtime: game.overtime,
  };
}

function broadcastWaiting() {
  const connectedPlayers = players.length;
  const message = connectedPlayers === 2
    ? "Los dos jugadores están conectados. El creador puede iniciar."
    : "Comparte el QR o el enlace y espera a que se conecte el otro jugador.";
  broadcast({ type: "waiting", connectedPlayers, message });
}

function startOrRestartGame() {
  if (players.length !== 2 || game.started) {
    return false;
  }
  game.started = true;
  game.scores = [0, 0];
  game.overtime = false;
  game.matchEndsAt = Date.now() + MATCH_DURATION_MS;
  resetBall();
  game.lastTick = Date.now();
  broadcast({ type: "start", durationMs: MATCH_DURATION_MS });
  broadcast(makeState());
  console.log("Partida iniciada o reiniciada.");
  return true;
}

function finishForDisconnectedPlayer(leavingPlayer) {
  if (disconnectingPlayers || !players.includes(leavingPlayer)) {
    return;
  }

  disconnectingPlayers = true;
  game.started = false;
  game.overtime = false;
  game.matchEndsAt = null;
  const remainingPlayers = players.filter((player) => player !== leavingPlayer);
  players.length = 0;
  for (const player of remainingPlayers) {
    send(player, {
      type: "opponent_left",
      message: "El otro jugador se desconectó. Puedes volver a conectar para iniciar otra partida.",
    });
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.close(4001, "El otro jugador se desconectó");
    }
  }
  console.log(`Jugador ${leavingPlayer.id} desconectado; sala liberada.`);
  disconnectingPlayers = false;
}

function finishGame(winner, reason) {
  game.started = false;
  for (const player of players) {
    player.inputX = 0;
    player.inputY = 0;
  }
  broadcast({
    type: "game_over",
    winner,
    reason,
    score: [...game.scores],
  });
}

function handleTimeout() {
  const result = getTimeoutResult(game.scores);
  if (result.type === "overtime") {
    game.overtime = true;
    broadcast({ type: "overtime", message: "Empate: muerte súbita. El siguiente punto gana." });
    return;
  }
  finishGame(result.winner, "time");
}

function updateGame() {
  if (!game.started || players.length !== 2) {
    return;
  }

  const now = Date.now();
  if (!game.overtime && now >= game.matchEndsAt) {
    handleTimeout();
    if (!game.started) {
      broadcast(makeState());
      return;
    }
  }
  const dt = Math.min((now - game.lastTick) / 1000, 0.05);
  game.lastTick = now;

  for (const player of players) {
    const magnitude = Math.hypot(player.inputX, player.inputY);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    const xMin = player.id === 1 ? 35 : WIDTH / 2 + 60;
    const xMax = player.id === 1 ? WIDTH / 2 - 60 : WIDTH - 35;
    player.x = Math.max(
      xMin,
      Math.min(xMax, player.x + player.inputX * scale * PADDLE_HORIZONTAL_SPEED * dt),
    );
    player.y = Math.max(
      PADDLE_HEIGHT / 2,
      Math.min(
        HEIGHT - PADDLE_HEIGHT / 2,
        player.y + player.inputY * scale * PADDLE_VERTICAL_SPEED * dt,
      ),
    );
  }

  const { ball } = game;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.y - BALL_RADIUS <= 0 || ball.y + BALL_RADIUS >= HEIGHT) {
    ball.vy *= -1;
    ball.y = Math.max(BALL_RADIUS, Math.min(HEIGHT - BALL_RADIUS, ball.y));
  }

  const [leftPaddle, rightPaddle] = players;
  const leftEdge = leftPaddle.x + PADDLE_WIDTH / 2;
  const rightEdge = rightPaddle.x - PADDLE_WIDTH / 2;

  if (
    ball.vx < 0
    && ball.x - BALL_RADIUS <= leftEdge
    && ball.x >= leftPaddle.x - PADDLE_WIDTH / 2
    && Math.abs(ball.y - leftPaddle.y) <= PADDLE_HEIGHT / 2 + BALL_RADIUS
  ) {
    ball.vx = Math.abs(ball.vx) * 1.04;
    ball.x = leftEdge + BALL_RADIUS;
    ball.vy += (ball.y - leftPaddle.y) * 2.2;
  } else if (
    ball.vx > 0
    && ball.x + BALL_RADIUS >= rightEdge
    && ball.x <= rightPaddle.x + PADDLE_WIDTH / 2
    && Math.abs(ball.y - rightPaddle.y) <= PADDLE_HEIGHT / 2 + BALL_RADIUS
  ) {
    ball.vx = -Math.abs(ball.vx) * 1.04;
    ball.x = rightEdge - BALL_RADIUS;
    ball.vy += (ball.y - rightPaddle.y) * 2.2;
  }

  let pointFor = 0;
  if (ball.x < 0) {
    pointFor = 2;
  } else if (ball.x > WIDTH) {
    pointFor = 1;
  }

  if (pointFor) {
    game.scores[pointFor - 1] += 1;
    if (game.overtime) {
      finishGame(pointFor, "sudden_death");
    } else {
      resetBall(pointFor === 1 ? -1 : 1);
    }
  }

  broadcast(makeState());
}

function parseAxis(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    const parsedOrigin = new URL(origin);
    return (
      (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:")
      && parsedOrigin.host === request.headers.host
    );
  } catch {
    return false;
  }
}

const httpServer = http.createServer((request, response) => {
  const pathname = new URL(request.url, GAME_URL).pathname;
  if (request.method === "GET" && pathname === "/config") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({
      matchDurationMs: MATCH_DURATION_MS,
      joinUrl: PUBLIC_URL ? makeJoinUrl(PUBLIC_URL) : null,
      roomToken: ROOM_TOKEN,
    }));
    return;
  }
  if (request.method === "GET" && pathname === "/qr.png") {
    if (!PUBLIC_URL) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Configura PUBLIC_URL para generar un QR accesible por Internet.");
      return;
    }
    QRCode.toBuffer(makeJoinUrl(PUBLIC_URL), {
      type: "png",
      width: 256,
      margin: 2,
      errorCorrectionLevel: "M",
    }).then((image) => {
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(image);
    }).catch((error) => {
      console.error("No se pudo generar el código QR:", error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("No se pudo generar el código QR.");
    });
    return;
  }

  const file = WEB_FILES.get(pathname);
  if (request.method !== "GET" || !file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("No encontrado.");
    return;
  }

  readFile(path.join(WEB_ROOT, file[0]), (error, content) => {
    if (error) {
      console.error(`No se pudo leer ${file[0]}:`, error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("No se pudo cargar el juego.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(content);
  });
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });

httpServer.on("upgrade", (request, socket, head) => {
  if (
    new URL(request.url, GAME_URL).pathname !== "/ws"
    || !isSameOrigin(request)
  ) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit("connection", websocket, request);
  });
});

websocketServer.on("connection", (websocket, request) => {
  const connectionUrl = new URL(request.url, GAME_URL);
  const isCreator = connectionUrl.searchParams.get("role") === "creator";
  const joinToken = connectionUrl.searchParams.get("join");
  const isJoiner = joinToken === ROOM_TOKEN;
  let connectionError = null;

  if (isCreator && players.length !== 0) {
    connectionError = "Esta sala ya tiene un creador conectado.";
  } else if (isJoiner && players.length !== 1) {
    connectionError = "El creador debe abrir la sala antes de que te unas.";
  } else if (isJoiner && players[0].id !== 1) {
    connectionError = "No se encontró al creador de la sala.";
  } else if (!isCreator && !isJoiner) {
    connectionError = "Entra desde el enlace de invitación del creador.";
  } else if (players.length >= 2) {
    connectionError = "La sala ya tiene dos jugadores.";
  }

  if (connectionError) {
    websocket.send(JSON.stringify({ type: "error", message: connectionError }));
    websocket.close(1008, connectionError);
    return;
  }

  const id = isCreator ? 1 : 2;
  const player = {
    id,
    ws: websocket,
    x: id === 1 ? 35 : WIDTH - 35,
    y: HEIGHT / 2,
    inputX: 0,
    inputY: 0,
  };
  players.push(player);
  send(player, { type: "welcome", player: id });
  console.log(`Jugador ${id} conectado desde ${request.socket.remoteAddress}.`);
  broadcastWaiting();

  websocket.on("message", (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      send(player, { type: "error", message: "El mensaje no contiene JSON válido." });
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      send(player, { type: "error", message: "El mensaje debe ser un objeto JSON." });
      return;
    }

    if (message.type === "input") {
      if (!parseAxis(message.x) || !parseAxis(message.y)) {
        send(player, { type: "error", message: "Movimiento fuera del rango permitido." });
        return;
      }
      if (!game.started) {
        return;
      }
      const changed = message.x !== player.inputX || message.y !== player.inputY;
      player.inputX = message.x;
      player.inputY = message.y;
      if (changed) {
        console.log(
          `Jugador ${id}: input x=${message.x.toFixed(2)}, y=${message.y.toFixed(2)}.`,
        );
      }
      return;
    }

    if (message.type === "start") {
      if (player.id !== 1) {
        send(player, { type: "error", message: "Solo el creador puede iniciar la partida." });
      } else if (game.started) {
        send(player, { type: "error", message: "La partida ya está en curso." });
      } else if (!startOrRestartGame()) {
        send(player, { type: "waiting", connectedPlayers: players.length, message: "Espera a que se una el otro jugador." });
      }
    }
  });

  websocket.on("close", () => finishForDisconnectedPlayer(player));
  websocket.on("error", (error) => {
    console.error(`Error WebSocket del jugador ${id}:`, error.message);
  });
});

setInterval(updateGame, 1000 / TICK_RATE);

httpServer.listen(PORT, HOST, () => {
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  const displayHost = HOST === "0.0.0.0"
    ? "127.0.0.1"
    : HOST === "::" ? "::1" : HOST;
  const urlHost = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  const gameUrl = `http://${urlHost}:${port}/`;
  console.log(`Servidor Pong listo en ${gameUrl}`);
  console.log("El juego se abrirá en dos pestañas del navegador.");
  if (process.argv.includes("--open") && process.env.PONG_NO_OPEN !== "1") {
    const openBrowser = () => {
      let command;
      let args;
      if (process.platform === "win32") {
        command = "cmd.exe";
        args = ["/c", "start", "", gameUrl];
      } else if (process.platform === "darwin") {
        command = "open";
        args = [gameUrl];
      } else {
        command = "xdg-open";
        args = [gameUrl];
      }
      const browser = spawn(command, args, { detached: true, stdio: "ignore" });
      browser.on("error", (error) => {
        console.error("No se pudo abrir una pestaña del navegador:", error.message);
      });
      browser.unref();
    };
    openBrowser();
    setTimeout(openBrowser, 500);
  }
});

function shutdown() {
  for (const player of players) {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.close(1001, "Servidor detenido");
    }
  }
  websocketServer.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
