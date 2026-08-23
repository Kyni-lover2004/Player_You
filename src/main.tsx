import React from "react";
import ReactDOM from "react-dom/client";
// Шрифты вшиты в сборку, а не тянутся из сети: плеер должен работать без интернета.
import "@fontsource/unbounded/500.css";
import "@fontsource/unbounded/600.css";
import "@fontsource/onest/400.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/600.css";

import App from "./App";
import { DEFAULT_THEME, applyTheme, themeById } from "./theme/themes";

// До первой отрисовки: иначе окно моргнёт цветами темы по умолчанию.
applyTheme(themeById(localStorage.getItem("omen.theme") ?? DEFAULT_THEME));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
