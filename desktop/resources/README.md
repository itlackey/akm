# Desktop icon

`icon.svg` uses the app's existing wordmark and neutral/purple colors.
`512x512.png` is the checked-in Linux runtime/packaging asset. Normal app builds
do not require an image renderer or fonts to regenerate it.

When changing the icon, render the SVG to a 512×512 transparent PNG using
DejaVu Sans Bold, inspect the result, and commit both files. The native window
and AppImage use the same PNG. Packaging declares a stable desktop name for
window association; it does not install a launcher on the host.
