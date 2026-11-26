"use strict";

const canvas = document.getElementById("game");
const context = canvas.getContext("2d");
const statusLine = document.getElementById("status");
const homeView = document.getElementById("home-view");
const createView = document.getElementById("create-view");
const roomsView = document.getElementById("rooms-view");
const lobby = document.getElementById("lobby");
const matchView = document.getElementById("match-view");
const menuResult = document.getElementById("menu-result");
const createForm = document.getElementById("create-room-form");
const hostNameInput = document.getElementById("host-name");
const durationSelect = document.getElementById("create-duration");
const localDurationSelect = document.getElementById("local-duration");
const lobbyTitle = document.getElementById("lobby-title");
const lobbyMessage = document.getElementById("lobby-message");
const lobbyDetails = document.getElementById("lobby-details");
const inviteLink = document.getElementById("join-link");
const copyButton = document.getElementById("copy-link");
const publicUrlHelp = document.getElementById("public-url-help");
const qrCard = document.getElementById("qr-card");
const qrImage = document.getElementById("qr-code");
const startButton = document.getElementById("start-match");
const timerLine = document.getElementById("timer");
const overtimeLabel = document.getElementById("overtime-label");
const mobileControls = document.getElementById("mobile-controls");
const roomsMessage = document.getElementById("rooms-message");
const roomList = document.getElementById("room-list");
const heldKeys = new Set();
const pointerKeys = new Map();
const game = {
  mode: null,
  player: null,
  started: false,
  ball: { x: 500, y: 300, vx: 360, vy: 210 },
  paddles: [{ x: 35, y: 300 }, { x: 965, y: 300 }],
  score: [0, 0],
  durationMs: 120000,
  endsAt: null,
  overtime: false,
  lastFrameAt: 0,
};
let websocket = null;
let configuration = null;
let connectedPlayers = 0;
let roomId = null;
let roomName = "";
let onlineDuration = 2;
let roomRefreshTimer = null;

function setStatus(text, state = "connected") {
  statusLine.textContent = text;
  statusLine.dataset.state = state;
}

function showView(view) {
  for (const candidate of [homeView, createView, roomsView, lobby, matchView]) {
    candidate.hidden = candidate !== view;
  }
}

function formatTime(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function setLobbyMessage(text) {
  lobbyMessage.textContent = text;
}

function updateStartButton() {
  startButton.disabled = game.player !== 1 || connectedPlayers !== 2;
  startButton.textContent = game.score.some((score) => score > 0)
    ? "Iniciar otra partida"
    : "Iniciar partida";
}

function populateDurations() {
  for (const select of [durationSelect, localDurationSelect]) {
    for (const minutes of configuration.durationOptions) {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
      select.append(option);
    }
    if (configuration.durationOptions.includes(2)) {
      select.value = "2";
    }
  }
}

async function loadConfiguration() {
  const response = await fetch("/config", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`El servidor respondió ${response.status} al cargar la configuración.`);
  }
  configuration = await response.json();
  populateDurations();

  const requestedRoom = new URLSearchParams(location.search).get("room");
  if (requestedRoom) {
    showView(lobby);
    lobbyTitle.textContent = "Uniéndote a la partida";
    setLobbyMessage("Conectando con el anfitrión...");
    connectToRoom(requestedRoom);
  }
}

function clearRoomRefresh() {
  if (roomRefreshTimer) {
    clearInterval(roomRefreshTimer);
    roomRefreshTimer = null;
  }
}

function makeSocketUrl(parameters) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws?${parameters}`;
}

function connectToRoom(id) {
  closeSocket();
  game.mode = "online";
  roomId = id;
  const socket = new WebSocket(makeSocketUrl(`room=${encodeURIComponent(id)}`));
  websocket = socket;
  connectToSocket(socket);
}

function createOnlineRoom(name, durationMinutes) {
  closeSocket();
  game.mode = "online";
  onlineDuration = durationMinutes;
  const query = new URLSearchParams({
    action: "create",
    name,
    duration: String(durationMinutes),
  });
  const socket = new WebSocket(makeSocketUrl(query));
  websocket = socket;
  showView(lobby);
  lobbyTitle.textContent = name;
  setLobbyMessage("Creando la sala...");
  connectToSocket(socket);
}

function connectToSocket(socket) {
  setStatus("Conectando con el servidor...", "connecting");
  socket.addEventListener("open", () => {
    setStatus("Conectado", "connected");
  });
  socket.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.error("No se pudo interpretar el estado del servidor:", error);
      setLobbyMessage("Se recibió un mensaje inválido del servidor.");
      setStatus("Mensaje inválido recibido del servidor.", "disconnected");
    }
  });
  socket.addEventListener("error", (event) => {
    console.error("Error en el WebSocket:", event);
    setLobbyMessage("No se pudo conectar. Comprueba tu conexión e inténtalo otra vez.");
    setStatus("No se pudo conectar al servidor.", "disconnected");
  });
  socket.addEventListener("close", (event) => {
    if (websocket !== socket) {
      return;
    }
    game.started = false;
    game.player = null;
    connectedPlayers = 0;
    heldKeys.clear();
    pointerKeys.clear();
    startButton.disabled = true;
    const message = event.code === 4001
      ? "El anfitrión o el otro jugador se desconectó. La sala se cerró."
      : "Se perdió la conexión con la sala.";
    setLobbyMessage(message);
    setStatus(message, "disconnected");
    if (!matchView.hidden) {
      showView(lobby);
    }
  });
}

function closeSocket() {
  const socket = websocket;
  websocket = null;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    socket.close(1000, "Salió de la sala");
  }
}

function handleMessage(message) {
  if (message.type === "welcome") {
    game.mode = "online";
    game.player = message.player;
    roomId = message.roomId;
    roomName = message.roomName;
    onlineDuration = message.durationMinutes;
    lobbyTitle.textContent = roomName;
    lobbyDetails.textContent = `Anfitrión: ${roomName} · ${onlineDuration} ${onlineDuration === 1 ? "minuto" : "minutos"} · muerte súbita si empatan`;
    inviteLink.value = message.joinUrl || `${location.origin}/?room=${encodeURIComponent(roomId)}`;
    copyButton.disabled = false;
    qrCard.hidden = !message.joinUrl || game.player !== 1;
    publicUrlHelp.hidden = Boolean(message.joinUrl);
    if (!message.joinUrl) {
      publicUrlHelp.textContent = "El QR estará disponible después de publicar el sitio con una URL pública HTTPS.";
    } else if (game.player === 1) {
      qrImage.src = `/qr.png?room=${encodeURIComponent(roomId)}`;
    }
    mobileControls.hidden = game.player === null;
    setStatus(game.player === 1 ? "Eres el anfitrión" : "Te uniste a la sala", "connected");
    if (game.player === 2) {
      setLobbyMessage(`Te conectaste a la sala de ${roomName}. Espera a que el anfitrión inicie.`);
    }
  } else if (message.type === "waiting") {
    game.started = false;
    connectedPlayers = message.connectedPlayers;
    if (message.roomName) {
      roomName = message.roomName;
      lobbyTitle.textContent = roomName;
    }
    setLobbyMessage(message.message);
    updateStartButton();
    setStatus(
      connectedPlayers === 2 ? "Los dos jugadores están conectados" : "Esperando rival",
      "connected",
    );
  } else if (message.type === "start") {
    game.started = true;
    game.mode = "online";
    game.score = [0, 0];
    game.overtime = false;
    heldKeys.clear();
    pointerKeys.clear();
    timerLine.textContent = formatTime(message.durationMs);
    overtimeLabel.hidden = true;
    showView(matchView);
    setStatus(`Partida iniciada · jugador ${game.player}`, "connected");
    canvas.focus({ preventScroll: true });
  } else if (message.type === "state") {
    game.ball = message.ball;
    game.paddles = message.paddles;
    game.score = message.score;
    game.overtime = message.overtime;
    if (!message.overtime) {
      timerLine.textContent = formatTime(message.remainingMs);
    }
    overtimeLabel.hidden = !message.overtime;
  } else if (message.type === "overtime") {
    timerLine.textContent = "00:00";
    overtimeLabel.hidden = false;
    setStatus(message.message, "connected");
  } else if (message.type === "game_over") {
    game.started = false;
    connectedPlayers = 2;
    const reason = message.reason === "sudden_death" ? "por muerte súbita" : "por tiempo";
    const result = `Ganó el jugador ${message.winner} ${reason} · marcador ${message.score[0]}–${message.score[1]}.`;
    setLobbyMessage(`${result} El anfitrión puede iniciar otra partida.`);
    setStatus(result, "connected");
    showView(lobby);
    updateStartButton();
  } else if (message.type === "opponent_left" || message.type === "error") {
    game.started = false;
    setLobbyMessage(message.message);
    setStatus(message.message, "disconnected");
    showView(lobby);
    updateStartButton();
  }
}

function playerInput(player) {
  const up = player === 1 ? "w" : "arrowup";
  const left = player === 1 ? "a" : "arrowleft";
  const down = player === 1 ? "s" : "arrowdown";
  const right = player === 1 ? "d" : "arrowright";
  let x = Number(heldKeys.has(right)) - Number(heldKeys.has(left));
  let y = Number(heldKeys.has(down)) - Number(heldKeys.has(up));
  if (x !== 0 && y !== 0) {
    x *= Math.SQRT1_2;
    y *= Math.SQRT1_2;
  }
  return { x, y };
}

function sendInput() {
  if (!game.started) {
    return;
  }
  if (game.mode === "online" && websocket?.readyState === WebSocket.OPEN) {
    const input = playerInput(game.player);
    websocket.send(JSON.stringify({ type: "input", ...input }));
  }
}

function finishLocalGame(winner, reason) {
  game.started = false;
  heldKeys.clear();
  pointerKeys.clear();
  const description = reason === "sudden_death" ? "por muerte súbita" : "por tiempo";
  const result = `Ganó el jugador ${winner} ${description} · marcador ${game.score[0]}–${game.score[1]}.`;
  menuResult.textContent = result;
  menuResult.hidden = false;
  showView(homeView);
  setStatus(result, "connected");
}

function updateLocalGame(now) {
  if (!game.started || game.mode !== "local") {
    return;
  }
  const wallNow = Date.now();
  if (!game.overtime && wallNow >= game.endsAt) {
    const result = game.score[0] === game.score[1]
      ? { type: "overtime" }
      : { type: "winner", winner: game.score[0] > game.score[1] ? 1 : 2 };
    if (result.type === "winner") {
      finishLocalGame(result.winner, "time");
      return;
    }
    game.overtime = true;
    timerLine.textContent = "00:00";
    overtimeLabel.hidden = false;
    setStatus("Empate: muerte súbita. El siguiente punto gana.", "connected");
  }

  const dt = Math.min((now - game.lastFrameAt) / 1000, 0.05);
  game.lastFrameAt = now;
  for (const [index, paddle] of game.paddles.entries()) {
    const input = playerInput(index + 1);
    const magnitude = Math.hypot(input.x, input.y);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    const minX = index === 0 ? 35 : 560;
    const maxX = index === 0 ? 440 : 965;
    paddle.x = Math.max(minX, Math.min(maxX, paddle.x + input.x * scale * 300 * dt));
    paddle.y = Math.max(50, Math.min(550, paddle.y + input.y * scale * 420 * dt));
  }

  const ball = game.ball;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  if (ball.y - 10 <= 0 || ball.y + 10 >= 600) {
    ball.vy *= -1;
    ball.y = Math.max(10, Math.min(590, ball.y));
  }
  const [left, right] = game.paddles;
  const leftEdge = left.x + 7;
  const rightEdge = right.x - 7;
  if (
    ball.vx < 0 && ball.x - 10 <= leftEdge && ball.x >= left.x - 7
    && Math.abs(ball.y - left.y) <= 60
  ) {
    ball.vx = Math.abs(ball.vx) * 1.04;
    ball.x = leftEdge + 10;
    ball.vy += (ball.y - left.y) * 2.2;
  } else if (
    ball.vx > 0 && ball.x + 10 >= rightEdge && ball.x <= right.x + 7
    && Math.abs(ball.y - right.y) <= 60
  ) {
    ball.vx = -Math.abs(ball.vx) * 1.04;
    ball.x = rightEdge - 10;
    ball.vy += (ball.y - right.y) * 2.2;
  }

  let pointFor = 0;
  if (ball.x < 0) {
    pointFor = 2;
  } else if (ball.x > 1000) {
    pointFor = 1;
  }
  if (pointFor) {
    game.score[pointFor - 1] += 1;
    if (game.overtime) {
      finishLocalGame(pointFor, "sudden_death");
      return;
    }
    game.ball = {
      x: 500,
      y: 300,
      vx: 360 * (pointFor === 1 ? -1 : 1),
      vy: Math.random() < 0.5 ? -210 : 210,
    };
  }
  if (!game.overtime) {
    timerLine.textContent = formatTime(game.endsAt - wallNow);
  }
}

function startLocalGame() {
  game.mode = "local";
  game.player = null;
  game.durationMs = Number(localDurationSelect.value) * 60 * 1000;
  game.endsAt = Date.now() + game.durationMs;
  game.started = true;
  game.overtime = false;
  game.score = [0, 0];
  game.ball = { x: 500, y: 300, vx: 360, vy: 210 };
  game.paddles = [{ x: 35, y: 300 }, { x: 965, y: 300 }];
  game.lastFrameAt = performance.now();
  timerLine.textContent = formatTime(game.durationMs);
  overtimeLabel.hidden = true;
  mobileControls.hidden = true;
  menuResult.hidden = true;
  showView(matchView);
  setStatus("Modo local · jugador 1 usa W A S D, jugador 2 usa las flechas", "connected");
  canvas.focus({ preventScroll: true });
}

function handleKeyDown(event) {
  const key = event.key.toLowerCase();
  const valid = ["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"];
  if (!game.started || !valid.includes(key)) {
    return;
  }
  if (game.mode === "online") {
    const playerKeys = game.player === 1 ? ["w", "a", "s", "d"] : ["arrowup", "arrowleft", "arrowdown", "arrowright"];
    if (!playerKeys.includes(key)) {
      return;
    }
  }
  event.preventDefault();
  heldKeys.add(key);
  sendInput();
}

function releasePointer(pointerId) {
  const key = pointerKeys.get(pointerId);
  if (key) {
    pointerKeys.delete(pointerId);
    heldKeys.delete(key);
    sendInput();
  }
}

async function refreshRooms() {
  roomsMessage.textContent = "Buscando salas abiertas...";
  try {
    const response = await fetch("/api/rooms", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`El servidor respondió ${response.status}.`);
    }
    const { rooms } = await response.json();
    roomList.replaceChildren();
    if (rooms.length === 0) {
      roomsMessage.textContent = "No hay salas esperando por ahora. Puedes actualizar o crear una partida.";
      return;
    }
    roomsMessage.textContent = `${rooms.length} ${rooms.length === 1 ? "sala disponible" : "salas disponibles"}.`;
    for (const room of rooms) {
      const entry = document.createElement("article");
      entry.className = "room-entry";
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = room.name;
      const info = document.createElement("span");
      info.textContent = `Esperando rival · ${room.durationMinutes} ${room.durationMinutes === 1 ? "minuto" : "minutos"}`;
      const joinButton = document.createElement("button");
      joinButton.className = "primary";
      joinButton.type = "button";
      joinButton.textContent = "Unirse";
      joinButton.addEventListener("click", () => {
        clearRoomRefresh();
        connectToRoom(room.id);
        showView(lobby);
        lobbyTitle.textContent = room.name;
        setLobbyMessage("Conectando con el anfitrión...");
      });
      details.append(title, info);
      entry.append(details, joinButton);
      roomList.append(entry);
    }
  } catch (error) {
    console.error("No se pudo buscar partidas:", error);
    roomsMessage.textContent = `No se pudieron cargar las salas: ${error.message}`;
  }
}

function showRooms() {
  closeSocket();
  clearRoomRefresh();
  showView(roomsView);
  refreshRooms();
  roomRefreshTimer = setInterval(refreshRooms, 5000);
}

function backHome() {
  closeSocket();
  clearRoomRefresh();
  game.mode = null;
  game.started = false;
  game.player = null;
  connectedPlayers = 0;
  roomId = null;
  heldKeys.clear();
  pointerKeys.clear();
  showView(homeView);
  setStatus("Elige cómo jugar", "connected");
}

function leaveCurrentMatch() {
  if (game.mode === "online" && !window.confirm("¿Salir de la partida? La sala online se cerrará para ambos jugadores.")) {
    return;
  }
  backHome();
}

document.getElementById("local-mode").addEventListener("click", () => {
  menuResult.hidden = true;
  startLocalGame();
});
document.getElementById("create-mode").addEventListener("click", () => {
  showView(createView);
});
document.getElementById("browse-mode").addEventListener("click", showRooms);
document.querySelectorAll("[data-back-home]").forEach((button) => {
  button.addEventListener("click", backHome);
});
document.getElementById("refresh-rooms").addEventListener("click", refreshRooms);
createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = hostNameInput.value.trim();
  const duration = Number(durationSelect.value);
  if (!name || name.length > 30 || !configuration.durationOptions.includes(duration)) {
    setStatus("Revisa el nombre y la duración de la partida.", "disconnected");
    return;
  }
  menuResult.hidden = true;
  createOnlineRoom(name, duration);
});
document.getElementById("lobby-back").addEventListener("click", leaveCurrentMatch);
document.getElementById("match-back").addEventListener("click", leaveCurrentMatch);
startButton.addEventListener("click", () => {
  if (game.player === 1 && connectedPlayers === 2 && websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: "start" }));
  }
});
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copyButton.textContent = "Enlace copiado";
  } catch (error) {
    console.error("No se pudo copiar el enlace:", error);
    setLobbyMessage("No se pudo copiar automáticamente. Selecciona y copia el enlace.");
    inviteLink.select();
  }
});
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", (event) => {
  if (heldKeys.delete(event.key.toLowerCase())) {
    sendInput();
  }
});
window.addEventListener("blur", () => {
  if (heldKeys.size > 0) {
    heldKeys.clear();
    pointerKeys.clear();
    sendInput();
  }
});
mobileControls.addEventListener("pointerdown", (event) => {
  const button = event.target.closest("[data-direction]");
  if (!button || game.player === null || game.mode !== "online") {
    return;
  }
  event.preventDefault();
  const keys = game.player === 1
    ? { up: "w", left: "a", down: "s", right: "d" }
    : { up: "arrowup", left: "arrowleft", down: "arrowdown", right: "arrowright" };
  const key = keys[button.dataset.direction];
  if (key) {
    pointerKeys.set(event.pointerId, key);
    heldKeys.add(key);
    button.setPointerCapture(event.pointerId);
    sendInput();
  }
});
for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
  mobileControls.addEventListener(eventName, (event) => releasePointer(event.pointerId));
}
canvas.addEventListener("pointerdown", () => canvas.focus({ preventScroll: true }));
window.addEventListener("beforeunload", closeSocket);

function draw(now) {
  updateLocalGame(now);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#29414d";
  context.lineWidth = 2;
  context.setLineDash([9, 12]);
  context.beginPath();
  context.moveTo(canvas.width / 2, 0);
  context.lineTo(canvas.width / 2, canvas.height);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#f3fbfd";
  context.font = "800 54px Segoe UI, sans-serif";
  context.textAlign = "center";
  context.fillText(game.score[0], canvas.width / 2 - 90, 78);
  context.fillText(game.score[1], canvas.width / 2 + 90, 78);
  context.fillStyle = "#21dfc0";
  for (const paddle of game.paddles) {
    context.beginPath();
    context.roundRect(paddle.x - 7, paddle.y - 50, 14, 100, 7);
    context.fill();
  }
  context.fillStyle = "#f5fbff";
  context.shadowColor = "#8aefff";
  context.shadowBlur = 20;
  context.beginPath();
  context.arc(game.ball.x, game.ball.y, 10, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
  requestAnimationFrame(draw);
}

draw(0);
loadConfiguration().catch((error) => {
  console.error("No se pudo cargar la configuración:", error);
  setStatus(error.message, "disconnected");
});
setInterval(sendInput, 30);
