import { createApp } from "vue";
import "remixicon/fonts/remixicon.css";
import "../style.css";
import "./style.css";
import { installMobileBridge } from "./bridge";

await installMobileBridge();
const { default: App } = await import("../App.vue");
createApp(App).mount("#app");
