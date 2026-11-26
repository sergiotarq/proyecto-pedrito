"use strict";

const http = require("node:http");
const { readFile } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const { getTimeoutResult } = require("./game-rules");

const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const PORT = Number(process.env.PORT || 8080);
const WIDTH = 1000;
const HEIGHT = 600;
const TICK_RATE = 60;
const DURATION_OPTIONS = [1, 2, 3, 5, 10];
const TEST_DURATION_MS = process.env.MATCH_DURATION_MS
  ? Number(process.env.MATCH_DURATION_MS)
  : null;
const PADDLE_WIDTH = 14;
const PADDLE_HEIGHT = 100;
const BALL_RADIUS = 10;
const PADDLE_VERTICAL_SPEED = 420;
const PADDLE_HORIZONTAL_SPEED = 300;
const BALL_START_SPEED_X = 360;
const BALL_START_SPEED_Y = 210;
const WEB_ROOT = __dirname;
const GAME_URL = "http://localhost/";
const PUBLIC_URL = parsePublicUrl(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL);
const rooms = new Map();
const WEB_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error("PORT debe ser un entero entre 0 y 65535.");
}
if (TEST_DURATION_MS !== null && (!Number.isFinite(TEST_DURATION_MS) || TEST_DURATION_MS <= 0)) {
  throw new Error("MATCH_DURATION_MS debe ser un número positivo.");
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

function makeJoinUrl(room) {
  const url = new URL("/", PUBLIC_URL);
  url.searchParams.set("room", room.id);
  return url.toString();
}

function createGame(durationMs) {
  return {
    started: false,
    scores: [0, 0],
    durationMs,
    matchEndsAt: null,
    overtime: false,
    ball: { x: WIDTH / 2, y: HEIGHT / 2, vx: BALL_START_SPEED_X, vy: BALL_START_SPEED_Y },
    lastTick: Date.now(),
  };
}

function createRoom(name, durationMinutes) {
  const durationMs = TEST_DURATION_MS || durationMinutes * 60 * 1000;
  const room = {
    id: randomBytes(9).toString("hex"),
    name,
    durationMinutes,
    createdAt: Date.now(),
    players: [],
    game: createGame(durationMs),
    disposing: false,
  };
  rooms.set(room.id, room);
  return room;
}

function send(player, message) {
  if (player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message) {
  for (const player of room.players) {
    send(player, message);
  }
}

function resetBall(room, direction = Math.random() < 0.5 ? -1 : 1) {
  room.game.ball = {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    vx: BALL_START_SPEED_X * direction,
    vy: BALL_START_SPEED_Y * (Math.random() < 0.5 ? -1 : 1),
  };
}

function makeState(room) {
  const { game } = room;
  return {
    type: "state",
    width: WIDTH,
    height: HEIGHT,
    paddles: room.players.map(({ x, y }) => ({ x, y })),
    ball: { x: game.ball.x, y: game.ball.y },
    score: [...game.scores],
    remainingMs: game.started && !game.overtime
      ? Math.max(0, game.matchEndsAt - Date.now())
      : 0,
    overtime: game.overtime,
  };
}

function broadcastWaiting(room) {
  const connectedPlayers = room.players.length;
  const message = connectedPlayers === 2
    ? "Los dos jugadores están conectados. El anfitrión puede iniciar."
    : "Esperando a que se una un jugador.";
  broadcast(room, {
    type: "waiting",
    roomId: room.id,
    roomName: room.name,
    durationMinutes: room.durationMinutes,
    connectedPlayers,
    message,
  });
}

function startGame(room) {
  if (room.players.length !== 2 || room.game.started) {
    return false;
  }
  const { game } = room;
  game.started = true;
  game.scores = [0, 0];
  game.overtime = false;
  game.matchEndsAt = Date.now() + game.durationMs;
  resetBall(room);
  game.lastTick = Date.now();
  broadcast(room, { type: "start", durationMs: game.durationMs });
  broadcast(room, makeState(room));
  console.log(`Partida iniciada: ${room.name} (${room.id}).`);
  return true;
}

function finishGame(room, winner, reason) {
  room.game.started = false;
  for (const player of room.players) {
    player.inputX = 0;
    player.inputY = 0;
  }
  broadcast(room, {
    type: "game_over",
    winner,
    reason,
    score: [...room.game.scores],
  });
}

function handleTimeout(room) {
  const result = getTimeoutResult(room.game.scores);
  if (result.type === "overtime") {
    room.game.overtime = true;
    broadcast(room, { type: "overtime", message: "Empate: muerte súbita. El siguiente punto gana." });
    return;
  }
  finishGame(room, result.winner, "time");
}

function removePlayer(room, leavingPlayer) {
  if (room.disposing || !room.players.includes(leavingPlayer)) {
    return;
  }

  if (room.game.started) {
    room.disposing = true;
    room.game.started = false;
    room.game.matchEndsAt = null;
    const remainingPlayers = room.players.filter((player) => player !== leavingPlayer);
    room.players.length = 0;
    rooms.delete(room.id);
    for (const player of remainingPlayers) {
      send(player, {
        type: "opponent_left",
        message: "El otro jugador se desconectó. La sala se cerró.",
      });
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.close(4001, "El otro jugador se desconectó");
      }
    }
    room.disposing = false;
    console.log(`Partida ${room.id} cerrada porque un jugador se desconectó.`);
    return;
  }

  room.players.splice(room.players.indexOf(leavingPlayer), 1);
  if (leavingPlayer.id === 1 || room.players.length === 0) {
    rooms.delete(room.id);
    for (const player of room.players) {
      send(player, {
        type: "opponent_left",
        message: "El anfitrión cerró la sala.",
      });
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.close(4001, "El anfitrión cerró la sala");
      }
    }
    room.players.length = 0;
    console.log(`Sala ${room.id} eliminada.`);
    return;
  }

  broadcastWaiting(room);
}

function updateGame(room) {
  const { game } = room;
  if (!game.started || room.players.length !== 2) {
    return;
  }

  const now = Date.now();
  if (!game.overtime && now >= game.matchEndsAt) {
    handleTimeout(room);
    if (!game.started) {
      broadcast(room, makeState(room));
      return;
    }
  }
  const dt = Math.min((now - game.lastTick) / 1000, 0.05);
  game.lastTick = now;

  for (const player of room.players) {
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

  const [leftPaddle, rightPaddle] = room.players;
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
      finishGame(room, pointFor, "sudden_death");
    } else {
      resetBall(room, pointFor === 1 ? -1 : 1);
    }
  }
  broadcast(room, makeState(room));
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

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function publicRooms() {
  return [...rooms.values()]
    .filter((room) => room.players.length === 1 && !room.game.started)
    .map((room) => ({
      id: room.id,
      name: room.name,
      durationMinutes: room.durationMinutes,
      createdAt: room.createdAt,
      players: room.players.length,
    }))
    .sort((left, right) => left.createdAt - right.createdAt);
}

const httpServer = http.createServer((request, response) => {
  const pathname = new URL(request.url, GAME_URL).pathname;
  if (request.method === "GET" && pathname === "/config") {
    sendJson(response, 200, {
      durationOptions: DURATION_OPTIONS,
      publicUrl: PUBLIC_URL,
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/rooms") {
    sendJson(response, 200, { rooms: publicRooms() });
    return;
  }
  if (request.method === "GET" && pathname === "/qr.png") {
    const room = rooms.get(new URL(request.url, GAME_URL).searchParams.get("room"));
    if (!PUBLIC_URL || !room || room.players.length !== 1 || room.game.started) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("No hay QR disponible para esta sala.");
      return;
    }
    QRCode.toBuffer(makeJoinUrl(room), {
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

function rejectConnection(websocket, message) {
  websocket.send(JSON.stringify({ type: "error", message }));
  websocket.close(1008, message.slice(0, 120));
}

websocketServer.on("connection", (websocket, request) => {
  const connectionUrl = new URL(request.url, GAME_URL);
  const createRequested = connectionUrl.searchParams.get("action") === "create";
  const roomId = connectionUrl.searchParams.get("room");
  let room;
  let playerId;

  if (createRequested) {
    if (rooms.size >= 100) {
      rejectConnection(websocket, "Hay demasiadas salas activas. Inténtalo más tarde.");
      return;
    }
    const name = (connectionUrl.searchParams.get("name") || "").trim();
    const durationMinutes = Number(connectionUrl.searchParams.get("duration"));
    if (!name || name.length > 30) {
      rejectConnection(websocket, "Escribe un nombre de anfitrión de 1 a 30 caracteres.");
      return;
    }
    if (!DURATION_OPTIONS.includes(durationMinutes)) {
      rejectConnection(websocket, "Selecciona una duración válida para la partida.");
      return;
    }
    room = createRoom(name, durationMinutes);
    playerId = 1;
  } else if (roomId) {
    room = rooms.get(roomId);
    if (!room) {
      rejectConnection(websocket, "La partida ya no está disponible.");
      return;
    }
    if (room.players.length !== 1 || room.game.started) {
      rejectConnection(websocket, "La sala ya no está esperando jugadores.");
      return;
    }
    playerId = 2;
  } else {
    rejectConnection(websocket, "Elige crear una sala o busca una partida disponible.");
    return;
  }

  const player = {
    id: playerId,
    ws: websocket,
    x: playerId === 1 ? 35 : WIDTH - 35,
    y: HEIGHT / 2,
    inputX: 0,
    inputY: 0,
  };
  room.players.push(player);
  send(player, {
    type: "welcome",
    player: playerId,
    roomId: room.id,
    roomName: room.name,
    durationMinutes: room.durationMinutes,
    joinUrl: PUBLIC_URL ? makeJoinUrl(room) : null,
  });
  console.log(`Jugador ${playerId} conectado a ${room.name} (${room.id}) desde ${request.socket.remoteAddress}.`);
  broadcastWaiting(room);

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
      if (!room.game.started) {
        return;
      }
      player.inputX = message.x;
      player.inputY = message.y;
    } else if (message.type === "start") {
      if (player.id !== 1) {
        send(player, { type: "error", message: "Solo el anfitrión puede iniciar la partida." });
      } else if (room.game.started) {
        send(player, { type: "error", message: "La partida ya está en curso." });
      } else if (!startGame(room)) {
        send(player, {
          type: "waiting",
          roomId: room.id,
          roomName: room.name,
          durationMinutes: room.durationMinutes,
          connectedPlayers: room.players.length,
          message: "Espera a que se una el otro jugador.",
        });
      }
    }
  });

  websocket.on("close", () => removePlayer(room, player));
  websocket.on("error", (error) => {
    console.error(`Error WebSocket del jugador ${playerId} en ${room.id}:`, error.message);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    updateGame(room);
  }
}, 1000 / TICK_RATE);

httpServer.listen(PORT, HOST, () => {
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  const displayHost = HOST === "0.0.0.0"
    ? "127.0.0.1"
    : HOST === "::" ? "::1" : HOST;
  const urlHost = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  const gameUrl = `http://${urlHost}:${port}/`;
  console.log(`Servidor Pong listo en ${gameUrl}`);
  if (process.argv.includes("--open") && process.env.PONG_NO_OPEN !== "1" && !process.env.RENDER) {
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
  }
});

function shutdown() {
  for (const room of rooms.values()) {
    for (const player of room.players) {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.close(1001, "Servidor detenido");
      }
    }
  }
  websocketServer.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
