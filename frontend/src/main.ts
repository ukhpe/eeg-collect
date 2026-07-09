import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import vuetify from "./plugins/vuetify";
import { loadFonts } from "./plugins/webfontloader";
import store from "@/store";
import { injectionKey } from "@/store/utils/storeHelpers";

loadFonts();

//createApp(App).use(router).use(vuetify).use(store, injectionKey).mount("#app");

const app = createApp(App);

// function to send the log to backend
const sendLogToBackend = (level: 'WARN' | 'ERROR', message: string, details: string = '') => {
  fetch("http://localhost:3000/api/frontend-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      level: level,
      message: message,
      details: details,
    })
  }).catch((err) => {
    originalConsoleError("Logging-interface to backend failed:", err);
  });
};

// overwrite console.error command
const originalConsoleError = console.error;

app.config.errorHandler = (err, instance, info) => {
  // still show the error in terminal of browser
  originalConsoleError("Central Vue-ErrorHandler caught an error:", err);

  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorStack = err instanceof Error ? err.stack : '';

  sendLogToBackend(
    'ERROR',
    `[Central Vue-Handler] ${errorMessage} | Info: ${info}`,
    errorStack
  );
};

// if there's an error in asynchronous ts-files
window.addEventListener("unhandledrejection", (event) => {
  originalConsoleError("Unhandled asynchronous Promise-rejection:", event.reason);
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
  const stack = event.reason instanceof Error ? event.reason.stack : '';

  sendLogToBackend('ERROR', `[Async Unhandled Rejection] ${msg}`, stack);
});

// overwrite console.warn command
const originalConsoleWarn = console.warn;

console.warn = (...args) => {
  originalConsoleWarn.apply(console, args);

  const warnMessage = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');

  // prevents infinite loops of warnings
  if (!warnMessage.includes("api/frontend-log")) {
    sendLogToBackend('WARN', `[Browser Console.warn] ${warnMessage}`);
  }
};

// activate app like before
app.use(router).use(vuetify).use(store, injectionKey).mount("#app");

