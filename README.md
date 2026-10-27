# MVP: selector y descarga de materiales de Blackboard Duoc

Lee nombres de carpetas `CLASE N°…` y archivos que Blackboard ya muestra. Asocia cada bloque visible a su clase, permite seleccionar archivos y ofrece dos formatos: una cola recuperable de carpetas por clase, o un ZIP con una subcarpeta por clase. Si un nombre no tiene asociación segura, aparece en `Archivos sin clase identificada`.

## Qué hace y qué permisos tiene

- Al pulsar **Detectar clases y archivos**, lee los nombres y enlaces ya renderizados por Blackboard, incluidos los metadatos de la fila que usa el menú de tres puntos. El menú **Abrir clases** puede expandir las carpetas que selecciones y volver a detectar sus archivos. No navega a otros cursos ni pulsa el menú de tres puntos.
- Solo devuelve nombres y enlaces al panel de la extensión. Si no encuentra un enlace directo, la casilla puede marcarse, pero el botón queda deshabilitado para ese archivo.
- No empieza ninguna descarga hasta que pulses el botón de descarga. En formato carpeta, envía todas las solicitudes a Edge sin esperar a que termine el archivo anterior y las guarda en `Descargas/<curso>/<nombre de clase>/<archivo>`; los sin asociación segura van a una subcarpeta `Archivos sin clase identificada` dentro del curso. En formato ZIP, genera `<curso>.zip` con una carpeta por clase y sus archivos.
- Si Edge tiene activado **Preguntar dónde guardar cada archivo antes de descargarlo**, puede mostrar una ventana de confirmación por archivo. La extensión deja de esperar a que termine el archivo anterior para enviar las demás solicitudes, pero Edge controla cuándo muestra cada ventana. Desactiva esa opción en `edge://settings/downloads` si quieres que las descargas comiencen sin confirmar cada una.
- En formato carpeta, el navegador sigue mostrando una entrada individual por cada archivo. Para ver la estructura física, usa **Mostrar en carpeta** desde la lista de descargas.
- El formato ZIP admite hasta 100 MB de contenido y solo procesa enlaces del mismo sitio de Blackboard; el ZIP final puede ser algo mayor por sus índices. No comprime el contenido y arma el archivo en memoria, por lo que puede usar bastante más memoria que el tamaño final. Para selecciones mayores, o si Edge se queda sin memoria, usa el formato carpeta.
- En formato carpeta, la extensión conserva la ruta prevista en el almacenamiento de sesión hasta que Edge determina el nombre final, incluso si se reinicia el service worker. Luego revisa la ruta reportada y marca “ruta cambiada” en la cola si Edge guardó el archivo fuera de la carpeta prevista.
- El botón **Cancelar y eliminar cola** detiene las descargas que Edge todavía tiene activas y borra el progreso guardado. Conserva los archivos completados. Si Edge dejó una ventana de Guardar pendiente, ciérrala manualmente.
- La selección del panel se borra al cerrarlo. Para formato carpeta, la extensión guarda localmente el curso, nombres, rutas, estado y los identificadores de descarga; no guarda el contenido ni persiste los enlaces privados. Los enlaces de archivos pendientes se mantienen solo en el almacenamiento de sesión y se descartan al cerrar Edge o actualizar la extensión. Edge conserva el historial normal de las descargas iniciadas. La extensión no envía datos ni enlaces a servidores de terceros; las peticiones de descarga van a Blackboard.
- Solicita `activeTab`, `scripting`, `downloads` y `storage`: los dos primeros leen la pestaña tras pulsar detectar; `downloads` inicia y consulta el estado; `storage` conserva localmente el progreso de la cola.

La lectura de los metadatos de fila se ejecuta en el contexto de la página de Blackboard para acceder a los datos que su interfaz ya tiene cargados. No llama las acciones del menú ni modifica esos datos.

La cola de carpetas conserva el estado entre aperturas del panel y reinicios del service worker. Puedes cerrar el panel mientras Edge descarga. Si Edge interrumpe un archivo, la extensión ofrece reanudarlo cuando el navegador lo permita. Los archivos que todavía no empezaron necesitan enlaces nuevos: abre Blackboard, detecta otra vez el contenido y pulsa `Actualizar enlaces pendientes`. Los enlaces recién detectados solo se mantienen durante la sesión actual de Edge.

El ZIP sigue siendo una descarga única y no conserva el avance de cada archivo que contiene.

Al actualizar la extensión, Edge o Chrome puede pedir que aceptes los permisos `downloads` y `storage`. Sin ellos, la extensión no puede iniciar descargas ni guardar el progreso local.

## Instalar

1. Descomprime `blackboard-mvp.zip` en una carpeta fija. Si ya cargaste una versión anterior desde una carpeta, reemplaza los archivos de esa misma carpeta por los nuevos.
2. En Edge abre `edge://extensions`; en Chrome abre `chrome://extensions`.
3. Activa **Modo de desarrollador**.
4. Selecciona **Cargar descomprimida** y elige la carpeta `blackboard-mvp`. Si Edge ofrece **Recargar** para la extensión existente, púlsalo y acepta los permisos `downloads` y `storage` si los solicita.
5. Abre el panel de la extensión y confirma que abajo indique la versión `0.11.1`.

## Probar

1. Abre Blackboard de Duoc con tu flujo normal de inicio de sesión.
2. Entra al curso y a la vista donde aparece la lista de carpetas `CLASE N°…`.
3. Deja abierta la lista de contenido a la izquierda.
4. Pulsa el icono de la extensión para abrir su panel y después **Detectar clases y archivos**.
5. En **Abrir clases**, selecciona una o varias carpetas y pulsa **Abrir clases seleccionadas** para expandirlas en Blackboard; la extensión vuelve a detectar los archivos visibles. Revisa los nombres y la indicación de enlace. Usa la casilla junto a una clase para marcar sus archivos, o marca archivos individualmente. **Seleccionar todos los archivos visibles** marca el inventario que aparece en el popup.
6. Elige **Carpeta del curso con subcarpetas por clase** o **Un ZIP con subcarpetas por clase**. Pulsa el botón de descarga y revisa el avance en Descargas del navegador.
7. Cierra el panel para borrar la selección temporal; vuelve a detectar cuando quieras actualizar la lista.

Para recuperar la cola tras reiniciar Edge, abre de nuevo Blackboard, detecta el contenido del curso y pulsa `Reanudar archivo interrumpido` si aparece. Luego pulsa `Actualizar enlaces pendientes` para los archivos que aún no habían comenzado.

Si no encuentra ninguna, no modifica nada. Vuelve a la página del curso donde se ve la lista de clases y prueba ahí. Si el nombre del curso o alguna clase aparece truncado o falta, comparte una captura sin datos personales para ajustar solo el detector.

## Límites de esta etapa

El detector busca nombres y enlaces en la vista ya cargada. No abre carpetas para recorrer contenido que Blackboard todavía no muestra. Si una clase aparece como “sin archivos visibles”, ábrela manualmente y vuelve a detectar. Si Blackboard no expone un enlace directo seguro para un archivo, la extensión avisa y no intenta descargarlo.
