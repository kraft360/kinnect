import { cloudflare } from "@cloudflare/vite-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	publicDir: "src/web/public",
	plugins: [cloudflare(), svelte()],
});
