# Third-party notices

`src/lib/ui/echarts.js` is the vendored Apache ECharts renderer (Apache 2.0 / BSD); its notices are embedded in the
file. The npm dependency graph retains each dependency's original license in `node_modules`.

## fhold menu integration

`electron/menu-install.mjs` and its unit tests adapt the per-user AppImage menu
installation pattern from `fwdslsh/fhold`, `packages/electron/src/admin-desktop.ts`
and its tests, reviewed at `907ceb9427c1d1b5414870abf8d1b5132bc5facf`.
It uses Desktop's existing authenticated server/main-process bridge, not fhold's
instance management or IPC framework. The original MIT notice follows:

MIT License

Copyright (c) 2026 fwdslsh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
