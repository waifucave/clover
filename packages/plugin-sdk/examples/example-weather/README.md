# Weather, an example plugin that reaches outside

The twin of `../example-notes`: what a plugin gains, and gives up, once it reaches the network and your attention.

| Part | Where | What it shows |
|---|---|---|
| Its own network host | `capabilities: network:api.example.com` | its programs reach that host only, through the proxy Clover hands them; put your weather service's host there, and its address in `WEATHER_URL` |
| A secret setting | `WEATHER_KEY` | entered in the app's own key dialog (Plugins page, Weather, Enter key…), kept in your credential store, handed to the forecast server as a file only it can read (`${secretFile:WEATHER_KEY}`) |
| An MCP server on stdio | `stdio/forecast.mjs` | plain JavaScript, no dependency, fenced to its own data folder |
| `readOnly` and `contained`, on purpose | `forecast`, `save_place` | they still ask before running: a plugin that can reach the network could send whatever a call hands it, so no tool of its skips the card. The OK card says so. |
| Notifications | `/rain-alert <place>` in `server/index.ts` | `notify.send`, behind the `notify` capability; refused while a card waits, past 3 a minute, and while you've muted the plugin on the Plugins page |

Check it with `clover plugin validate`, and install it from the Plugins page (Add, Choose a folder…).
