"""Cliente gráfico de Pong. Requiere solo la biblioteca estándar de Python."""

import json
import queue
import socket
import threading
import tkinter as tk
from tkinter import messagebox


SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8080
CANVAS_WIDTH = 800
CANVAS_HEIGHT = 500
PADDLE_HEIGHT = 90
PADDLE_WIDTH = 12
BALL_RADIUS = 9


class PongClient:
    def __init__(self, root):
        self.root = root
        self.root.title("Ping Pong multijugador")
        self.root.resizable(False, False)
        self.canvas = tk.Canvas(
            root, width=CANVAS_WIDTH, height=CANVAS_HEIGHT,
            bg="#101820", highlightthickness=0, takefocus=True,
        )
        self.canvas.pack()
        self.canvas.focus_set()
        self.canvas.bind("<Button-1>", lambda event: self.canvas.focus_set())
        self.status = tk.Label(root, text="Conectando...", font=("Segoe UI", 11))
        self.status.pack(fill="x")

        self.sock = None
        self.send_lock = threading.Lock()
        self.incoming = queue.Queue()
        self.player_id = None
        self.paddles = [
            {"x": 30, "y": CANVAS_HEIGHT / 2},
            {"x": CANVAS_WIDTH - 30, "y": CANVAS_HEIGHT / 2},
        ]
        self.ball = {"x": CANVAS_WIDTH / 2, "y": CANVAS_HEIGHT / 2}
        self.score = [0, 0]
        self.held_keys = set()
        self.closed = False

        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.connect((SERVER_HOST, SERVER_PORT))
        except OSError as exc:
            if self.sock:
                self.sock.close()
                self.sock = None
            messagebox.showerror("Error de conexión", str(exc), parent=root)
            self.root.destroy()
            return

        threading.Thread(target=self.receive_messages, daemon=True).start()
        self.root.bind_all("<KeyPress>", self.on_key_press)
        self.root.bind_all("<KeyRelease>", self.on_key_release)
        self.root.bind("<FocusOut>", self.on_focus_out)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(16, self.update)
        self.root.after(30, self.send_input)

    def send_message(self, message):
        if not self.sock:
            return
        data = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        try:
            with self.send_lock:
                self.sock.sendall(data)
        except OSError:
            self.incoming.put({"type": "disconnected"})

    def receive_messages(self):
        buffer = b""
        try:
            while True:
                chunk = self.sock.recv(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    raw_line, buffer = buffer.split(b"\n", 1)
                    if raw_line:
                        try:
                            self.incoming.put(json.loads(raw_line.decode("utf-8")))
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            self.incoming.put({
                                "type": "error",
                                "message": "El servidor envió un mensaje inválido.",
                            })
        except OSError:
            pass
        finally:
            if not self.closed:
                self.incoming.put({"type": "disconnected"})

    def on_key_press(self, event):
        key = event.keysym.lower()
        valid_keys = ("w", "a", "s", "d") if self.player_id == 1 else (
            "up", "left", "down", "right"
        )
        if self.player_id in (1, 2) and key in valid_keys:
            self.held_keys.add(key)
            self.status.config(text="Jugador {} — tecla recibida: {}".format(
                self.player_id, event.keysym
            ))
            self.transmit_input()

    def on_key_release(self, event):
        key = event.keysym.lower()
        if key in self.held_keys:
            self.held_keys.discard(key)
            self.transmit_input()

    def on_focus_out(self, _event):
        if self.held_keys:
            self.held_keys.clear()
            self.transmit_input()

    def transmit_input(self):
        if self.closed:
            return
        horizontal = 0
        vertical = 0
        if self.player_id == 1:
            horizontal = int("d" in self.held_keys) - int("a" in self.held_keys)
            vertical = int("s" in self.held_keys) - int("w" in self.held_keys)
        elif self.player_id == 2:
            horizontal = int("right" in self.held_keys) - int("left" in self.held_keys)
            vertical = int("down" in self.held_keys) - int("up" in self.held_keys)

        if horizontal and vertical:
            horizontal *= 0.7071
            vertical *= 0.7071
        self.send_message({
            "type": "input",
            "x": horizontal,
            "y": vertical,
        })

    def send_input(self):
        if self.closed:
            return
        self.transmit_input()
        self.root.after(30, self.send_input)

    def update(self):
        if self.closed:
            return
        while True:
            try:
                message = self.incoming.get_nowait()
            except queue.Empty:
                break
            self.handle_message(message)
        if not self.closed:
            self.draw()
            self.root.after(16, self.update)

    def handle_message(self, message):
        message_type = message.get("type")
        if message_type == "welcome":
            self.player_id = message["player"]
            controls = "W/A/S/D" if self.player_id == 1 else "↑/←/↓/→"
            self.status.config(text="Jugador {} — controles: {}".format(self.player_id, controls))
        elif message_type == "waiting":
            self.status.config(text="Esperando al segundo jugador...")
        elif message_type == "start":
            self.status.config(text="Partida iniciada — mueve tu paleta.")
        elif message_type == "state":
            self.paddles = message["paddles"]
            self.ball = message["ball"]
            self.score = message["score"]
        elif message_type == "game_over":
            winner = message.get("winner")
            if winner in (1, 2):
                messagebox.showinfo(
                    "Fin de la partida",
                    "Ganó el jugador {}. Marcador: {} - {}".format(
                        winner, *message.get("score", self.score)
                    ),
                    parent=self.root,
                )
            else:
                messagebox.showinfo("Fin de la partida", "La partida terminó.", parent=self.root)
            self.close(send_quit=False)
        elif message_type == "error":
            self.status.config(text=message.get("message", "Error de protocolo."))
        elif message_type == "disconnected":
            if not self.closed:
                self.status.config(text="Conexión perdida.")
                messagebox.showwarning(
                    "Conexión perdida",
                    "Se perdió la conexión con el servidor.",
                    parent=self.root,
                )
                self.close(send_quit=False)

    def draw(self):
        self.canvas.delete("all")
        self.canvas.create_line(
            CANVAS_WIDTH // 2, 0, CANVAS_WIDTH // 2, CANVAS_HEIGHT,
            fill="#52616b", dash=(8, 8),
        )
        self.canvas.create_text(
            CANVAS_WIDTH // 2 - 60, 35, text=str(self.score[0]),
            fill="white", font=("Segoe UI", 28, "bold"),
        )
        self.canvas.create_text(
            CANVAS_WIDTH // 2 + 60, 35, text=str(self.score[1]),
            fill="white", font=("Segoe UI", 28, "bold"),
        )
        for paddle in self.paddles:
            x, y = paddle["x"], paddle["y"]
            self.canvas.create_rectangle(
                x - PADDLE_WIDTH // 2, y - PADDLE_HEIGHT // 2,
                x + PADDLE_WIDTH // 2, y + PADDLE_HEIGHT // 2,
                fill="#00d1b2", outline="",
            )
        x, y = self.ball["x"], self.ball["y"]
        self.canvas.create_oval(
            x - BALL_RADIUS, y - BALL_RADIUS, x + BALL_RADIUS, y + BALL_RADIUS,
            fill="#ffffff", outline="",
        )

    def close(self, send_quit=True):
        if self.closed:
            return
        self.closed = True
        if self.sock:
            if send_quit:
                self.send_message({"type": "quit"})
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()
            self.sock = None
        self.root.destroy()


def main():
    root = tk.Tk()
    PongClient(root)
    root.mainloop()


if __name__ == "__main__":
    main()
