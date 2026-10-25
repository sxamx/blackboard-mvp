# MVP: selector y descarga de materiales de Blackboard Duoc

Lee nombres de carpetas `CLASE N°…` y archivos que Blackboard ya muestra. Asocia cada bloque visible a su clase, permite seleccionar archivos y ofrece dos formatos: carpetas dentro de una carpeta con el nombre del curso, o un ZIP con una subcarpeta por clase. Si un nombre no tiene asociación segura, aparece en `Archivos sin clase identificada`.

## Qué hace y qué permisos tiene

- Al pulsar **Detectar clases y archivos**, lee los nombres y enlaces ya renderizados por Blackboard, incluidos los metadatos de la fila que usa el menú de tres puntos. No navega, no abre carpetas ni pulsa ese menú.
- Solo devuelve nombres y enlaces al panel de la extensión. Si no encuentra un enlace directo, la casilla puede marcarse, pero el botón queda deshabilitado para ese archivo.
- No empieza ninguna descarga hasta que pulses el botón de descarga. En formato carpeta, guarda los archivos en `Descargas/<curso>/<nombre de clase>/<archivo>`; los sin asociación segura van a una subcarpeta `Archivos sin clase identificada` dentro del curso. En formato ZIP, genera `<curso>.zip` con una carpeta por clase y sus archivos.
- En formato carpeta, el navegador sigue mostrando una entrada individual por cada archivo. Para ver la estructura física, usa **Mostrar en carpeta** desde la lista de descargas.
- El formato ZIP puede incluir selecciones de hasta 50 MB y solo procesa enlaces del mismo sitio de Blackboard. No comprime el contenido; agrupa los archivos para evitar aumentar mucho el uso de memoria. Para selecciones mayores o enlaces a otros sitios Duoc, usa el formato carpeta.
- En formato carpeta, el service worker de la extensión fija la ruta cuando el navegador determina el nombre final y revisa la ruta reportada. Si otro gestor de descargas la cambia, el panel lo indicará.
- La selección solo vive en el panel y se borra al cerrarlo. Los enlaces no se guardan ni se envían a otro servidor.
- Solicita `activeTab`, `scripting` y `downloads`: los dos primeros leen la pestaña tras pulsar detectar; `downloads` permite iniciar las descargas que seleccionaste.

La lectura de los metadatos de fila se ejecuta en el contexto de la página de Blackboard para acceder a los datos que su interfaz ya tiene cargados. No llama las acciones del menú ni modifica esos datos.

Al actualizar la extensión, Edge o Chrome puede pedir que aceptes el permiso `downloads`. Sin ese permiso, el botón no puede iniciar descargas.

## Instalar

1. Descomprime `blackboard-mvp.zip` en una carpeta fija. Si ya cargaste una versión anterior desde una carpeta, reemplaza los archivos de esa misma carpeta por los nuevos.
2. En Edge abre `edge://extensions`; en Chrome abre `chrome://extensions`.
3. Activa **Modo de desarrollador**.
4. Selecciona **Cargar descomprimida** y elige la carpeta `blackboard-mvp`. Si Edge ofrece **Recargar** para la extensión existente, púlsalo y acepta el permiso `downloads` si lo solicita.
5. Abre el panel de la extensión y confirma que abajo indique la versión `0.8.5`.

## Probar

1. Abre Blackboard de Duoc con tu flujo normal de inicio de sesión.
2. Entra al curso y a la vista donde aparece la lista de carpetas `CLASE N°…`.
3. Deja abierta la lista de contenido a la izquierda. Si quieres ver archivos de una clase, ábrela manualmente en Blackboard.
4. Pulsa el icono de la extensión para abrir su panel y después **Detectar clases y archivos**.
5. Revisa los nombres y la indicación de enlace. Usa la casilla junto a una clase para marcar sus archivos, o marca archivos individualmente. **Seleccionar todos los archivos visibles** marca el inventario que aparece en el popup.
6. Elige **Carpeta del curso con subcarpetas por clase** o **Un ZIP con subcarpetas por clase**. Pulsa el botón de descarga y revisa el avance en Descargas del navegador.
7. Cierra el panel para borrar la selección temporal; vuelve a detectar cuando quieras actualizar la lista.

Si no encuentra ninguna, no modifica nada. Vuelve a la página del curso donde se ve la lista de clases y prueba ahí. Si el nombre del curso o alguna clase aparece truncado o falta, comparte una captura sin datos personales para ajustar solo el detector.

## Límites de esta etapa

El detector busca nombres y enlaces en la vista ya cargada. No abre carpetas para recorrer contenido que Blackboard todavía no muestra. Si una clase aparece como “sin archivos visibles”, ábrela manualmente y vuelve a detectar. Si Blackboard no expone un enlace directo seguro para un archivo, la extensión avisa y no intenta descargarlo.
