# Control de Rondas (APM Terminals Valencia)

APK Android: https://github.com/carlos747eccma-lgtm/control-rondas/releases/latest


App web para el móvil (se instala como app desde el navegador) que registra la ronda del vigilante.

## Qué hace
- **Control de paso**: puntos de control y salidas marcados en el mapa. Cada punto sale en verde (al día), naranja (toca pasar) o rojo (atrasado) según la frecuencia exigida (60 min por defecto).
- **Rondas completas**: una ronda cuenta cuando el vigilante pasa por todos los puntos; % de cumplimiento por turno.
- **Informe del turno** en PDF con rondas, pasos por punto, paradas, incidencias y firmas.
- Recorrido GPS dibujado en azul sobre el mapa satélite.
- Velocidad actual, media y máxima; distancia y tiempo total.
- Paradas: más de 30 s dentro de 8 m cuenta como parada, con hora, duración y lugar (puntos naranjas). Aviso con vibración si lleva más de 5 min parado.
- El patio sale en ROJO y el rojo se va borrando por donde pasa el vigilante (10 m a cada lado), con el % cubierto.
- Salidas al exterior marcadas en el mapa, registro cuando se pasa por ellas y aviso al salir del límite del recinto.
- Historial de rondas con exportación GPX (recorrido) y CSV (paradas y eventos, abre en Excel).

## GPS entre pilas de contenedores
Los contenedores rebotan la señal y el GPS "salta". La app:
1. Ignora posiciones con precisión peor de 25 m.
2. Ignora saltos imposibles (más de 25 km/h).
3. Suaviza la posición con un filtro de Kalman.
4. No suma distancia por el temblor del GPS estando quieto.
5. Avisa si lleva 30 s sin señal válida.
Todos estos valores se ajustan en la pestaña Ajustes.

## Primer uso
1. Pestaña **Configurar** → "Dibujar límite": toca el mapa en cada esquina del recinto → "Terminar límite".
2. "+ Punto de control" y "+ Salida exterior" tocando el mapa.
3. "Exportar patio" guarda el patio en un archivo para cargarlo en otros móviles con "Importar patio".
4. El seguimiento es permanente: arranca solo al abrir la app y no se puede parar. Cada cambio de turno (6:00, 14:00 y 22:00, configurable) el turno se guarda en el historial y el patio vuelve a rojo. Mantén la pantalla encendida (el navegador para el GPS con la pantalla apagada).

"Simular ronda de prueba" (en Ajustes) hace un recorrido de prueba con errores de GPS para ver cómo funciona.

## Google Maps
Sin clave usa el satélite de Esri/OpenStreetMap. Para ver Google Maps, pon la clave de la API de Maps JavaScript en config.js (vale para todos los móviles) o en Ajustes.

## Publicarla
Necesita HTTPS para usar el GPS (GitHub Pages, Netlify, etc.). Sube todos los archivos de esta carpeta tal cual.
Los datos se guardan solo en el móvil (no hay servidor).
