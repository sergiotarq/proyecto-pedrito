"use strict";

const canvas = document.getElementById("game");
const context = canvas.getContext("2d");
const statusLine = document.getElementById("status");
const lobby = document.getElementById("lobby");
const lobbyTitle = document.getElementById("lobby-title");
const lobbyMessage = document.getElementById("lobby-message");
const matchView = document.getElementById("match-view");
const inviteLink = document.getElementById("join-link");
const copyButton = document.getElementById("copy-link");
const publicUrlHelp = document.getElementById("public-url-help");
const qrCard = document.getElementById("qr-card");
const qrImage = document.getElementById("qr-code");
const connectButton = document.getElementById("connect");
const startButton = document.getElementById("start-match");
const timerLine = document.getElementById("timer");
const overtimeLabel = document.getElementById("overtime-label");
const mobileControls = document.getElementById("mobile-controls");
const heldKeys = new Set();
const pointerKeys = new Map();
const game = {
  player: null,
  started: false,
  ball: { x: 500, y: 300 },
  paddles: [{ x: 35, y: 300 }, { x: 965, y: 300 }],
  score: [0, 0],
};
let websocket = null;
let configuration = null;
let connectedPlayers = 0;
let invitationToken = null;

function setStatus(text, state) {
  statusLine.textContent = text;
  statusLine.dataset.state = state;
}

function formatTime(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateStartButton() {
  startButton.disabled = game.player !== 1 || connectedPlayers !== 2;
  startButton.textContent = game.score.some((score) => score > 0)
    ? "Iniciar otra partida"
    : "Iniciar partida";
}

function setLobbyMessage(text) {
  lobbyMessage.textContent = text;
}

async function loadConfiguration() {
  const response = await fetch("/config", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`El servidor respondió ${response.status} al cargar la sala.`);
  }
  configuration = await response.json();

  const localJoinUrl = new URL("/", location.origin);
  localJoinUrl.searchParams.set("join", configuration.roomToken);
  inviteLink.value = configuration.joinUrl || localJoinUrl.toString();
  copyButton.disabled = false;
  qrCard.hidden = !configuration.joinUrl;
  publicUrlHelp.hidden = Boolean(configuration.joinUrl);
  if (configuration.joinUrl) {
    qrImage.src = "/qr.png";
  }

  const params = new URLSearchParams(location.search);
  invitationToken = params.get("join");
  if (invitationToken && invitationToken !== configuration.roomToken) {
    setLobbyMessage("Este enlace de invitación no es válido o la sala ya cambió. Pide al creador un enlace nuevo.");
    connectButton.disabled = true;
    return;
  }
  if (invitationToken) {
    lobbyTitle.textContent = "Únete a la partida";
  }
  connect();
}

function connect() {
  if (
    websocket
    && (websocket.readyState === WebSocket.CONNECTING
      || websocket.readyState === WebSocket.OPEN)
  ) {
    return;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const role = invitationToken
    ? `join=${encodeURIComponent(invitationToken)}`
    : "role=creator";
  websocket = new WebSocket(`${protocol}//${location.host}/ws?${role}`);
  connectButton.disabled = true;
  setStatus("Conectando al servidor...", "connecting");
  setLobbyMessage(invitationToken
    ? "Conectando con la sala del creador..."
    : "Creando tu sala...");

  websocket.addEventListener("open", () => {
    setStatus("Conectado · preparando la sala", "connected");
  });

  websocket.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.error("No se pudo interpretar el estado del servidor:", error);
      setLobbyMessage("Se recibió un mensaje inválido del servidor.");
      setStatus("Mensaje inválido recibido del servidor.", "disconnected");
    }
  });

  websocket.addEventListener("error", (event) => {
    console.error("Error en el WebSocket:", event);
    setLobbyMessage("No se pudo conectar. Comprueba el servidor y vuelve a intentarlo.");
    setStatus("No se pudo conectar. Comprueba el servidor.", "disconnected");
  });

  websocket.addEventListener("close", (event) => {
    game.started = false;
    game.player = null;
    connectedPlayers = 0;
    heldKeys.clear();
    pointerKeys.clear();
    matchView.hidden = true;
    lobby.hidden = false;
    connectButton.hidden = false;
    connectButton.disabled = false;
    updateStartButton();
    const message = event.code === 4001
      ? "Tu oponente se desconectó. La sala quedó libre; vuelve a conectarte para crear otra."
      : "Desconectado · pulsa Conectar para volver a entrar";
    setLobbyMessage(message);
    setStatus(message, "disconnected");
  });
}

function handleMessage(message) {
  if (message.type === "welcome") {
    game.player = message.player;
    connectButton.hidden = true;
    lobbyTitle.textContent = game.player === 1 ? "Tu sala de partida" : "Únete a la partida";
    setStatus(`Conectado · eres el jugador ${game.player}`, "connected");
    mobileControls.setAttribute("aria-label", `Controles táctiles del jugador ${game.player}`);
  } else if (message.type === "waiting") {
    game.started = false;
    connectedPlayers = message.connectedPlayers;
    setLobbyMessage(message.message);
    updateStartButton();
    setStatus(
      connectedPlayers === 2 ? "Los dos jugadores están conectados" : "Esperando al otro jugador",
      "connected",
    );
  } else if (message.type === "start") {
    game.started = true;
    game.score = [0, 0];
    heldKeys.clear();
    pointerKeys.clear();
    timerLine.textContent = formatTime(message.durationMs);
    overtimeLabel.hidden = true;
    lobby.hidden = true;
    matchView.hidden = false;
    setStatus(`Partida iniciada · jugador ${game.player}`, "connected");
    canvas.focus({ preventScroll: true });
  } else if (message.type === "state") {
    game.ball = message.ball;
    game.paddles = message.paddles;
    game.score = message.score;
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
    matchView.hidden = true;
    lobby.hidden = false;
    overtimeLabel.hidden = true;
    const reason = message.reason === "sudden_death" ? "por muerte súbita" : "por tiempo";
    const result = `Ganó el jugador ${message.winner} ${reason} · marcador ${message.score[0]}–${message.score[1]}.`;
    setLobbyMessage(`${result} El creador puede iniciar otra partida.`);
    setStatus(result, "connected");
    updateStartButton();
  } else if (message.type === "opponent_left" || message.type === "error") {
    game.started = false;
    connectedPlayers = 0;
    matchView.hidden = true;
    lobby.hidden = false;
    setLobbyMessage(message.message);
    setStatus(message.message, "disconnected");
    updateStartButton();
  }
}

function validKeys() {
  if (game.player === 1) {
    return new Set(["w", "a", "s", "d"]);
  }
  if (game.player === 2) {
    return new Set(["arrowup", "arrowleft", "arrowdown", "arrowright"]);
  }
  return new Set();
}

function currentInput() {
  let x = 0;
  let y = 0;
  if (game.player === 1) {
    x = Number(heldKeys.has("d")) - Number(heldKeys.has("a"));
    y = Number(heldKeys.has("s")) - Number(heldKeys.has("w"));
  } else if (game.player === 2) {
    x = Number(heldKeys.has("arrowright")) - Number(heldKeys.has("arrowleft"));
    y = Number(heldKeys.has("arrowdown")) - Number(heldKeys.has("arrowup"));
  }
  if (x !== 0 && y !== 0) {
    x *= Math.SQRT1_2;
    y *= Math.SQRT1_2;
  }
  return { type: "input", x, y };
}

function sendInput() {
  if (game.started && websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(currentInput()));
  }
}

function releasePointer(pointerId) {
  const key = pointerKeys.get(pointerId);
  if (key) {
    pointerKeys.delete(pointerId);
    heldKeys.delete(key);
    sendInput();
  }
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (!validKeys().has(key)) {
    return;
  }
  event.preventDefault();
  heldKeys.add(key);
  sendInput();
});

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
  if (!button || game.player === null) {
    return;
  }
  event.preventDefault();
  const direction = button.dataset.direction;
  const keyByPlayer = game.player === 1
    ? { up: "w", left: "a", down: "s", right: "d" }
    : { up: "arrowup", left: "arrowleft", down: "arrowdown", right: "arrowright" };
  const key = keyByPlayer[direction];
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

canvas.addEventListener("pointerdown", () => {
  canvas.focus({ preventScroll: true });
});
connectButton.addEventListener("click", connect);
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
window.addEventListener("beforeunload", () => {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.close(1000, "Página cerrada");
  }
});

function draw() {
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

async function initialize() {
  try {
    await loadConfiguration();
  } catch (error) {
    console.error("No se pudo cargar la configuración de la sala:", error);
    setLobbyMessage(error.message);
    setStatus("No se pudo preparar la sala.", "disconnected");
  }
}

draw();
initialize();
setInterval(sendInput, 30);
