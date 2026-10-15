# Mantener la versión personalizada de T3 Code

Esta guía mantiene el Command Center al incorporar cambios oficiales. El repositorio propio es
`audelgado/t3code.per`; la rama de trabajo actual es `feat/command-center`. La base oficial es
`pingdotgg/t3code`. Una actualización del instalador oficial reemplaza la aplicación personalizada;
no incorpora automáticamente los cambios de esta rama.

## Preparar una actualización

1. Revisa `git status --short` y `git diff`. Guarda los cambios que pertenecen a tu versión en
   commits, incluyendo las correcciones locales de compilación que quieras conservar. No agregues
   `.env`, credenciales, datos, instaladores ni material temporal.
2. Conserva el instalador anterior fuera de `release`, porque una compilación puede reemplazarlo.
3. Respalda los datos de cada servidor que actualizarás. Detén sus agentes y cierra el servidor
   antes de copiar su directorio de datos completo, para obtener una copia consistente de SQLite.
   El directorio habitual es `~/.t3/userdata`; puede cambiar con `T3CODE_HOME` o `--home-dir`.
   Incluye `statev2.sqlite`, `settings.json`, secretos y los archivos del Command Center. Trata el
   respaldo como información privada. Los repositorios de tus proyectos se respaldan aparte.
4. Registra el commit, la versión del instalador y la ubicación del respaldo. Esta información
   pertenece a tus notas de lanzamiento, no a una nueva lista de tareas dentro del repositorio.

Comprueba que el árbol de trabajo esté limpio antes de continuar:

```powershell
Set-Location D:\T3code
git status --short
git branch --show-current
git rev-parse HEAD
```

## Incorporar una versión oficial en una rama de prueba

Usa una versión oficial concreta para que puedas reproducir y revisar la actualización. No es
necesario seguir todos los commits nuevos. Los comandos siguientes no instalan ni publican nada.

```powershell
git remote -v
# Solo si todavía no existe el remoto upstream:
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream --tags

$updateId = Get-Date -Format yyyyMMdd-HHmm
git branch "backup/command-center-$updateId" feat/command-center
git worktree add "D:\T3code-updates\$updateId" -b "update/command-center-$updateId" feat/command-center
Set-Location "D:\T3code-updates\$updateId"
```

Revisa las versiones disponibles con `git tag --list 'v*' --sort=-version:refname`. Sustituye el
valor de ejemplo por el tag elegido y mezcla sus cambios:

```powershell
$upstreamVersion = 'vVERSION-ELEGIDA'
git merge --no-commit --no-ff $upstreamVersion
git status --short
```

Si hay conflictos, revisa ambos comportamientos: los cambios oficiales y los del Command Center.
Presta especial atención a contratos RPC, opciones, rutas, servicios y empaquetado. No aceptes
automáticamente todos los cambios de un lado. Para abandonar una mezcla pendiente usa
`git merge --abort`, antes de empezar nuevas modificaciones.

Después de resolver, agrega únicamente los archivos revisados y termina el commit de integración.
El merge conserva el historial publicado y facilita reconocer qué versión oficial incorporaste.

## Verificar con datos aislados

```powershell
vp i
vp run migrate-dev-db
```

La migración de desarrollo copia un snapshot de solo lectura de los datos reales a la `.t3` del
worktree, manteniendo proyectos e hilos detenidos. No es un respaldo completo del Command Center
ni una prueba de que todos sus datos se hayan migrado. No inicies un servidor contra el directorio
de datos real para hacer pruebas. Consulta [Desarrollo](development.md) para preparar un entorno
aislado y elegir puertos.

Ejecuta las pruebas y verificaciones específicas de los archivos afectados. Por ejemplo, para
los ajustes de personalización:

```powershell
vp test run packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts apps/web/src/components/commandCenter/customization.test.ts apps/web/src/components/settings/settingsSearch.test.ts
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/web typecheck
```

Revisa también el esquema del Command Center y su compatibilidad con las migraciones oficiales:
[schema.ts](../../apps/server/src/commandCenter/schema.ts). No reserves números de migración del
proyecto oficial para funciones exclusivas del fork. Si una actualización cambia datos, pruébala
en una copia consistente del entorno, con agentes y tareas automáticas desactivados.

Antes de instalar, haz una revisión manual en un cliente autorizado: abrir el panel, ver equipos
y proyectos, personalizar secciones y acciones, reconectar y comprobar que los ajustes persisten.
Verifica los flujos que cambió la actualización: delegación, memoria, artefactos y workflows.
Si usas acceso remoto, comprueba también esa conexión y la compatibilidad del cliente móvil.

## Generar e instalar la versión propia

Para una compilación manual de prueba en Windows x64:

```powershell
node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 --build-version 0.0.45-preview.20261014.1 --output-dir release/custom
```

Sustituye la base, fecha y número por los de tu compilación. Los sufijos `preview.FECHA.NUMERO`
producen instaladores manuales sin canal de autoactualización. No uses `--skip-build` si cambió
el código: reutilizaría los archivos compilados anteriores. El comando muestra los artefactos
generados; el instalador queda en la carpeta indicada.

Cuando la rama de prueba pase las verificaciones, intégrala en `feat/command-center`, guarda el
instalador y registra la versión base oficial y el commit del fork. Instala primero en una máquina
de prueba. Para usar el panel remotamente necesitas que el servidor también ejecute este fork;
el sitio web oficial y los servidores instalados desde npm no incorporan sus funciones propias.

Evita usar la actualización general de servidores para sustituir una instalación personalizada
por un paquete oficial. Actualiza cada entorno personalizado con sus propios artefactos.

## Recuperar la versión anterior

Si falla la aplicación, cierra la instalación nueva e instala el artefacto anterior. Si el nuevo
servidor modificó el esquema o los datos, volver al ejecutable anterior puede no ser suficiente:
restaura una copia completa del respaldo en un entorno de recuperación separado y comprueba que
abre con la versión anterior. Conserva también los datos nuevos para no perder trabajo realizado
después del respaldo. No mezcles manualmente archivos SQLite de versiones distintas ni reemplaces
una base mientras está abierta.

## Configurar actualizaciones propias más adelante

El empaquetador acepta `T3CODE_DESKTOP_UPDATE_REPOSITORY=audelgado/t3code.per`. Es una opción de
compilación: escribirla después de instalar no cambia el canal de una aplicación ya construida.
Para usarla hay que publicar instaladores y los manifiestos de electron-builder de una versión
que no sea preview, con números de versión crecientes, y probar descarga, instalación y reinicio
entre dos versiones del fork. La variable configura la fuente; no publica archivos por sí sola.

No ejecutes sin adaptar el [workflow oficial de lanzamiento](../../.github/workflows/release.yml):
también publica paquetes y otros productos y depende de infraestructura de los mantenedores.
Para este fork, prepara un flujo dedicado a tus artefactos y credenciales. Consulta
[Lanzamientos](release.md) para entender firma y empaquetado. Publicar releases o activar esa
automatización es un paso separado de mantener y compilar localmente.
