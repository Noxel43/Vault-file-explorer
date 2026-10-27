import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useExplorer } from "./store/explorer";
import { useSettings } from "./store/settings";
import { useUi } from "./store/ui";

// Handy for poking at state from devtools during development.
if (import.meta.env.DEV) Object.assign(window, { __vault: { explorer: useExplorer, settings: useSettings, ui: useUi } });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
