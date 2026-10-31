// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Only the components used by the local UI. Bundled by build-ui-charts.ts.
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent } from "echarts/components";
import { init, use } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

use([BarChart, LineChart, ScatterChart, GridComponent, AriaComponent, SVGRenderer]);

export { init };
