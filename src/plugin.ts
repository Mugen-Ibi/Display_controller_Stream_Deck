import streamDeck from "@elgato/streamdeck";
import { fileURLToPath } from "node:url";
import { NativeClient } from "./native-client.js";
import { BrightnessAction } from "./brightness-action.js";

const backend = new NativeClient(fileURLToPath(new URL("./display-ddc.exe", import.meta.url)));
// Raw property-inspector WebSocket messages use the legacy settings protocol.
streamDeck.settings.useLegacySettingsBehavior = true;
streamDeck.actions.registerAction(new BrightnessAction(backend));
process.on("exit", () => backend.dispose());
process.on("SIGTERM", () => { backend.dispose(); process.exit(0); });
process.on("SIGINT", () => { backend.dispose(); process.exit(0); });
streamDeck.connect().catch((error: unknown) => { streamDeck.logger.error(error); backend.dispose(); process.exit(1); });
