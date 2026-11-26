"""Servidor autoritativo para Pong multijugador (TCP, dos jugadores)."""

import json
import socket
import threading
import time


HOST = "127.0.0.1"
PORT = 8080
TICK_RATE = 60
WINNING_SCORE = 5

WIDTH = 800
HEIGHT = 500
PADDLE_HEIGHT = 90
PADDLE_SPEED = 360.0
PADDLE_HORIZONTAL_SPEED = 240.0
PADDLE_HALF_WIDTH = 6
PADDLE_START_X = 30
PADDLE_ZONE_GAP = 60
BALL_RADIUS = 9
BALL_SPEED_X = 300.0
BALL_SPEED_Y = 180.0


class Player:
    """Conexión y estado de entrada de un jugador."""

    def __init__(self, sock, address, player_id):
        self.sock = sock
        self.address = address
        self.player_id = player_id
        self.paddle_x = PADDLE_START_X if player_id == 1 else WIDTH - PADDLE_START_X
        self.paddle_y = HEIGHT / 2
        self.direction_x = 0.0
        self.direction_y = 0.0
        self.connected = True
        self.send_lock = threading.Lock()


def send_message(player, message):
    """Envía un objeto JSON terminado en salto de línea."""
    data = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
    with player.send_lock:
        player.sock.sendall(data)


def receive_player(player, state_lock):
    """Lee comandos del jugador. La conexión es independiente para cada hilo."""
    buffer = b""
    try:
        while True:
            chunk = player.sock.recv(1024)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                raw_line, buffer = buffer.split(b"\n", 1)
                if not raw_line:
                    continue
                try:
                    message = json.loads(raw_line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    send_message(player, {"type": "error", "message": "Mensaje JSON inválido."})
                    continue

                if not isinstance(message, dict):
                    send_message(player, {"type": "error", "message": "El mensaje debe ser un objeto JSON."})
                    continue
                if message.get("type") == "quit":
                    return
                if message.get("type") == "input":
                    direction_x = message.get("x")
                    direction_y = message.get("y")
                    if not all(
                        isinstance(value, (int, float))
                        and not isinstance(value, bool)
                        and -1 <= value <= 1
                        for value in (direction_x, direction_y)
                    ):
                        continue
                    with state_lock:
                        changed = (
                            direction_x != player.direction_x
                            or direction_y != player.direction_y
                        )
                        player.direction_x = direction_x
                        player.direction_y = direction_y
                    if changed:
                        print(
                            "Jugador {} movimiento recibido: horizontal={:+.2f}, vertical={:+.2f}.".format(
                                player.player_id, direction_x, direction_y
                            ),
                            flush=True,
                        )
    except (ConnectionError, OSError):
        pass
    finally:
        with state_lock:
            player.connected = False
            player.direction_x = 0
            player.direction_y = 0


def reset_ball(ball, direction):
    ball.update({
        "x": WIDTH / 2,
        "y": HEIGHT / 2,
        "vx": BALL_SPEED_X * direction,
        "vy": BALL_SPEED_Y if direction > 0 else -BALL_SPEED_Y,
    })


def run_game(players, state_lock=None, start_receivers=True):
    if state_lock is None:
        state_lock = threading.Lock()
    if start_receivers:
        for player in players:
            threading.Thread(
                target=receive_player,
                args=(player, state_lock),
                daemon=True,
            ).start()

    ball = {}
    reset_ball(ball, 1)
    scores = [0, 0]
    winner = None
    previous_time = time.monotonic()
    tick_duration = 1.0 / TICK_RATE

    for player in players:
        send_message(player, {"type": "start", "player": player.player_id})
    print("Partida iniciada.")

    while winner is None:
        frame_start = time.monotonic()
        dt = min(frame_start - previous_time, 0.05)
        previous_time = frame_start

        with state_lock:
            disconnected = [not player.connected for player in players]
            for player in players:
                diagonal_scale = 0.7071 if player.direction_x and player.direction_y else 1.0
                player.paddle_x = min(
                    max(
                        player.paddle_x
                        + player.direction_x * PADDLE_HORIZONTAL_SPEED * dt * diagonal_scale,
                        PADDLE_START_X if player.player_id == 1 else WIDTH // 2 + PADDLE_ZONE_GAP,
                    ),
                    WIDTH // 2 - PADDLE_ZONE_GAP
                    if player.player_id == 1
                    else WIDTH - PADDLE_START_X,
                )
                player.paddle_y = min(
                    max(
                        player.paddle_y
                        + player.direction_y * PADDLE_SPEED * dt * diagonal_scale,
                        PADDLE_HEIGHT / 2),
                    HEIGHT - PADDLE_HEIGHT / 2,
                )
            paddle_positions = [
                {"x": player.paddle_x, "y": player.paddle_y}
                for player in players
            ]

        if any(disconnected):
            winner = 1 if disconnected[1] else 2
            break

        ball["x"] += ball["vx"] * dt
        ball["y"] += ball["vy"] * dt

        if ball["y"] - BALL_RADIUS <= 0 or ball["y"] + BALL_RADIUS >= HEIGHT:
            ball["vy"] *= -1
            ball["y"] = min(max(ball["y"], BALL_RADIUS), HEIGHT - BALL_RADIUS)

        # La paleta izquierda pertenece al jugador 1; la derecha, al jugador 2.
        if (
            ball["vx"] < 0
            and ball["x"] - BALL_RADIUS
            <= paddle_positions[0]["x"] + PADDLE_HALF_WIDTH
        ):
            if abs(ball["y"] - paddle_positions[0]["y"]) <= PADDLE_HEIGHT / 2 + BALL_RADIUS:
                ball["vx"] = abs(ball["vx"]) * 1.04
                ball["x"] = (
                    paddle_positions[0]["x"] + PADDLE_HALF_WIDTH + BALL_RADIUS
                )
                ball["vy"] += (ball["y"] - paddle_positions[0]["y"]) * 2.2
        elif (
            ball["vx"] > 0
            and ball["x"] + BALL_RADIUS
            >= paddle_positions[1]["x"] - PADDLE_HALF_WIDTH
        ):
            if abs(ball["y"] - paddle_positions[1]["y"]) <= PADDLE_HEIGHT / 2 + BALL_RADIUS:
                ball["vx"] = -abs(ball["vx"]) * 1.04
                ball["x"] = (
                    paddle_positions[1]["x"] - PADDLE_HALF_WIDTH - BALL_RADIUS
                )
                ball["vy"] += (ball["y"] - paddle_positions[1]["y"]) * 2.2

        point_for = None
        if ball["x"] < 0:
            scores[1] += 1
            point_for = 2
        elif ball["x"] > WIDTH:
            scores[0] += 1
            point_for = 1

        if point_for is not None:
            if scores[point_for - 1] >= WINNING_SCORE:
                winner = point_for
            else:
                reset_ball(ball, -1 if point_for == 1 else 1)

        state = {
            "type": "state",
            "width": WIDTH,
            "height": HEIGHT,
            "paddles": paddle_positions,
            "ball": {"x": ball["x"], "y": ball["y"]},
            "score": scores,
        }
        try:
            for player in players:
                send_message(player, state)
        except (ConnectionError, OSError) as exc:
            print("No se pudo enviar el estado:", exc)
            winner = next((p.player_id for p in players if p.connected), 0)
            break

        remaining = tick_duration - (time.monotonic() - frame_start)
        if remaining > 0:
            time.sleep(remaining)

    for player in players:
        try:
            send_message(player, {"type": "game_over", "winner": winner, "score": scores})
        except (ConnectionError, OSError):
            pass


def main():
    players = []
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    try:
        server_socket.bind((HOST, PORT))
        server_socket.listen(2)
        print("Servidor escuchando en {}:{}.".format(HOST, PORT))
        print("Esperando a los dos jugadores...")

        while len(players) < 2:
            connection, address = server_socket.accept()
            player_id = len(players) + 1
            player = Player(connection, address, player_id)
            players.append(player)
            print("Jugador {} conectado desde {}.".format(player_id, address))
            send_message(player, {"type": "welcome", "player": player_id})
            if len(players) == 1:
                send_message(player, {"type": "waiting"})

        run_game(players)
    except (OSError, KeyboardInterrupt) as exc:
        if isinstance(exc, KeyboardInterrupt):
            print("\nServidor detenido por el usuario.")
        else:
            print("Error del servidor: {}".format(exc))
    finally:
        for player in players:
            try:
                player.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            player.sock.close()
        server_socket.close()
        print("Sockets cerrados.")


if __name__ == "__main__":
    main()
