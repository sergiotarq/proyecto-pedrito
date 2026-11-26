"""Sirve el cliente HTML y conecta dos navegadores con el juego TCP existente."""

import base64
import hashlib
import json
import socket
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue

import server as pong


HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8000
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME_SIZE = 64 * 1024
WEB_ROOT = Path(__file__).resolve().parent


class WebSocketConnection:
    """Adapta mensajes WebSocket al flujo JSON por líneas que usa el servidor."""

    def __init__(self, connection, reader):
        self.connection = connection
        self.reader = reader
        self.incoming = Queue()
        self.send_lock = threading.Lock()
        self.closed = threading.Event()
        self.pending = b""

    def start_reader(self):
        threading.Thread(target=self._read_messages, daemon=True).start()

    def _read_exact(self, size):
        data = self.reader.read(size)
        if len(data) != size:
            raise ConnectionError("Conexión WebSocket cerrada.")
        return data

    def _send_frame(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length <= 0xFFFF:
            header.append(126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(127)
            header.extend(length.to_bytes(8, "big"))
        with self.send_lock:
            self.connection.sendall(bytes(header) + payload)

    def _read_messages(self):
        fragment_opcode = None
        fragments = bytearray()
        try:
            while True:
                header = self.reader.read(2)
                if not header:
                    break
                if len(header) != 2:
                    raise ConnectionError("Encabezado WebSocket incompleto.")

                first, second = header
                final = bool(first & 0x80)
                opcode = first & 0x0F
                masked = bool(second & 0x80)
                length = second & 0x7F
                if length == 126:
                    length = int.from_bytes(self._read_exact(2), "big")
                elif length == 127:
                    length = int.from_bytes(self._read_exact(8), "big")
                if length > MAX_FRAME_SIZE:
                    raise ConnectionError("Mensaje WebSocket demasiado grande.")
                if not masked:
                    raise ConnectionError("El cliente WebSocket debe enmascarar sus mensajes.")

                mask = self._read_exact(4)
                payload = self._read_exact(length)
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))

                if opcode == 0x8:
                    self._send_frame(0x8, payload[:125])
                    break
                if opcode == 0x9:
                    self._send_frame(0xA, payload)
                    continue
                if opcode == 0xA:
                    continue
                if opcode in (0x1, 0x2):
                    if final:
                        if opcode == 0x1:
                            self.incoming.put(payload + b"\n")
                    else:
                        fragment_opcode = opcode
                        fragments = bytearray(payload)
                    continue
                if opcode == 0x0 and fragment_opcode is not None:
                    fragments.extend(payload)
                    if len(fragments) > MAX_FRAME_SIZE:
                        raise ConnectionError("Mensaje WebSocket demasiado grande.")
                    if final:
                        if fragment_opcode == 0x1:
                            self.incoming.put(bytes(fragments) + b"\n")
                        fragment_opcode = None
                        fragments.clear()
                    continue
                raise ConnectionError("Tipo de trama WebSocket no válido.")
        except (ConnectionError, OSError, ValueError):
            pass
        finally:
            self.closed.set()
            self.incoming.put(None)

    def recv(self, size):
        if not self.pending:
            message = self.incoming.get()
            if message is None:
                return b""
            self.pending = message
        data, self.pending = self.pending[:size], self.pending[size:]
        return data

    def sendall(self, data):
        message = data.rstrip(b"\n")
        if message:
            self._send_frame(0x1, message)

    def shutdown(self, how):
        self.connection.shutdown(how)

    def close(self):
        if not self.closed.is_set():
            try:
                self._send_frame(0x8, b"")
            except OSError:
                pass
        self.closed.set()
        try:
            self.connection.close()
        except OSError:
            pass
        self.incoming.put(None)


class Match:
    def __init__(self):
        self.players = []
        self.state_lock = threading.Lock()
        self.finished = threading.Event()
        self.started = False


class MatchCoordinator:
    def __init__(self):
        self.lock = threading.Lock()
        self.current_match = None

    def join(self, websocket, address):
        with self.lock:
            match = self.current_match
            if match is not None and not match.started and any(
                player.sock.closed.is_set() for player in match.players
            ):
                match.finished.set()
                self.current_match = None
                match = None
            if match is None or match.finished.is_set():
                match = Match()
                self.current_match = match
            if len(match.players) >= 2:
                websocket.sendall(
                    (json.dumps({
                        "type": "error",
                        "message": "La partida ya tiene dos jugadores.",
                    }) + "\n").encode("utf-8")
                )
                websocket.close()
                return

            player_id = len(match.players) + 1
            player = pong.Player(websocket, address, player_id)
            match.players.append(player)
            websocket.start_reader()
            pong.send_message(player, {"type": "welcome", "player": player_id})
            print("Jugador {} conectado por WebSocket desde {}.".format(player_id, address))
            threading.Thread(
                target=pong.receive_player,
                args=(player, match.state_lock),
                daemon=True,
            ).start()

            if player_id == 1:
                pong.send_message(player, {"type": "waiting"})
            else:
                match.started = True
                threading.Thread(
                    target=self._run_match,
                    args=(match,),
                    daemon=True,
                ).start()

        while not match.finished.wait(0.1):
            if not match.started and any(
                joined_player.sock.closed.is_set()
                for joined_player in match.players
            ):
                with self.lock:
                    if self.current_match is match and not match.started:
                        match.finished.set()
                        self.current_match = None
                break

    def _run_match(self, match):
        print("Partida web iniciada.", flush=True)
        try:
            pong.run_game(
                match.players,
                state_lock=match.state_lock,
                start_receivers=False,
            )
        finally:
            for player in match.players:
                player.sock.close()
            match.finished.set()
            with self.lock:
                if self.current_match is match:
                    self.current_match = None


coordinator = MatchCoordinator()


class PongRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/ws":
            super().do_GET()
            return

        if (
            self.headers.get("Upgrade", "").lower() != "websocket"
            or "upgrade" not in self.headers.get("Connection", "").lower()
            or self.headers.get("Sec-WebSocket-Version") != "13"
        ):
            self.send_error(400, "Se requiere un handshake WebSocket válido.")
            return

        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_error(400, "Falta Sec-WebSocket-Key.")
            return

        accept = base64.b64encode(
            hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()
        ).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()

        websocket = WebSocketConnection(self.connection, self.rfile)
        websocket.start_reader()
        try:
            coordinator.join(websocket, self.client_address)
        except (ConnectionError, OSError) as exc:
            print("Conexión web cerrada: {}".format(exc), flush=True)
        finally:
            websocket.close()

    def log_message(self, format_string, *args):
        print("HTTP: {}".format(format_string % args), flush=True)


class PongHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    address = (HTTP_HOST, HTTP_PORT)
    try:
        with PongHTTPServer(address, PongRequestHandler) as http_server:
            print(
                "Pong web disponible en http://{}:{}/".format(*address),
                flush=True,
            )
            print("Abre la dirección en dos ventanas del navegador.", flush=True)
            http_server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor web detenido.", flush=True)
    except OSError as exc:
        print("No se pudo iniciar el servidor web: {}".format(exc), flush=True)


if __name__ == "__main__":
    main()
