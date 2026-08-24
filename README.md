# Anhad

Aplicación web instalable y privada para temporizar y registrar la práctica de Luz, Sonido, Canto de Bhajanes y Satsang.

## Aplicación publicada

[Abrir Anhad en GitHub Pages](https://camilo31-svg.github.io/anhad-meditacion/)

## Uso local

La aplicación no necesita dependencias externas. Requiere Node.js 22 o posterior.

- `npm run dev`: inicia la aplicación local.
- `npm run build`: genera el paquete compatible con Cloudflare Workers.
- `npm test`: comprueba cálculos de tiempo, calendario y estadísticas.

Los datos personales se guardan únicamente en el almacenamiento local del navegador. Se pueden exportar desde Ajustes.

Cada cambio enviado a la rama `main` se valida, compila y publica automáticamente mediante GitHub Actions.

