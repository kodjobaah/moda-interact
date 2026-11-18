// React Router strips `.client` modules from the server bundle; the pure
// activation-status logic lives in the shared module so both the merchant UI
// and server loaders can use it.
export * from "./theme-activation-status";
