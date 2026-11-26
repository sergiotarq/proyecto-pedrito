# Ping Pong multijugador

Juego de navegador para dos jugadores, creado con Canvas y WebSockets. El servidor calcula el movimiento, las colisiones y el marcador; los controles se pueden usar con teclado o pantalla táctil.

## Requisitos y ejecución

- Node.js y npm.
- Instala la dependencia una vez: `npm install`.
- Inicia el juego con `npm start` y abre `http://127.0.0.1:8080/` en dos pestañas.
- Ejecuta las pruebas con `npm test`.

El creador será el jugador 1 y usa **W/A/S/D**; el invitado será el jugador 2 y usa las **flechas**. En dispositivos con pantalla táctil aparecen controles en pantalla. El límite es de dos conexiones simultáneas.

El HTML, los estilos y el código del navegador están en `index.html`, `styles.css` y `app.js`, respectivamente. El servidor solo publica esos recursos y la página del juego.

## Sala, invitación y duración

Al abrir el juego, el primer jugador crea la sala. Puede copiar el enlace de invitación o compartir el QR; el segundo jugador entra desde ese enlace y el creador pulsa **Iniciar partida** cuando ambos estén conectados. El QR solo se muestra cuando se configura una dirección pública.

Cada partida dura **2 minutos**. El servidor es quien lleva el reloj y decide el resultado: gana quien tenga más puntos al terminar el tiempo. Si el marcador está empatado, empieza la **muerte súbita** y el siguiente punto decide al ganador. Después, el creador puede iniciar una nueva ronda.

El servidor admite una sala de dos jugadores a la vez. El enlace contiene un código de invitación generado al iniciar el servidor; al reiniciar el proceso, se debe compartir el enlace/QR nuevo.

## Configuración de red

Por seguridad, el servidor escucha únicamente en `127.0.0.1` por defecto. Se pueden definir `HOST` y `PORT` antes de iniciarlo:

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "8080"
npm start
```

`0.0.0.0` permite conexiones de otros dispositivos en la red local; usa la dirección IP local del equipo en el navegador. El puerto `0` también se admite para pruebas y hace que el sistema operativo elija un puerto libre.

Para jugar desde Internet, no expongas directamente el servidor Node en una red pública. Despliégalo detrás de un proxy inverso con TLS (HTTPS/WSS), reglas de firewall y un dominio configurado. Configura `PUBLIC_URL` con ese origen HTTPS para que el servidor genere un QR válido. El proxy debe conservar el encabezado `Host` para que la comprobación de origen WebSocket funcione.

Ejemplo de variables de entorno en PowerShell para un servidor publicado:

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "8080"
$env:PUBLIC_URL = "https://tu-dominio.example"
npm start
```

En un despliegue real, configura las mismas variables en el panel de tu proveedor y termina TLS en el proxy. El proxy debe reenviar las conexiones WebSocket (`Upgrade`/`Connection`). El código QR no es un sistema de autenticación: cualquier persona que obtenga el enlace puede intentar ocupar el puesto del segundo jugador.

## Versión de escritorio con sockets TCP

La versión original sigue disponible con `server.py` y `client.py`. Usa TCP (`SOCK_STREAM`) para conservar el orden y la entrega fiable de los controles y mensajes de partida. Para iniciarla, ejecuta `python server.py` y, en dos terminales adicionales, `python client.py`.

Si la versión de escritorio sigue ejecutándose con `python server.py`, detenla primero: también usa el puerto 8080.
