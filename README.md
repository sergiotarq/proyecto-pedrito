# Ping Pong multijugador

Juego de navegador para dos jugadores con Canvas y WebSockets. El menú ofrece tres opciones:

- **Jugar por 2:** ambos juegan en el mismo dispositivo. Jugador 1 usa W/A/S/D y jugador 2 usa las flechas. La duración se elige en el menú.
- **Crear partida:** el anfitrión elige su nombre y el tiempo de juego, y crea una sala online.
- **Buscar partidas:** muestra salas públicas que están esperando a un rival. Las salas se actualizan automáticamente y también se pueden actualizar manualmente.

Las duraciones disponibles son 1, 2, 3, 5 y 10 minutos. En todas las modalidades, gana quien tenga más puntos cuando termina el tiempo; si empatan, el siguiente punto decide por muerte súbita. En el modo online, el servidor controla la física, el tiempo y los resultados.

## Requisitos y ejecución

- Node.js y npm.
- Instala dependencias con `npm install`.
- Inicia el juego con `npm start` y abre `http://127.0.0.1:8080/`.
- Ejecuta las pruebas con `npm test`.

El proyecto sirve la interfaz desde `index.html`, `styles.css` y `app.js`; el servidor Node está en `server.js`. La versión de escritorio con sockets TCP sigue disponible en `server.py` y `client.py`.

## Despliegue

El servidor escucha en `127.0.0.1` por defecto durante el desarrollo. En Render detecta automáticamente el entorno y escucha en `0.0.0.0`; usa el puerto indicado por `PORT`. Render asigna automáticamente la URL pública mediante `RENDER_EXTERNAL_URL`; el QR de una sala nueva apunta a esa dirección.

Para otros proveedores, configura `HOST=0.0.0.0`, el puerto con `PORT` y la dirección pública HTTPS con `PUBLIC_URL`. El proxy inverso debe permitir conexiones WebSocket y conservar el encabezado `Host`.

Cada instancia mantiene las salas en memoria. Para que la búsqueda funcione entre anfitriones, todos deben usar la misma instancia del servicio. No escales el servicio a varias instancias sin añadir almacenamiento compartido y coordinación de salas.
